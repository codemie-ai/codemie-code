/**
 * Prompt auth gate after `codemie profile logout` — CLI contract tests (EPMCDME-17855)
 *
 * With Claude Code connected (`codemie proxy connect --claude-otlp`) and no valid login, every prompt must be blocked
 * and a browser sign-in started. After a logout there is no owner to make the session's evidence record from, and the
 * hook's transition gate stopped the prompt hook of a new session before the auth gate ran: the hook exited 0 with no
 * output, the prompt went to the model, no sign-in opened and nothing of the session was collected. A login whose
 * `codemie_access_token` has expired is cleared by its first lookup, so it behaves the same.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` in an isolated temp home against a local mock
 * backend. The sign-in in progress is a login lock held by an idle child process, so no browser opens; a completed
 * sign-in is the login stored the way `codemie profile login` saves it plus the lock stamped as succeeded. No network,
 * no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-auth-gate-after-logout.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  disposeCliHome,
  fileLog,
  recordProxyConnection,
  runHook,
  startMockBackend,
  storeSsoLogin,
  waitFor,
  waitForDeliveredSession,
  writeGlobalConfig,
  type CliRun,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'gate-project';
// Fixed fake cookies (not real credentials).
const COOKIE = { _oauth2_proxy: 'signed-in-session-cookie' };
const EXPIRED_ACCESS_TOKEN = { _oauth2_proxy: 'expired-session-cookie', codemie_access_token: 'expired-access-token' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const NO_CREDENTIALS = '(no valid CodeMie SSO credentials found)';
const HOOK_RUN_TIMEOUT_MS = 60_000;
const DELIVERY_TIMEOUT_MS = 45_000;
// A daemon started signed out checks for a login every 30 s or so before it swaps the real proxy in.
const DAEMON_LOGIN_TIMEOUT_MS = 60_000;
// A chain of hook processes outlives the `cli` project's 30s default; the sign-in case also waits for the daemon.
const TEST_TIMEOUT_MS = HOOK_RUN_TIMEOUT_MS + 30_000;
const SIGN_IN_TEST_TIMEOUT_MS = HOOK_RUN_TIMEOUT_MS + DAEMON_LOGIN_TIMEOUT_MS + DELIVERY_TIMEOUT_MS;

interface BlockDecision {
  decision: string;
  reason: string;
  hookSpecificOutput: { hookEventName: string; suppressOriginalPrompt: boolean };
}

/** How the user ended up without a valid login. */
const SIGNED_OUT: Record<string, ((home: string, url: string) => void) | null> = {
  // `codemie profile logout` removed the stored login.
  'after codemie profile logout': null,
  // A login with a `codemie_access_token` past its expiry: the first lookup deletes it (a local stack's login).
  'with an expired access-token login': (home, url) => storeSsoLogin(home, url, EXPIRED_ACCESS_TOKEN, Date.now() - 60_000),
};

