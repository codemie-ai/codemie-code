import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliPlugin } from '../copilot-cli.plugin.js';
import { copilotRouteProof } from '../../copilot-cli-otlp/copilot-cli-otlp.evidence.js';
import { LAUNCH_PROVIDER_BASE_URL_ENV, PINNED_NATIVE_SESSION_ENV } from '../copilot-cli.constants.js';

// The real Copilot lifecycle (beforeRun + enrichArgs) through BaseAgentAdapter.run(); only the child, the proxy and
// unrelated side effects are replaced, so the assertions read the exact argv/env the child process is spawned with.
vi.mock('../../../core/session/stale-session-reconciliation.js', () => ({
  EXIT_DEADLINE_ENV: 'CODEMIE_EXIT_DEADLINE_MS',
  reconcileOtherSessions: vi.fn(() => ({ done: Promise.resolve(), abandon: async () => {} })),
  finalizeOwnRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../core/session/exit-notice.js', () => ({ noticeDeliveryAtExit: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../../cli/commands/skills/setup/sync.js', () => ({ syncRegisteredSkills: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../../utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/processes.js')>()),
  detectGitBranch: vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  getCommandPath: vi.fn(() => Promise.resolve(null)),
  exec: vi.fn(() => Promise.resolve({ code: 0, stdout: '1.0.114', stderr: '' })), // the `--version` probe
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(),
}));

const SID = '11111111-2222-4333-8444-555555555555';
const PROXY = 'http://127.0.0.1:41999/';
const GATEWAY = 'https://gateway.example.test/code-assistant-api';

class NoProxyCopilot extends CopilotCliPlugin {
  protected override async setupProxy(): Promise<void> {}
}

describe('Copilot child spawn boundary', () => {
  let home: string;
  const envBefore = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux'); // the direct (non-shell) spawn path
    home = mkdtempSync(join(tmpdir(), 'copilot-spawn-'));
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: null; kill: () => boolean };
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, kill: () => true });
    vi.mocked(spawn).mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as never;
    });
    Object.assign(process.env, {
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: PROXY,
      CODEMIE_TARGET_API_URL: GATEWAY,
      CODEMIE_MODEL: 'gpt-5.5',
      CODEMIE_SESSION_ID: SID,
      CODEMIE_PROFILE_NAME: 'p1',
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ name: 'p1', provider: 'ai-run-sso', baseUrl: GATEWAY }),
      COPILOT_HOME: home,
    });
    delete process.env[PINNED_NATIVE_SESSION_ENV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  });

  async function launch(args: string[]): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
    await new NoProxyCopilot().run(args, {});
    // The launch is the spawn of the agent binary itself (a `which` probe precedes it).
    const call = vi.mocked(spawn).mock.calls.find((c) => c[0] === 'copilot');
    const [, argv, options] = call as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    return { argv, env: options.env };
  }

  it('hands the child the native session pin together with --session-id, and the launch endpoint copy', async () => {
    const { argv, env } = await launch(['-p', 'hi']);
    expect(argv).toContain('--session-id');
    const sessionId = env['CODEMIE_SESSION_ID']; // run() mints the launch's own id
    expect(sessionId).toBeTruthy();
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(sessionId);
    expect(env[PINNED_NATIVE_SESSION_ENV]).toBe(sessionId);
    expect(env[LAUNCH_PROVIDER_BASE_URL_ENV]).toBe(PROXY);
    // What the hook then sees when Copilot strips COPILOT_PROVIDER_BASE_URL: the launch's own copy still proves the route.
    const hookEnv = { ...env };
    delete hookEnv['COPILOT_PROVIDER_BASE_URL'];
    expect(copilotRouteProof(true, hookEnv)?.funding_route).toBe('api_based');
  });

  it.each([['--resume', SID], ['--continue'], ['--session-id', SID]])('a user-selected session (%s) is not pinned', async (...args) => {
    process.env[PINNED_NATIVE_SESSION_ENV] = 'stale-pin-from-the-parent-shell';
    const { argv, env } = await launch([...args, '-p', 'hi']);
    expect(argv.filter((a) => a === '--session-id')).toHaveLength(args[0] === '--session-id' ? 1 : 0);
    expect(env[PINNED_NATIVE_SESSION_ENV]).toBeUndefined();
  });

  it('rejects a mismatched endpoint or a missing launch copy', async () => {
    const { env } = await launch(['-p', 'hi']);
    expect(copilotRouteProof(true, { ...env, COPILOT_PROVIDER_BASE_URL: 'https://byok.example.org/v1' })).toBeUndefined();
    const stripped = { ...env };
    delete stripped['COPILOT_PROVIDER_BASE_URL'];
    expect(copilotRouteProof(true, { ...stripped, [LAUNCH_PROVIDER_BASE_URL_ENV]: 'https://byok.example.org/v1' })).toBeUndefined();
    delete stripped[LAUNCH_PROVIDER_BASE_URL_ENV];
    expect(copilotRouteProof(true, stripped)).toBeUndefined();
    expect(copilotRouteProof(false, env)).toBeUndefined();
  });
});
