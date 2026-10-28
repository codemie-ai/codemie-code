/**
 * Tests for SHELL_HOOKS_V2_PLUGIN_SOURCE.
 *
 * The v2 payload ships as an embedded string that only ever runs inside the
 * OpenCode 2.x binary, so tsc cannot see it. These tests transpile it, load it
 * behind a stubbed host-provided `@opencode/plugin` (the real one only exists
 * inside the OpenCode process, plugin/src/runtime-modules.ts), and drive the
 * registered v2 hooks with the payload shapes OpenCode passes, capturing what
 * would be piped to `codemie hook`.
 *
 * Focus (second-audit F5): async delivery. `fireCommands` always detaches in
 * the v2 payload — UserPromptSubmit (the "prompt" hook) and Stop (the bus
 * lifecycle events) are fire-and-forget — so the assertions poll for the
 * capture file instead of reading it immediately. The v1 suite only ever
 * exercised the synchronous `execSync` path.
 *
 * @group unit
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from '../shell-hooks-v2-source.js';

interface CapturedPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  prompt?: string;
}

type HookCallback = (event: unknown) => unknown;
type BusEvent = Record<string, unknown>;

interface PluginDefinition {
  id?: string;
  setup: (ctx: unknown) => Promise<() => void>;
}

const TRANSCRIPT = '/tmp/codemie-test/opencode.db';

let workDir: string;
let modulePath: string;
let capturePath: string;
let sinkPath: string;
const cleanups: Array<() => void> = [];

function toPosix(path: string): string {
  return path.split(String.fromCharCode(92)).join('/');
}

/**
 * Load the v2 payload the way the OpenCode runtime would: a fresh module
 * instance (config is read at module load), the host-provided
 * `@opencode/plugin` stubbed in the module's own node_modules.
 *
 * `busEvents` are pre-seeded: the payload consumes its event subscription
 * with `for await` during setup, so the replay happens inside the returned
 * promise's tail (async delivery still lands later — poll with captured()).
 */
async function loadV2Hooks(
  hookNames: string[],
  busEvents: BusEvent[] = [],
  portableSink = false
): Promise<Record<string, HookCallback>> {
  const hooks: Record<string, unknown[]> = {};
  for (const name of hookNames) {
    // A shell command that appends whatever arrives on stdin, standing in for
    // the real `codemie hook` binary. fireCommands always detaches in v2, so
    // no `async` flag is needed to reach execCommandAsync.
    // portableSink: a node script instead of `cat`, so the test also runs under
    // the Windows platform shell (cmd.exe has no `cat`). Forward slashes keep the
    // paths intact through both cmd.exe and sh -c.
    const command = portableSink
      ? `"${toPosix(process.execPath)}" "${toPosix(sinkPath)}" "${toPosix(capturePath)}"`
      : `cat >> ${capturePath}`;
    hooks[name] = [{ hooks: [{ type: 'command', command }] }];
  }

  process.env.OPENCODE_HOOKS = JSON.stringify({ hooks });
  process.env.CODEMIE_OPENCODE_TRANSCRIPT = TRANSCRIPT;
  delete process.env.OPENCODE_SESSION_ID;

  // Cache-bust so each test re-reads OPENCODE_HOOKS at module load.
  const imported = await import(`${modulePath}?v=${Math.random()}`);
  const definition = imported.default as PluginDefinition;

  const registered: Record<string, HookCallback> = {};
  const ctx = {
    session: {
      hook: async (name: string, callback: HookCallback) => {
        registered[`session:${name}`] = callback;
      },
    },
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        registered[`tool:${name}`] = callback;
      },
    },
    event: {
      subscribe: async function* (_options: { signal: AbortSignal }): AsyncGenerator<BusEvent> {
        for (const busEvent of busEvents) yield busEvent;
      },
    },
  };

  const cleanup = await definition.setup(ctx);
  cleanups.push(cleanup);
  return registered;
}

