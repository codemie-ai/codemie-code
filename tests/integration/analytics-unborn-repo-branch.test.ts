/**
 * Git branch of Claude Code analytics in a repository without commits — CLI contract tests (EPMCDME-16530)
 *
 * Repository analytics attribute a session's usage by its git branch. In a repository created with
 * `git init` and no commit yet (an unborn HEAD) the branch must still be the one HEAD names, the
 * same as once the repository has a commit, so the backend does not drop the session's tokens as
 * unmatched.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` and the real detached proxy
 * daemon in an isolated temp home, with the hooks fired from temp git repositories, against a local
 * mock backend. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-unborn-repo-branch.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  deliveredHookEvents,
  disposeCliHome,
  hookEnv,
  recordProxyConnection,
  runHook,
  startMockBackend,
  storeSsoLogin,
  waitFor,
  writeGlobalConfig,
  type HookEvent,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'branch-project';
// Fixed fake cookie (not a real credential).
const COOKIE = { _oauth2_proxy: 'branch-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const DELIVERY_TIMEOUT_MS = 45_000;
// Chains hook processes and waits twice on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS * 2 + 30_000;

describe.skipIf(!existsSync(DAEMON_DIST))('git branch of Claude Code analytics in a repository without commits', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /** `git` in `cwd`, confined to `home` so no user git config applies. */
  function git(home: string, cwd: string, args: string[]): void {
    // hookEnv drops inherited GIT_* variables: a pre-commit hook running this test exports its own repository and index.
    const env = {
      ...hookEnv(home),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const run = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf-8' });
    if (run.status !== 0) throw new Error(`setup: git ${args.join(' ')} failed\n${run.stderr}`);
  }

  function gitRepo(home: string, name: string, branch: string): string {
    const repo = join(home, 'repos', name);
    mkdirSync(repo, { recursive: true });
    git(home, repo, ['init', '-q', '-b', branch]);
    return repo;
  }

  /** A Claude Code session started and prompted in `repo`; returns its delivered events. */
  async function sessionIn(home: string, backend: MockBackend, repo: string, sessionId: string): Promise<HookEvent[]> {
    for (const event of [
      { hook_event_name: 'SessionStart', source: 'startup', cwd: repo },
      { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK.', cwd: repo },
    ]) {
      const run = await runHook(home, sessionId, event);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
    return waitFor(
      () => {
        const events = deliveredHookEvents(backend).filter((e) => e.session_id === sessionId);
        return events.some((e) => e.hook_event_name === 'UserPromptSubmit') ? events : undefined;
      },
      DELIVERY_TIMEOUT_MS,
      `session ${sessionId} to reach the backend`
    );
  }

  // The bug of EPMCDME-16530: in a repository without commits the branch was not detected, so the session's tokens matched no branch.
  it(
    'stamps the branch HEAD names on every event of a session in a repository without commits, as in one with a commit',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      const home = createCliHome(homes);
      writeGlobalConfig(home, PROFILE, {
        [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
      });
      recordProxyConnection(home, PROFILE);
      storeSsoLogin(home, backend.url, COOKIE);
      const unborn = gitRepo(home, 'unborn', 'feature/no-commits-yet');
      const committed = gitRepo(home, 'committed', 'feature/with-a-commit');
      git(home, committed, ['commit', '-q', '--allow-empty', '-m', 'initial']);

      const unbornEvents = await sessionIn(home, backend, unborn, 'agent-session-unborn-repo');
      const committedEvents = await sessionIn(home, backend, committed, 'agent-session-committed-repo');

      expect(unbornEvents.map((e) => e.hook_event_name)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
      for (const event of unbornEvents) expect(event.git_branch).toBe('feature/no-commits-yet');
      for (const event of committedEvents) expect(event.git_branch).toBe('feature/with-a-commit');
    },
    TEST_TIMEOUT_MS
  );
});
