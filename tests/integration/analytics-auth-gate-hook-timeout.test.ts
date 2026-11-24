/**
 * Prompt auth gate within Claude Code's hook timeout — CLI contract tests (EPMCDME-15378)
 *
 * When the SSO session is rejected, the claude-code-otlp UserPromptSubmit hook blocks the prompt and
 * may wait for a browser sign-in. Claude Code kills a hook that outlives the timeout installed in
 * `~/.claude/settings.json` and then sends the prompt anyway, so the hook must answer before it:
 * it waits at most the installed timeout minus a headroom, not at all when that leaves too little,
 * and stops waiting as soon as the sign-in fails.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` in an isolated temp home against
 * a local mock backend. The sign-in in progress is a login lock held by an idle child process, so
 * no browser opens. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-auth-gate-hook-timeout.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  disposeCliHome,
  recordProxyConnection,
  runHook,
  startMockBackend,
  storeSsoLogin,
  writeGlobalConfig,
  type CliRun,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'gate-project';
const SESSION_ID = 'agent-session-auth-gate';
// Fixed fake cookie (not a real credential).
const COOKIE = { _oauth2_proxy: 'rejected-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const BLOCK_HEADER = 'Your CodeMie sign-in session has expired — this is expected and not a problem with your prompt.';
const REJECTED = '(CodeMie metrics endpoint rejected the stored credentials (HTTP 401))';
// The hook keeps this much of the installed timeout for itself (HOOK_TIMEOUT_HEADROOM_MS in the plugin).
const HEADROOM_MS = 15_000;
// The 50 s case waits up to 35 s; the runner kills the hook well after Claude Code would have.
const HOOK_RUN_TIMEOUT_MS = 90_000;
// Each test chains hook processes and one may wait 35 s, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = HOOK_RUN_TIMEOUT_MS + 30_000;

interface BlockDecision {
  decision: string;
  reason: string;
  hookSpecificOutput: { hookEventName: string; suppressOriginalPrompt: boolean };
}

describe.skipIf(!existsSync(DAEMON_DIST))('prompt auth gate within the installed hook timeout', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  const signIns: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of signIns.splice(0)) child.kill('SIGKILL');
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /**
   * A home whose session started while signed in, after which the backend rejected the cookies (the
   * metrics marker), with a browser sign-in in progress and the prompt hook installed with
   * `hookTimeoutSeconds`.
   */
  async function rejectedSessionHome(hookTimeoutSeconds: number): Promise<{ home: string; backend: MockBackend }> {
    const backend = await startMockBackend(OWNER);
    closers.push(backend.close);
    const home = createCliHome(homes);
    writeGlobalConfig(home, PROFILE, {
      [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
    });
    recordProxyConnection(home, PROFILE);
    storeSsoLogin(home, backend.url, COOKIE);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp', timeout: hookTimeoutSeconds }] },
          ],
        },
      }),
      'utf-8'
    );

    const start = await runHook(home, SESSION_ID, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(start.code).toBe(0);
    expect(start.stdout).toBe('');

    writeFileSync(
      join(home, 'analytics-auth-status.json'),
      JSON.stringify({ status: 'invalid', reason: 'HTTP 401', baseUrl: backend.url, detectedAt: Date.now() }),
      'utf-8'
    );
    writeLoginLock(home, backend.url, signInInProgress());
    return { home, backend };
  }

  /** An idle process standing in for the detached browser sign-in. */
  function signInInProgress(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });
    signIns.push(child);
    return child;
  }

  function writeLoginLock(home: string, url: string, child: ChildProcess, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(home, 'sso-login.lock'), JSON.stringify({ pid: child.pid, startedAt: Date.now(), url, ...extra }), 'utf-8');
  }

  async function submitPrompt(home: string): Promise<{ run: CliRun; elapsedMs: number; block: BlockDecision }> {
    const startedAt = Date.now();
    const run = await runHook(home, SESSION_ID, { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK.' }, {
      timeoutMs: HOOK_RUN_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(run.code).toBe(0);
    return { run, elapsedMs, block: JSON.parse(run.stdout) as BlockDecision };
  }

  function expectBlocked(block: BlockDecision): void {
    expect(block.decision).toBe('block');
    expect(block.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true });
    expect(block.reason).toContain(BLOCK_HEADER);
    expect(block.reason).toContain(REJECTED);
  }

  // The bug of EPMCDME-15378: the hook waited for the sign-in past Claude Code's 30 s timeout, was killed, and the prompt went through.
  it(
    'with the 30 s timeout of older settings, blocks at once instead of waiting for the sign-in',
    async () => {
      const { home } = await rejectedSessionHome(30);

      const { run, elapsedMs, block } = await submitPrompt(home);

      expectBlocked(block);
      expect(block.reason).toContain('A browser sign-in is already in progress.');
      expect(block.reason).toContain('re-send your prompt');
      expect(run.stderr).toBe('');
      expect(elapsedMs).toBeLessThan(10_000);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'with a 50 s timeout, waits for the sign-in and blocks before Claude Code would kill the hook',
    async () => {
      const { home } = await rejectedSessionHome(50);

      const { run, elapsedMs, block } = await submitPrompt(home);

      expectBlocked(block);
      expect(block.reason).toContain('The browser sign-in did not finish in time.');
      // The wait notice goes to stderr; stdout carries only the decision.
      expect(run.stderr).toContain(BLOCK_HEADER);
      expect(elapsedMs).toBeGreaterThanOrEqual(50_000 - HEADROOM_MS - 1_000);
      expect(elapsedMs).toBeLessThan(50_000 - 5_000);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops waiting and blocks as soon as the sign-in fails',
    async () => {
      const { home, backend } = await rejectedSessionHome(180);
      const signIn = signIns[signIns.length - 1];
      // The user closes the browser tab: the sign-in process records its failure after a few seconds.
      const failLater = setTimeout(
        () => writeLoginLock(home, backend.url, signIn, { failedAt: Date.now(), error: 'the browser window was closed' }),
        3_000
      );

      try {
        const { elapsedMs, block } = await submitPrompt(home);

        expectBlocked(block);
        expect(block.reason).toContain('The browser sign-in did not complete: the browser window was closed.');
        expect(block.reason).toContain('codemie profile login');
        expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
        expect(elapsedMs).toBeLessThan(15_000);
      } finally {
        clearTimeout(failLater);
      }
    },
    TEST_TIMEOUT_MS
  );
});
