/**
 * Tests for SHELL_HOOKS_V2_PLUGIN_SOURCE.
 *
 * Like its v1 sibling, the plugin ships as an embedded string that only ever runs inside the
 * OpenCode binary, so tsc cannot see it. These tests transpile it, load it, and drive it through
 * a fake OpenCode v2 plugin context, capturing what would be piped to `codemie hook`.
 *
 * They guard the v2 contract — a `{ id, setup }` definition, one mutable event per hook, bus
 * events from `ctx.event.subscribe()` — on which OpenCode gives no feedback: a hook registered
 * under the wrong name, or reading the wrong event field, simply never fires.
 *
 * @group unit
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import ts from 'typescript';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from '../shell-hooks-v2-source.js';

type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'PreCompact' | 'Stop' | 'Notification';

interface HookMatcherEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

type HooksByEvent = Partial<Record<HookEventName, HookMatcherEntry[]>>;

/** How the recording command answers the plugin. */
interface HookReply {
  exitCode?: number;
  /** Written to the command's stdout as JSON. */
  stdout?: unknown;
  stderr?: string;
}

interface CapturedPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  prompt?: string;
}

type HookCallback = (event: Record<string, unknown>) => unknown;

interface PluginContext {
  tool: { hook(name: string, callback: HookCallback): Promise<void> };
  session: { hook(name: string, callback: HookCallback): Promise<void> };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> };
}

interface PluginDefinition {
  id: string;
  setup(ctx: PluginContext): Promise<() => void>;
}

interface RunningPlugin {
  /** Callbacks registered through `ctx.tool.hook`, by hook name. */
  tool: Record<string, HookCallback>;
  /** Callbacks registered through `ctx.session.hook`, by hook name. */
  session: Record<string, HookCallback>;
  /** The abort signals handed to `ctx.event.subscribe`. */
  subscriptions: AbortSignal[];
  /** Puts events on the bus and resolves once the plugin has handled them. */
  publish(...events: unknown[]): Promise<void>;
  cleanup(): void;
}

// Stands in for `codemie hook`: records the payload it receives on stdin, then answers as told.
// Arguments: capture file, exit code, base64url stdout, base64url stderr.
const RECORDING_HOOK_SCRIPT = `
const fs = require('fs');
const [capturePath, exitCode, stdout, stderr] = process.argv.slice(2);
const decode = (text) => Buffer.from(text, 'base64url').toString();
fs.appendFileSync(capturePath, fs.readFileSync(0, 'utf-8') + '\\n');
process.stdout.write(decode(stdout));
process.stderr.write(decode(stderr));
process.exitCode = Number(exitCode);
`;

const TRANSCRIPT = '/tmp/codemie-test/opencode.db';
const SESSION = 'ses_1';
const TURN_SUCCEEDED = 'session.execution.succeeded';

let pluginModuleSource: string;
let syntaxErrors: string[];

let workDir: string;
let pluginPath: string;
let hookScriptPath: string;
let capturePath: string;
let cleanups: Array<() => void>;

/** One matcher entry whose command records its payload and then answers with `reply`. */
function recordingHook(reply: HookReply = {}, matcher?: string): HookMatcherEntry[] {
  const encode = (text: string): string => Buffer.from(text).toString('base64url');
  const command = [
    process.execPath,
    hookScriptPath,
    capturePath,
    String(reply.exitCode ?? 0),
    encode(reply.stdout === undefined ? '' : JSON.stringify(reply.stdout)),
    encode(reply.stderr ?? ''),
  ]
    .map((arg) => JSON.stringify(arg))
    .join(' ');

  return [{ matcher, hooks: [{ type: 'command', command }] }];
}

/** Every payload a hook command has received so far, in order. */
function captured(): CapturedPayload[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedPayload);
}

const firedHooks = (): string[] => captured().map((payload) => payload.hook_event_name);

/**
 * A stand-in for the OpenCode event bus. The plugin asking for the next event means it is done
 * with every earlier one, which is what lets `publish` resolve without sleeping.
 */
