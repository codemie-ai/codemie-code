import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: vi.fn(async () => ({})) } }));
vi.mock('@/utils/processes.js', () => ({ detectGitBranch: vi.fn(async () => undefined) }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const root = mkdtempSync(join(tmpdir(), 'cop-otlp-attr-'));
process.env.CODEMIE_HOME = join(root, 'codemie');
process.env.COPILOT_HOME = join(root, 'copilot');

import { CopilotCliOtlpPlugin } from '../copilot-cli-otlp.plugin.js';
import { buildToolEvent } from '../copilot-cli-otlp.tool-payload.js';
import { recordOpenStarts } from '../copilot-cli-otlp.tool-correlation.js';
import { buildStopPass } from '../copilot-cli-otlp.stop-pass.js';
import { toolsStatePath } from '../copilot-cli-otlp.state.js';

const SID = '22222222-3333-4444-5555-666666666666';
type Internals = {
  resolveAgentFields(input: unknown): Promise<Record<string, unknown>>;
  buildEventId(event: Record<string, unknown>, payload: Record<string, unknown>, ts: string): string;
};
const plugin = new CopilotCliOtlpPlugin() as unknown as Internals;
const savedSession = process.env.CODEMIE_SESSION_ID;

afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  if (savedSession === undefined) delete process.env.CODEMIE_SESSION_ID;
  else process.env.CODEMIE_SESSION_ID = savedSession;
});

describe('resolveAgentFields', () => {
  beforeEach(() => {
    rmSync(join(root, 'codemie'), { recursive: true, force: true });
    rmSync(join(root, 'copilot'), { recursive: true, force: true });
  });

  it('labels a session managed when its id is the pinned one, or when the launch was not pinned', async () => {
    process.env.CODEMIE_SESSION_ID = SID;
    process.env.CODEMIE_COPILOT_NATIVE_SESSION_ID = SID;
    expect((await plugin.resolveAgentFields({ sessionId: SID, cwd: '/r' })).entrypoint).toBe('managed');
    expect((await plugin.resolveAgentFields({ sessionId: 'other-session', cwd: '/r' })).entrypoint).toBe('native');
    delete process.env.CODEMIE_COPILOT_NATIVE_SESSION_ID;
    expect((await plugin.resolveAgentFields({ sessionId: 'resumed-session', cwd: '/r' })).entrypoint).toBe('managed');
    delete process.env.CODEMIE_SESSION_ID;
    expect((await plugin.resolveAgentFields({ sessionId: SID, cwd: '/r' })).entrypoint).toBe('native');
  });

  it('reads client_version and the git fallback from the head of events.jsonl, then caches them', async () => {
    const dir = join(root, 'copilot', 'session-state', SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.yaml'), `id: ${SID}\nclient_name: github/cli\n`);
    const file = join(dir, 'events.jsonl');
    expect((await plugin.resolveAgentFields({ sessionId: SID, cwd: '/r' })).client_version).toBe('');

    writeFileSync(file, `${JSON.stringify({ type: 'session.start', data: { copilotVersion: '1.0.92', context: { repository: 'org/repo', branch: 'main' } } })}\n`);
    expect(await plugin.resolveAgentFields({ sessionId: SID, cwd: '/r' })).toMatchObject({
      platform: 'copilot-cli', client_version: '1.0.92', git_branch: 'main', repo_remote: 'org/repo',
    });

    rmSync(file);
    expect((await plugin.resolveAgentFields({ sessionId: SID, cwd: '/r' })).client_version).toBe('1.0.92');
  });
});

describe('batched tool events', () => {
  it('keep distinct event ids when they share a timestamp', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const base = { session_id: SID, timestamp: ts, type: 'agent.tool.start' };
    const a = buildToolEvent(base, 'bash', { c: 1 }, { toolUseId: 'call_1' });
    const b = buildToolEvent(base, 'bash', { c: 1 }, { toolUseId: 'call_2' });
    expect(plugin.buildEventId(a, a, ts)).not.toBe(plugin.buildEventId(b, b, ts));
  });
});

describe('hook-side state budget', () => {
  it('skips recording open starts when the state lock stays held', async () => {
    mkdirSync(join(root, 'codemie', 'otlp', 'copilot-cli'), { recursive: true });
    const path = toolsStatePath(SID);
    writeFileSync(`${path}.lock`, '');
    const started = Date.now();
    await recordOpenStarts(SID, [{ toolUseId: 'a', toolName: 'bash', toolArgs: {} }]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(path)).toBe(false);
    rmSync(`${path}.lock`);
  });
});

describe('agentStop pass above the transcript cap', () => {
  it('reads only the tail and flags the summary usage_partial', () => {
    const dir = join(root, 'copilot', 'session-state', SID);
    mkdirSync(dir, { recursive: true });
    rmSync(join(root, 'codemie'), { recursive: true, force: true });
    const filler = `${JSON.stringify({ type: 'user.message', data: { text: 'x'.repeat(1000) }, timestamp: '2026-01-01T00:00:00.000Z' })}\n`;
    const usage = `${JSON.stringify({ type: 'session.usage_record', data: { usage: { model: 'm', apiCallId: 'tail', inputTokens: 1 } }, timestamp: '2026-01-01T00:00:01.000Z' })}\n`;
    writeFileSync(join(dir, 'events.jsonl'), filler.repeat(9_000) + usage);

    const pass = buildStopPass(SID);
    expect(pass?.events.some((e) => e.request_id === 'tail')).toBe(true);
    expect(pass?.events.at(-1)).toMatchObject({ usage_partial: true });
  });
});