function captured(): CapturedPayload[] {
  if (!existsSync(capturePath)) return [];
  const raw = readFileSync(capturePath, 'utf-8');
  // Payloads are written back-to-back with no separator.
  return raw.split(/(?<=\})(?=\{)/).filter(Boolean).map(line => JSON.parse(line));
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'codemie-shell-hooks-v2-'));
  modulePath = join(workDir, 'index.mjs');

  // The real `@opencode/plugin` is host-provided inside the OpenCode binary;
  // a minimal stub stands in for it where the module resolves it.
  const stubDir = join(workDir, 'node_modules', '@opencode', 'plugin');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({
      name: '@opencode/plugin',
      version: '0.0.0',
      type: 'module',
      exports: './index.mjs',
    })
  );
  writeFileSync(
    join(stubDir, 'index.mjs'),
    'export const Plugin = { define: (definition) => definition };\n'
  );

  const transpiled = ts.transpileModule(SHELL_HOOKS_V2_PLUGIN_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });

  // A syntax error here would ship a plugin OpenCode silently fails to load.
  expect(transpiled.diagnostics ?? []).toHaveLength(0);

  writeFileSync(modulePath, transpiled.outputText);

  // Appends whatever arrives on stdin to the file in argv[2].
  sinkPath = join(workDir, 'sink.cjs');
  writeFileSync(
    sinkPath,
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').appendFileSync(process.argv[2],d));"
  );
});

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENCODE_HOOKS;
  delete process.env.CODEMIE_OPENCODE_TRANSCRIPT;
});

beforeEach(() => {
  capturePath = join(workDir, `capture-${Math.random().toString(36).slice(2)}.jsonl`);
});

// `cat >> file` stands in for the hook binary; cmd.exe has no `cat`, so delivery
// through the Windows platform shell cannot be asserted with it.
const itPosixShell = process.platform === 'win32' ? it.skip : it;