function createBus(): Pick<RunningPlugin, 'publish'> & { events(signal: AbortSignal): AsyncGenerator<unknown> } {
  const pending: unknown[] = [];
  let closed = false;
  let wake = (): void => {};
  let reportDrained = (): void => {};

  async function* events(signal: AbortSignal): AsyncGenerator<unknown> {
    signal.addEventListener('abort', () => wake(), { once: true });
    try {
      while (!signal.aborted) {
        if (pending.length > 0) {
          yield pending.shift();
          continue;
        }
        reportDrained();
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      closed = true;
      reportDrained();
    }
  }

  async function publish(...published: unknown[]): Promise<void> {
    if (closed) throw new Error('The plugin no longer reads bus events');
    const drained = new Promise<void>((resolve) => {
      reportDrained = resolve;
    });
    pending.push(...published);
    wake();
    await drained;
  }

  return { events, publish };
}

/** Load the plugin the way OpenCode would. The hooks config is read once, at module load. */
async function loadDefinition(hooks: HooksByEvent): Promise<PluginDefinition> {
  vi.stubEnv('OPENCODE_HOOKS', JSON.stringify({ hooks }));
  vi.stubEnv('CODEMIE_OPENCODE_TRANSCRIPT', TRANSCRIPT);

  // Each test has its own copy of the module, so `config` and the idle state never leak.
  const imported = (await import(pathToFileURL(pluginPath).href)) as { default: PluginDefinition };
  return imported.default;
}

async function startPlugin(hooks: HooksByEvent): Promise<RunningPlugin> {
  const definition = await loadDefinition(hooks);
  const tool: Record<string, HookCallback> = {};
  const session: Record<string, HookCallback> = {};
  const subscriptions: AbortSignal[] = [];
  const bus = createBus();
  const registerIn = (registry: Record<string, HookCallback>) => async (name: string, callback: HookCallback) => {
    registry[name] = callback;
  };

  const cleanup = await definition.setup({
    tool: { hook: registerIn(tool) },
    session: { hook: registerIn(session) },
    event: {
      subscribe: ({ signal }) => {
        subscriptions.push(signal);
        return bus.events(signal);
      },
    },
  });
  cleanups.push(cleanup);

  return { tool, session, subscriptions, publish: bus.publish, cleanup };
}

const busEvent = (type: string, sessionID: string = SESSION): Record<string, unknown> => ({ type, data: { sessionID } });

beforeAll(() => {
  const transpiled = ts.transpileModule(SHELL_HOOKS_V2_PLUGIN_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });

  pluginModuleSource = transpiled.outputText;
  syntaxErrors = (transpiled.diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  );
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'codemie-shell-hooks-v2-'));
  pluginPath = join(workDir, 'index.mjs');
  hookScriptPath = join(workDir, 'recording-hook.cjs');
  capturePath = join(workDir, 'capture.jsonl');
  cleanups = [];

  writeFileSync(pluginPath, pluginModuleSource);
  writeFileSync(hookScriptPath, RECORDING_HOOK_SCRIPT);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllEnvs();
  rmSync(workDir, { recursive: true, force: true });
});