describe.skipIf(!existsSync(DAEMON_DIST))('prompt auth gate of a new Claude Code session without a login', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  const signIns: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of signIns.splice(0)) child.kill('SIGKILL');
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /**
   * A home connected through `proxy connect --claude-otlp` with no valid login, whose prompt hook is installed with
   * `hookTimeoutSeconds`, and a browser sign-in in progress. `~/.claude/settings.json` and `sso-login.lock` (`LoginLock`
   * in src/providers/plugins/sso/sso.login-lock.ts) are written by hand in the product's formats; a change to them
   * fails these tests loudly (the gate stops blocking or waits).
   */
  async function signedOutHome(
    signOut: ((home: string, url: string) => void) | null,
    hookTimeoutSeconds: number
  ): Promise<{ home: string; backend: MockBackend; signIn: ChildProcess }> {
    const backend = await startMockBackend(OWNER);
    closers.push(backend.close);
    const home = createCliHome(homes);
    writeGlobalConfig(home, PROFILE, {
      [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
    });
    recordProxyConnection(home, PROFILE);
    signOut?.(home, backend.url);
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
    const signIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });
    signIns.push(signIn);
    writeLoginLock(home, backend.url, signIn);
    return { home, backend, signIn };
  }

  /** The health the proxy daemon reports in `proxy-daemon.json`: `unhealthy` while it holds the port without a login. */
  function daemonHealth(home: string): string | undefined {
    try {
      return (JSON.parse(readFileSync(join(home, 'proxy-daemon.json'), 'utf-8')) as { health?: string }).health;
    } catch {
      return undefined;
    }
  }

  function writeLoginLock(home: string, url: string, child: ChildProcess, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(home, 'sso-login.lock'), JSON.stringify({ pid: child.pid, startedAt: Date.now(), url, ...extra }), 'utf-8');
  }

  async function startSession(home: string, sessionId: string): Promise<void> {
    const start = await runHook(home, sessionId, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(start.code, `SessionStart: ${start.stderr}`).toBe(0);
    expect(start.stdout).toBe('');
  }

  async function submitPrompt(home: string, sessionId: string): Promise<{ run: CliRun; elapsedMs: number }> {
    const startedAt = Date.now();
    const run = await runHook(home, sessionId, { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK.' }, {
      timeoutMs: HOOK_RUN_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(run.code, `UserPromptSubmit: ${run.stderr}`).toBe(0);
    return { run, elapsedMs };
  }

  for (const [state, signOut] of Object.entries(SIGNED_OUT)) {
    // The bug of EPMCDME-17855: the hook exited 0 with no output, so the prompt went to the model.
    it(
      `${state}, blocks the prompt of a new session and points at the browser sign-in`,
      async () => {
        const sessionId = `agent-session-signed-out-${state.split(' ').pop()}`;
        // The 30 s timeout of older settings: the hook blocks at once instead of waiting for the sign-in.
        const { home } = await signedOutHome(signOut, 30);
        await startSession(home, sessionId);

        const { run, elapsedMs } = await submitPrompt(home, sessionId);

        expect(run.stdout, `the prompt hook's answer (empty: the prompt goes to the model)\n${fileLog(home).slice(-4000)}`).not.toBe('');
        const block = JSON.parse(run.stdout) as BlockDecision;
        expect(block.decision).toBe('block');
        expect(block.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true });
        expect(block.reason).toContain('A browser sign-in is already in progress.');
        expect(block.reason).toContain('re-send your prompt');
        expect(block.reason).toContain(NO_CREDENTIALS);
        // At once: the sign-in in progress is not waited for under a 30 s timeout. The margin covers slow runners.
        expect(elapsedMs).toBeLessThan(20_000);
      },
      TEST_TIMEOUT_MS
    );
  }

  it(
    'after codemie profile logout, lets the prompt through once the browser sign-in completes, and collects the session\'s next prompt',
    async () => {
      const sessionId = 'agent-session-signed-in-during-prompt';
      const { home, backend, signIn } = await signedOutHome(null, 180);
      await startSession(home, sessionId);
      // The user completes the browser sign-in a few seconds after sending the prompt.
      const signInLater = setTimeout(() => {
        storeSsoLogin(home, backend.url, COOKIE);
        writeLoginLock(home, backend.url, signIn, { succeededAt: Date.now() });
      }, 3_000);

      try {
        const { run, elapsedMs } = await submitPrompt(home, sessionId);

        // No block decision: the prompt continues without a re-send.
        expect(run.stdout, `the prompt hook's answer\nstderr: ${run.stderr}`).toBe('');
        expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
        expect(elapsedMs).toBeLessThan(20_000);
      } finally {
        clearTimeout(signInLater);
      }

      // The session that began signed out got its record: once the daemon, which started signed out, has the new login,
      // the session's next prompt is collected.
      await waitFor(
        () => (daemonHealth(home) === 'ok' ? true : undefined),
        DAEMON_LOGIN_TIMEOUT_MS,
        'the proxy daemon to pick up the new login'
      );
      const next = await runHook(home, sessionId, { hook_event_name: 'UserPromptSubmit', prompt: 'Second prompt.' });
      expect(next.code, `second UserPromptSubmit: ${next.stderr}`).toBe(0);
      expect(next.stdout).toBe('');
      const delivered = await waitForDeliveredSession(backend, DELIVERY_TIMEOUT_MS, 'the next prompt to be delivered').catch(
        (error: Error) => {
          const requests = backend.requests.map((r) => `${r.method} ${r.path}`).join('\n');
          throw new Error(`${error.message}\nbackend requests:\n${requests}\nCLI log:\n${fileLog(home).slice(-6000)}`);
        }
      );
      const prompts = delivered.filter((event) => event.hook_event_name === 'UserPromptSubmit');
      expect(prompts.map((event) => [event.session_id, event.prompt])).toContainEqual([sessionId, 'Second prompt.']);
    },
    SIGN_IN_TEST_TIMEOUT_MS
  );
});
