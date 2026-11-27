/**
 * AC7: a claude-acp wrapper start/end over a record a hook already created writes into that
 * record and never creates a second one. Isolated: temp HOME / CODEMIE_HOME / cwd / CLAUDE_CONFIG_DIR,
 * provider 'litellm' so no session metrics are sent.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(),
    setAgentName: vi.fn(), setSessionId: vi.fn(), setProfileName: vi.fn(),
    runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

const SESSION_ID = '00000000-0000-4000-8000-0000000000e5';
const KEYS = ['HOME', 'CODEMIE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEMIE_SESSION_ID', 'CODEMIE_PROVIDER', 'CODEMIE_AGENT'] as const;

let root: string;
let originalCwd: string;
const saved: Record<string, string | undefined> = {};

const sessionFiles = () => readdirSync(join(root, 'codemie', 'sessions')).filter((n) => n.endsWith('.json'));

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-acp-reentry-')));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'work'));
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
  process.env.HOME = join(root, 'home');
  process.env.CODEMIE_HOME = join(root, 'codemie');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.CODEMIE_SESSION_ID = SESSION_ID;
  process.env.CODEMIE_PROVIDER = 'litellm';
  process.env.CODEMIE_AGENT = 'claude-acp';
  process.chdir(join(root, 'work'));
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('claude-acp lifecycle over a record a hook already created', () => {
  it('start and end reuse the live record: one record, same id, same startTime', async () => {
    const startTime = Date.now() - 60_000;
    writeFileSync(join(root, 'codemie', 'sessions', `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID, agentName: 'claude-acp', provider: 'litellm', startTime,
      workingDirectory: join(root, 'work'), status: 'active', activeDurationMs: 0,
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'native-hook' },
    }));
    const { ClaudeAcpPluginMetadata } = await import('../claude-acp.plugin.js');
    const env = { ...process.env } as NodeJS.ProcessEnv;

    await ClaudeAcpPluginMetadata.lifecycle!.onSessionStart!(SESSION_ID, env);

    expect(sessionFiles()).toEqual([`${SESSION_ID}.json`]);
    const { SessionStore } = await import('../../../core/session/SessionStore.js');
    const live = await new SessionStore().loadSession(SESSION_ID);
    expect(live).toMatchObject({ sessionId: SESSION_ID, status: 'active', startTime });

    await ClaudeAcpPluginMetadata.lifecycle!.onSessionEnd!(0, env);

    // The end writes into the same record (now completed), still exactly one record for the id
    expect(sessionFiles().filter((n) => n.includes(SESSION_ID))).toHaveLength(1);
    const ended = await new SessionStore().loadSession(SESSION_ID);
    expect(ended).toMatchObject({ sessionId: SESSION_ID, startTime });
    expect(ended?.endTime).toBeTypeOf('number');
  });
});