describe('SHELL_HOOKS_V2_PLUGIN_SOURCE', () => {
  describe('plugin definition', () => {
    it('should be syntactically valid, or OpenCode silently fails to load it', () => {
      expect(syntaxErrors).toEqual([]);
    });

    it('should export a v2 definition rather than a v1 plugin factory', async () => {
      const definition = await loadDefinition({ Stop: recordingHook() });

      expect(definition).toEqual({ id: 'codemie.shell-hooks', setup: expect.any(Function) });
    });

    it('should register the tool hooks on ctx.tool', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });

      expect(Object.keys(plugin.tool).sort()).toEqual(['execute.after', 'execute.before']);
    });

    it('should register the session hooks on ctx.session', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });

      expect(Object.keys(plugin.session).sort()).toEqual(['compaction', 'prompt']);
    });

    it('should stop reading the bus when OpenCode disposes the plugin', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });
      const abortedBeforeCleanup = plugin.subscriptions.map((signal) => signal.aborted);

      plugin.cleanup();

      expect(abortedBeforeCleanup).toEqual([false]);
      expect(plugin.subscriptions.map((signal) => signal.aborted)).toEqual([true]);
    });
  });

  describe('PreToolUse (execute.before)', () => {
    const toolCall = (tool = 'shell'): Record<string, unknown> => ({
      sessionID: SESSION,
      tool,
      input: { command: 'ls', timeout: 5 },
    });

    it('should send the tool name and input for the session', async () => {
      const plugin = await startPlugin({ PreToolUse: recordingHook() });

      await plugin.tool['execute.before'](toolCall());

      expect(captured()).toEqual([
        expect.objectContaining({
          hook_event_name: 'PreToolUse',
          session_id: SESSION,
          transcript_path: TRANSCRIPT,
          tool_name: 'shell',
          tool_input: { command: 'ls', timeout: 5 },
        }),
      ]);
    });

    it('should merge the input a command returns into the event input', async () => {
      const updatedInput = { command: 'ls -la', description: 'list files' };
      const plugin = await startPlugin({
        PreToolUse: recordingHook({ stdout: { hookSpecificOutput: { updatedInput } } }),
      });
      const event = toolCall();

      await plugin.tool['execute.before'](event);

      expect(event.input).toEqual({ command: 'ls -la', timeout: 5, description: 'list files' });
    });

    it('should fail the tool call with the hook reason when a command exits with code 2', async () => {
      const plugin = await startPlugin({
        PreToolUse: recordingHook({ exitCode: 2, stderr: 'Denied by policy' }),
      });

      const call = async (): Promise<unknown> => plugin.tool['execute.before'](toolCall());

      await expect(call()).rejects.toThrow('Denied by policy');
    });

    it('should let the tool call through when a command fails with another exit code', async () => {
      const plugin = await startPlugin({
        PreToolUse: recordingHook({ exitCode: 1, stderr: 'hook crashed' }),
      });

      const call = async (): Promise<unknown> => plugin.tool['execute.before'](toolCall());

      await expect(call()).resolves.toBeUndefined();
    });

    it('should run a command whose matcher names the tool', async () => {
      const plugin = await startPlugin({ PreToolUse: recordingHook({}, 'edit|write') });

      await plugin.tool['execute.before'](toolCall('edit'));

      expect(captured().map((payload) => payload.tool_name)).toEqual(['edit']);
    });

    it('should skip a command whose matcher names other tools', async () => {
      const plugin = await startPlugin({ PreToolUse: recordingHook({}, 'edit|write') });

      await plugin.tool['execute.before'](toolCall('shell'));

      expect(captured()).toEqual([]);
    });
  });

  describe('PostToolUse (execute.after)', () => {
    const toolResult = (outcome: Record<string, unknown>): Record<string, unknown> => ({
      sessionID: SESSION,
      tool: 'shell',
      ...outcome,
    });

    it.each([
      {
        output: 'the joined text items of a completed result',
        outcome: {
          status: 'completed',
          result: {
            content: [
              { type: 'text', text: 'line 1\n' },
              { type: 'image', text: 'alt text, not tool output' },
              { type: 'text', text: 'line 2' },
            ],
          },
        },
        expected: 'line 1\nline 2',
      },
      {
        output: 'the string content of a completed result as is',
        outcome: { status: 'completed', result: { content: 'plain output' } },
        expected: 'plain output',
      },
      {
        output: 'the serialized output of a completed result without content',
        outcome: { status: 'completed', result: { output: { exit: 0 } } },
        expected: '{"exit":0}',
      },
      {
        output: 'the error message of a failed tool call',
        outcome: { status: 'error', error: { message: 'command not found' }, result: { content: 'ignored' } },
        expected: 'command not found',
      },
      {
        output: 'an empty output for a failed tool call without an error message',
        outcome: { status: 'error' },
        expected: '',
      },
    ])('should send $output', async ({ outcome, expected }) => {
      const plugin = await startPlugin({ PostToolUse: recordingHook() });

      await plugin.tool['execute.after'](toolResult(outcome));

      expect(captured()).toEqual([
        expect.objectContaining({
          hook_event_name: 'PostToolUse',
          session_id: SESSION,
          tool_name: 'shell',
          tool_output: expected,
        }),
      ]);
    });

    it('should not fail the tool call when a command exits with code 2', async () => {
      const plugin = await startPlugin({ PostToolUse: recordingHook({ exitCode: 2, stderr: 'too late to block' }) });

      const call = async (): Promise<unknown> =>
        plugin.tool['execute.after'](toolResult({ status: 'completed', result: { content: 'done' } }));

      await expect(call()).resolves.toBeUndefined();
    });
  });

  describe('UserPromptSubmit (prompt)', () => {
    it('should send the prompt text for the session', async () => {
      const plugin = await startPlugin({ UserPromptSubmit: recordingHook() });

      await plugin.session.prompt({ sessionID: SESSION, prompt: { text: 'fix the build' } });

      expect(captured()).toEqual([
        expect.objectContaining({
          hook_event_name: 'UserPromptSubmit',
          session_id: SESSION,
          transcript_path: TRANSCRIPT,
          prompt: 'fix the build',
        }),
      ]);
    });

    it('should send an empty prompt when the event carries no text', async () => {
      const plugin = await startPlugin({ UserPromptSubmit: recordingHook() });

      await plugin.session.prompt({ sessionID: SESSION, prompt: { files: ['diagram.png'] } });

      expect(captured().map((payload) => payload.prompt)).toEqual(['']);
    });
  });

  describe('PreCompact (compaction)', () => {
    const KEEP_TODOS = 'Keep the open TODO list.';

    it('should add the context a command returns to the compaction system prompt', async () => {
      const plugin = await startPlugin({ PreCompact: recordingHook({ stdout: { additionalContext: KEEP_TODOS } }) });
      const basePrompt = { type: 'text', text: 'Summarize the session.' };
      const event = { sessionID: SESSION, system: [basePrompt] };

      await plugin.session.compaction(event);

      expect(event.system).toEqual([basePrompt, { type: 'text', text: KEEP_TODOS }]);
    });

    it('should run the command but leave an event without a system prompt list untouched', async () => {
      const plugin = await startPlugin({ PreCompact: recordingHook({ stdout: { additionalContext: KEEP_TODOS } }) });
      const event = { sessionID: SESSION, system: 'Summarize the session.' };

      await plugin.session.compaction(event);

      expect(firedHooks()).toEqual(['PreCompact']);
      expect(event).toEqual({ sessionID: SESSION, system: 'Summarize the session.' });
    });
  });

  describe('events without a session id', () => {
    it.each([
      { hookEvent: 'PreToolUse', domain: 'tool', hook: 'execute.before' },
      { hookEvent: 'PostToolUse', domain: 'tool', hook: 'execute.after' },
      { hookEvent: 'UserPromptSubmit', domain: 'session', hook: 'prompt' },
      { hookEvent: 'PreCompact', domain: 'session', hook: 'compaction' },
    ] as const)('should not run $hookEvent commands, which `codemie hook` would reject', async ({ hookEvent, domain, hook }) => {
      const plugin = await startPlugin({ [hookEvent]: recordingHook() });
      const callback = plugin[domain][hook];

      await callback({ tool: 'shell' });
      await callback({ tool: 'shell', sessionID: SESSION });

      // Only the call that names a session reaches the command.
      expect(captured().map((payload) => payload.session_id)).toEqual([SESSION]);
    });
  });

  describe('bus events', () => {
    it.each([TURN_SUCCEEDED, 'session.execution.interrupted', 'session.idle'])(
      'should fire Stop on %s',
      async (type) => {
        const plugin = await startPlugin({ Stop: recordingHook(), Notification: recordingHook() });

        await plugin.publish(busEvent(type));

        expect(captured()).toEqual([
          expect.objectContaining({ hook_event_name: 'Stop', session_id: SESSION, transcript_path: TRANSCRIPT }),
        ]);
      }
    );

    it('should fire Notification and Stop on session.execution.failed', async () => {
      const plugin = await startPlugin({ Stop: recordingHook(), Notification: recordingHook() });

      await plugin.publish(busEvent('session.execution.failed'));

      expect(firedHooks()).toEqual(['Notification', 'Stop']);
    });

    it('should fire Stop once when a turn end is reported twice', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });

      await plugin.publish(busEvent(TURN_SUCCEEDED), busEvent('session.idle'));

      expect(firedHooks()).toEqual(['Stop']);
    });

    it('should fire Stop again once a new prompt has made the session busy', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });

      await plugin.publish(busEvent(TURN_SUCCEEDED));
      await plugin.session.prompt({ sessionID: SESSION, prompt: { text: 'next step' } });
      await plugin.publish(busEvent(TURN_SUCCEEDED));

      // One per turn; active time would be under-counted otherwise.
      expect(firedHooks()).toEqual(['Stop', 'Stop']);
    });

    it('should track turn ends per session', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });

      await plugin.publish(busEvent(TURN_SUCCEEDED, 'ses_a'), busEvent(TURN_SUCCEEDED, 'ses_b'));

      expect(captured().map((payload) => payload.session_id)).toEqual(['ses_a', 'ses_b']);
    });

    it('should still notify about a failure whose Stop was already reported', async () => {
      const plugin = await startPlugin({ Stop: recordingHook(), Notification: recordingHook() });

      await plugin.publish(busEvent(TURN_SUCCEEDED), busEvent('session.execution.failed'));

      expect(firedHooks()).toEqual(['Stop', 'Notification']);
    });

    it.each([
      { ignored: 'a turn end without a session id', event: { type: TURN_SUCCEEDED, data: {} } },
      { ignored: 'an event that is not a turn end', event: busEvent('session.created') },
    ])('should ignore $ignored', async ({ event }) => {
      const plugin = await startPlugin({ Stop: recordingHook(), Notification: recordingHook() });

      await plugin.publish(event, busEvent(TURN_SUCCEEDED, 'ses_sentinel'));

      // The sentinel proves the plugin read past the ignored event.
      expect(captured().map((payload) => payload.session_id)).toEqual(['ses_sentinel']);
    });

    it('should keep reading the bus after an event it cannot handle', async () => {
      const plugin = await startPlugin({ Stop: recordingHook() });
      const unreadable = {
        type: TURN_SUCCEEDED,
        get data(): never {
          throw new Error('unreadable event');
        },
      };

      await plugin.publish(unreadable, busEvent(TURN_SUCCEEDED));

      expect(firedHooks()).toEqual(['Stop']);
    });
  });
});
