/**
 * `codemie proxy analytics resend`: identity requirement, Claude-only guard and the summary of a release run.
 * The release itself is covered by otlp-spool/__tests__/work-consent-publication.test.ts.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';

const identityMock = vi.fn();
const releaseMock = vi.fn();
const readStateMock = vi.fn();
const aliveMock = vi.fn();

vi.mock('@/agents/core/evidence/hook-identity.js', () => ({ currentEvidenceIdentity: identityMock }));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/hold-release.js', () => ({ releaseHeldSessions: releaseMock }));
vi.mock('../daemon-manager.js', async (orig) => ({
  ...(await orig<typeof import('../daemon-manager.js')>()),
  readState: readStateMock,
  isDaemonAlive: aliveMock,
}));

const id = { api_identity: 'https://api.example.com', owner_hash: 'o'.repeat(64) };
const HELD = 'work_consent_required';

describe('proxy analytics resend', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    identityMock.mockReset().mockResolvedValue(id);
    releaseMock.mockReset().mockResolvedValue([]);
    readStateMock.mockReset().mockResolvedValue({ pid: 1, startedAt: '', port: 1 });
    aliveMock.mockReset().mockResolvedValue(true);
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = 0;
  });

  const run = async (args: string[] = []) => {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(['resend', ...args], { from: 'user' });
  };
  const said = (spy: ReturnType<typeof vi.spyOn>) => stripVTControlCharacters(spy.mock.calls.flat().join('\n'));

  it('releases the held sessions of the signed-in account and says the proxy sends them next', async () => {
    releaseMock.mockResolvedValue([
      { sessionId: 's1', reason: HELD, outcome: 'released' },
      { sessionId: 's2', reason: HELD, outcome: 'released' },
    ]);
    await run();
    expect(releaseMock).toHaveBeenCalledWith(id);
    expect(said(out)).toContain('Released 2 held sessions');
    expect(said(out)).not.toContain('codemie proxy start');
    expect(process.exitCode).toBe(0);
  });

  it('nothing held: says so', async () => {
    await run();
    expect(said(out)).toContain('Nothing to resend');
  });

  it('names each session it could not release with the reason, and the grant command when consent is missing', async () => {
    releaseMock.mockResolvedValue([
      { sessionId: 's1', reason: HELD, outcome: 'released' },
      { sessionId: 's2', reason: HELD, outcome: 'kept', detail: 'no_consent' },
      { sessionId: 's3', reason: HELD, outcome: 'busy' },
    ]);
    await run();
    const text = said(out);
    expect(text).toContain('Released 1 held session');
    expect(text).toContain('s2: no consent covers its project and folder');
    expect(text).toContain('s3: the proxy was sending it; run the command again');
    expect(text).toContain('codemie proxy analytics consent grant');
  });

  it('a stopped proxy: the release is kept and the start command is named', async () => {
    releaseMock.mockResolvedValue([{ sessionId: 's1', reason: HELD, outcome: 'released' }]);
    aliveMock.mockResolvedValue(false);
    await run();
    expect(said(out)).toContain('codemie proxy start');
  });

  it('signed out: exits 1 and releases nothing', async () => {
    identityMock.mockResolvedValue(null);
    await run();
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('codemie profile login');
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('a Copilot connector is refused', async () => {
    await run(['--copilot-otlp']);
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('only available for Claude Code');
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
