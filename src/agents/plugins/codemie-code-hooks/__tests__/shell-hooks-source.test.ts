/**
 * Tests for SHELL_HOOKS_PLUGIN_SOURCE.
 *
 * The plugin ships as an embedded string that only ever runs inside the
 * OpenCode binary, so tsc cannot see it. These tests transpile it, load it, and
 * drive the handlers with the payload shapes OpenCode passes, capturing what
 * would be piped to `codemie hook`.
 *
 * This guards the contract the previous version got wrong on every axis: it
 * exported a plain object with nested hook keys, returned values instead of
 * mutating `output`, and read a session id from an environment variable nothing
 * sets — so every invocation shipped an empty session_id and was rejected.
 *
 * @group unit
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { SHELL_HOOKS_PLUGIN_SOURCE } from '../shell-hooks-source.js';

interface CapturedPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
}

type HookHandler = (input: unknown, output?: unknown) => Promise<void>;

const TRANSCRIPT = '/tmp/codemie-test/opencode.db';

let workDir: string;
let capturePath: string;
let modulePath: string;

/** Load the plugin factory the way the OpenCode runtime would. */
async function loadHooks(hookNames: string[]): Promise<Record<string, HookHandler>> {
  const hooks: Record<string, unknown[]> = {};
  for (const name of hookNames) {
    // A shell command that appends whatever arrives on stdin, standing in for
    // the real `codemie hook` binary.
    hooks[name] = [{ hooks: [{ type: 'command', command: `cat >> ${capturePath}` }] }];
  }

  process.env.OPENCODE_HOOKS = JSON.stringify({ hooks });
  process.env.CODEMIE_OPENCODE_TRANSCRIPT = TRANSCRIPT;
  delete process.env.OPENCODE_SESSION_ID;

  // Cache-bust so each test re-reads OPENCODE_HOOKS at module load.
  const imported = await import(`${modulePath}?v=${Math.random()}`);
  return (await imported.default({})) as Record<string, HookHandler>;
}

function captured(): CapturedPayload[] {
  if (!existsSync(capturePath)) return [];
  const raw = readFileSync(capturePath, 'utf-8');
  // Payloads are written back-to-back with no separator.
  return raw.split(/(?<=\})(?=\{)/).filter(Boolean).map(line => JSON.parse(line));
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'codemie-shell-hooks-'));
  modulePath = join(workDir, 'plugin.mjs');

  const transpiled = ts.transpileModule(SHELL_HOOKS_PLUGIN_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });

  // A syntax error here would ship a plugin OpenCode silently fails to load.
  expect(transpiled.diagnostics ?? []).toHaveLength(0);

  writeFileSync(modulePath, transpiled.outputText);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENCODE_HOOKS;
  delete process.env.CODEMIE_OPENCODE_TRANSCRIPT;
});

beforeEach(() => {
  capturePath = join(workDir, `capture-${Math.random().toString(36).slice(2)}.jsonl`);
});

describe('SHELL_HOOKS_PLUGIN_SOURCE', () => {
  it('hides the console window for asynchronous hook commands', () => {
    expect(SHELL_HOOKS_PLUGIN_SOURCE).toMatch(
      /spawn\("sh",\s*\["-c", command\],[\s\S]*?windowsHide:\s*true/,
    );
  });

  it('exports an async factory returning flat dotted-key handlers', async () => {
    const hooks = await loadHooks(['UserPromptSubmit']);

    expect(Object.keys(hooks).sort()).toEqual([
      'chat.message',
      'event',
      'experimental.session.compacting',
      'tool.execute.after',
      'tool.execute.before',
    ]);
    // The dead `permission.ask` handler is gone — OpenCode never triggers it.
    expect(hooks).not.toHaveProperty('permission.ask');
  });

  it('reads the prompt from output.parts and the session id from input.sessionID', async () => {
    const hooks = await loadHooks(['UserPromptSubmit']);

    await hooks['chat.message'](
      { sessionID: 'ses_abc' },
      { parts: [{ type: 'text', text: 'hello' }, { type: 'file' }, { type: 'text', text: 'world' }] }
    );

    const payloads = captured();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].hook_event_name).toBe('UserPromptSubmit');
    expect(payloads[0].session_id).toBe('ses_abc');
    expect(payloads[0].prompt).toBe('hello\nworld');
    // codemie hook refuses to re-parse a session without a transcript path.
    expect(payloads[0].transcript_path).toBe(TRANSCRIPT);
  });

  it('collapses session.idle and session.status{idle} into a single Stop', async () => {
    const hooks = await loadHooks(['Stop']);

    // OpenCode publishes the deprecated and current idle signals back to back.
    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    await hooks['event']({
      event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    expect(captured()).toHaveLength(1);
    expect(captured()[0].hook_event_name).toBe('Stop');
  });

  it('emits a Stop again after the session goes busy and idles once more', async () => {
    const hooks = await loadHooks(['Stop']);

    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });
    await hooks['event']({
      event: { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'busy' } } },
    });
    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });

    // One per busy→idle transition; active time would be under-counted otherwise.
    expect(captured()).toHaveLength(2);
  });

  it('tracks idle state per session', async () => {
    const hooks = await loadHooks(['Stop']);

    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_a' } } });
    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_b' } } });

    expect(captured()).toHaveLength(2);
  });

  it('never invokes a hook without a resolvable session id', async () => {
    const hooks = await loadHooks(['Stop', 'UserPromptSubmit']);

    await hooks['event']({ event: { type: 'session.idle', properties: {} } });
    await hooks['chat.message']({}, { parts: [{ type: 'text', text: 'orphan' }] });

    // An empty session_id makes `codemie hook` exit 2 without doing any work.
    expect(captured()).toHaveLength(0);
  });

  it('no longer maps session.created or session.deleted to lifecycle events', async () => {
    const hooks = await loadHooks(['SessionStart', 'SessionEnd']);

    await hooks['event']({ event: { type: 'session.created', properties: { sessionID: 'ses_3' } } });
    await hooks['event']({ event: { type: 'session.deleted', properties: { sessionID: 'ses_3' } } });

    // Both lifecycle events are raised in-process by the CLI instead.
    expect(captured()).toHaveLength(0);
  });

  it('passes tool args through output and merges hook-supplied updates', async () => {
    const hooks = await loadHooks(['PostToolUse']);

    await hooks['tool.execute.after'](
      { sessionID: 'ses_4', tool: 'read' },
      { output: 'file contents' }
    );

    const payloads = captured();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].tool_name).toBe('read');
    expect(payloads[0].tool_output).toBe('file contents');
  });

  it('sends PreToolUse args from output.args', async () => {
    const hooks = await loadHooks(['PreToolUse']);

    const output = { args: { filePath: 'src/a.ts' } };
    await hooks['tool.execute.before']({ sessionID: 'ses_5', tool: 'edit' }, output);

    const payloads = captured();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].tool_input).toEqual({ filePath: 'src/a.ts' });
  });

  it('does nothing when no hooks are configured for the event', async () => {
    const hooks = await loadHooks(['PreToolUse']);

    await hooks['event']({ event: { type: 'session.idle', properties: { sessionID: 'ses_6' } } });

    expect(captured()).toHaveLength(0);
  });
});