describe('SHELL_HOOKS_V2_PLUGIN_SOURCE', () => {
  it('registers the v2 hook surface and returns a cleanup', async () => {
    const hooks = await loadV2Hooks([]);

    expect(Object.keys(hooks).sort()).toEqual([
      'session:compaction',
      'session:prompt',
      'tool:execute.after',
      'tool:execute.before',
    ]);
    // The cleanup aborts the bus subscription; cleanups run in afterAll.
    expect(cleanups.length).toBeGreaterThan(0);
  });

  itPosixShell('delivers fire-and-forget UserPromptSubmit through the platform shell', async () => {
    const hooks = await loadV2Hooks(['UserPromptSubmit']);

    await hooks['session:prompt']({ sessionID: 'ses_v2_1', prompt: { text: 'hello v2' } });

    // Detached spawn is fire-and-forget: the write lands only after the
    // handler has already returned.
    await vi.waitFor(() => {
      expect(captured()).toHaveLength(1);
    });
    expect(captured()[0].hook_event_name).toBe('UserPromptSubmit');
    expect(captured()[0].prompt).toBe('hello v2');
    expect(captured()[0].session_id).toBe('ses_v2_1');
    // codemie hook refuses to re-parse a session without a transcript path.
    expect(captured()[0].transcript_path).toBe(TRANSCRIPT);
  });

  itPosixShell('delivers fire-and-forget Stop on the durable execution lifecycle', async () => {
    await loadV2Hooks(['Stop'], [
      { type: 'session.execution.started', sessionID: 'ses_v2_2' },
      { type: 'session.execution.succeeded', sessionID: 'ses_v2_2' },
    ]);

    // The bus replay happens during setup; detached delivery lands after it.
    await vi.waitFor(() => {
      expect(captured()).toHaveLength(1);
    });
    expect(captured()[0].hook_event_name).toBe('Stop');
    expect(captured()[0].session_id).toBe('ses_v2_2');
  });

  describe('Notification on session failure (second-audit F3)', () => {
    // v2 core publishes errors as session.execution.failed with the envelope
    // { type, data: { sessionID, error: { message } } }; the legacy session.error
    // event is not published by 2.0.x.
    const failed = (sessionID: string, message = 'boom'): BusEvent => ({
      type: 'session.execution.failed',
      data: { sessionID, error: { message } },
    });

    it('fires Notification, with the error message, on session.execution.failed', async () => {
      await loadV2Hooks(['Notification'], [failed('ses_f3_1', 'model unavailable')], true);

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(1);
      });
      expect(captured()[0].hook_event_name).toBe('Notification');
      expect(captured()[0].session_id).toBe('ses_f3_1');
      expect(captured()[0].message).toBe('model unavailable');
    });

    it('fires both Stop and Notification for one failed execution', async () => {
      await loadV2Hooks(['Stop', 'Notification'], [failed('ses_f3_2')], true);

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(2);
      });
      expect(captured().map((payload) => payload.hook_event_name).sort()).toEqual(['Notification', 'Stop']);
    });

    it('does not fire Stop when only Notification is configured', async () => {
      await loadV2Hooks(['Notification'], [failed('ses_f3_3')], true);

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(1);
      });
      // Give a stray Stop the same chance to land before asserting its absence.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(captured().map((payload) => payload.hook_event_name)).toEqual(['Notification']);
    });

    it('does not fire Notification for a successful or interrupted execution', async () => {
      await loadV2Hooks(
        ['Stop', 'Notification'],
        [
          { type: 'session.execution.succeeded', data: { sessionID: 'ses_f3_4' } },
          { type: 'session.execution.started', data: { sessionID: 'ses_f3_4' } },
          { type: 'session.execution.interrupted', data: { sessionID: 'ses_f3_4', reason: 'user' } },
        ],
        true
      );

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(2);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(captured().map((payload) => payload.hook_event_name)).toEqual(['Stop', 'Stop']);
    });

    it('notifies on every failure but collapses repeated Stops', async () => {
      await loadV2Hooks(['Stop', 'Notification'], [failed('ses_f3_5', 'first'), failed('ses_f3_5', 'second')], true);

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(3);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const names = captured().map((payload) => payload.hook_event_name);
      expect(names.filter((name) => name === 'Stop')).toHaveLength(1);
      expect(names.filter((name) => name === 'Notification')).toHaveLength(2);
    });

    it('keeps the legacy session.error branch as a fallback', async () => {
      await loadV2Hooks(
        ['Notification'],
        [{ type: 'session.error', properties: { sessionID: 'ses_f3_6' } }],
        true
      );

      await vi.waitFor(() => {
        expect(captured()).toHaveLength(1);
      });
      expect(captured()[0].hook_event_name).toBe('Notification');
      expect(captured()[0].session_id).toBe('ses_f3_6');
    });
  });

  it('prefers a PATH sh on Windows and falls back to the platform shell', () => {
    // Second-audit F5: a hardcoded `sh` does not exist on a stock Windows, so the
    // detached spawn dropped telemetry silently there. On Windows a POSIX sh
    // found on PATH is still preferred (bash-syntax hook commands keep
    // working); otherwise the platform shell (%ComSpec%) is used.
    expect(SHELL_HOOKS_V2_PLUGIN_SOURCE).toContain('process.platform === "win32" && hasPosixShellOnPath()');
    expect(SHELL_HOOKS_V2_PLUGIN_SOURCE).toContain('spawn("sh", ["-c", command]');
    expect(SHELL_HOOKS_V2_PLUGIN_SOURCE).toContain('spawn(command, { ...options, shell: true })');
    // Live-verified on Windows: detached + shell:true leaves cmd.exe hung and the
    // hook never runs, so detaching is POSIX-only.
    expect(SHELL_HOOKS_V2_PLUGIN_SOURCE).toContain('detached: process.platform !== "win32"');
  });
});
