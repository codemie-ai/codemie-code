import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identityMock = vi.fn();
const gateMock = vi.fn();
const projectMock = vi.fn();
const prefsMock = vi.fn();

vi.mock('@/agents/core/evidence/hook-identity.js', () => ({ currentEvidenceIdentity: identityMock }));
vi.mock('../claude-code-otlp.gate.js', () => ({ evaluateClaudeAnalyticsGate: gateMock }));
vi.mock('@/agents/core/event-fields/identity-fields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectAtCwd: projectMock,
}));
vi.mock('../claude-code-otlp.preferences.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readClaudeAnalyticsPreferences: prefsMock,
}));

const api = 'https://api.example.com';
const owner = 'o'.repeat(64);
let home: string;
let prev: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

const hook = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: join(tmpdir(), 'work'), transcript_path: 'x', prompt: 'hi', ...over,
});
const fields = (over: Record<string, unknown> = {}) => ({
  session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven', project: 'proj', project_source: 'none',
  api_identity: api, owner_hash: owner, funding_route: 'subscription', collection_generation: 0, ...over,
});

async function setup() {
  const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
  const rs = await import('@/agents/core/evidence/record-store.js');
  const sm = await import('@/agents/core/evidence/stop-marker.js');
  const plugin = new ClaudeCodeOtlpPlugin();
  const gate = (i: object) => (plugin as unknown as { transitionGate(i: object): Promise<string> }).transitionGate(i);
  const untracked = (i: object) => (plugin as unknown as { onUntrackedHook(i: object): Promise<void> }).onUntrackedHook(i);
  const key = (s = 's1') => rs.recordKey(api, owner, s);
  const record = (over: Record<string, unknown> = {}) => rs.createOrRead(key(), fields(over) as never);
  return { plugin, rs, sm, gate, untracked, key, record };
}

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'trans-'));
  prev = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
  identityMock.mockResolvedValue({ api_identity: api, owner_hash: owner });
  gateMock.mockResolvedValue({ tracked: true, reason: 'tracked' });
  projectMock.mockResolvedValue('proj');
  prefsMock.mockResolvedValue({ kind: 'ok', value: { collectionGeneration: 0 } });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  // The plugin's logger (fresh per vi.resetModules) opens its log file under CODEMIE_HOME/logs; release it before rmSync (Windows ENOTEMPTY).
  await (await import('@/utils/logger.js')).logger.close();
  vi.restoreAllMocks();
  if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const evidenceFiles = () => { try { return readdirSync(join(home, 'analytics', 'state', 'evidence')); } catch { return []; } };

describe('hook-side transitions', () => {
  it('a disabled hook writes no session state at all', async () => {
    const t = await setup();
    gateMock.mockResolvedValue({ tracked: false, reason: 'disabled' });
    await t.record();
    const before = evidenceFiles();
    await t.untracked(hook());
    expect(evidenceFiles()).toEqual(before);
    expect(identityMock).not.toHaveBeenCalled();
  });

  it('an excluded session never seen before stays untracked (no marker, no record)', async () => {
    const t = await setup();
    gateMock.mockResolvedValue({ tracked: false, reason: 'project-excluded' });
    await t.untracked(hook());
    expect(evidenceFiles()).toEqual([]);
  });

  it('an excluded already-known session gets only the privacy-stop marker, so returning cannot backfill', async () => {
    const t = await setup();
    await t.record();
    gateMock.mockResolvedValue({ tracked: false, reason: 'project-excluded' });
    await t.untracked(hook());
    expect(await t.sm.isStopped(t.key())).toBe(true);
    expect(evidenceFiles().filter((f) => f.endsWith('.stop.json'))).toHaveLength(1);
    gateMock.mockResolvedValue({ tracked: true, reason: 'tracked' });
    expect(await t.gate(hook())).toBe('stop');
  });

  it('resume / any later hook with no record stops with a marker; startup and /clear start fresh', async () => {
    const t = await setup();
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'startup' }))).toBe('continue');
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'clear' }))).toBe('continue');
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'resume' }))).toBe('stop');
    expect(await t.sm.isStopped(t.key())).toBe(true);
    // repeated startup does not clear an existing stop
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'startup' }))).toBe('stop');
    expect(await t.gate(hook())).toBe('stop');
  });

  it('a resume with an identical recorded scope continues; a folder change, generation change or revoked consent stops', async () => {
    const t = await setup();
    await t.record();
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'resume' }))).toBe('continue');
    projectMock.mockResolvedValue('other');
    expect(await t.gate(hook())).toBe('stop');

    projectMock.mockResolvedValue('proj');
    await t.rs.createOrRead(t.key('s2'), fields({ session_id: 's2', collection_generation: 0 }) as never);
    prefsMock.mockResolvedValue({ kind: 'ok', value: { collectionGeneration: 1 } }); // disabled then re-enabled
    expect(await t.gate(hook({ session_id: 's2' }))).toBe('stop');

    prefsMock.mockResolvedValue({ kind: 'ok', value: { collectionGeneration: 0 } });
    await t.rs.createOrRead(t.key('s3'), fields({ session_id: 's3', consent_ref: 'abcdef0123456789' }) as never);
    expect(await t.gate(hook({ session_id: 's3' }))).toBe('stop'); // no consent entry holds
  });

  it('the project comparison is canonical (trim, case-insensitive), so a casing-only difference is not a folder change', async () => {
    const t = await setup();
    await t.record({ project: 'Proj' });
    projectMock.mockResolvedValue('  proj ');
    expect(await t.gate(hook())).toBe('continue');
    projectMock.mockResolvedValue('proj-other');
    expect(await t.gate(hook())).toBe('stop');
  });

  it('checks the current folder using the stamped profile instead of the globally active one', async () => {
    const t = await setup();
    await t.record({ profile: 'original' });
    expect(await t.gate(hook())).toBe('continue');
    expect(projectMock).toHaveBeenCalledWith(hook().cwd, 'original');
    projectMock.mockResolvedValue('other-project');
    expect(await t.gate(hook({ cwd: join(tmpdir(), 'other-repo') }))).toBe('stop');
  });

  it('a session recorded without a frozen generation cannot prove continuity: stopped with a one-shot notice, never upgraded', async () => {
    const t = await setup();
    await t.record({ funding_route: undefined, collection_generation: undefined });
    expect(await t.gate(hook())).toBe('stop'); // even in the recorded folder
    expect(await t.sm.isStopped(t.key())).toBe(true);
    const marker = JSON.parse(readFileSync(join(t.rs.evidenceDir(), t.sm.stopFileName(t.key())), 'utf8')) as { reason: string; stop: boolean };
    expect(marker).toMatchObject({ reason: 'scope_unproven', stop: true });
    const found = await t.rs.readRecord(t.key());
    expect(found?.kind === 'existing' && found.record.funding_route === undefined && found.record.collection_generation === undefined).toBe(true);
  });

  it('a record with a frozen generation and no funding claim is judged on its scope, not rejected for the absent claim', async () => {
    const t = await setup();
    await t.record({ funding_route: undefined, negotiate_publication: undefined });
    expect(await t.gate(hook())).toBe('continue');
    projectMock.mockResolvedValue('other');
    expect(await t.gate(hook())).toBe('stop');
  });

  it('a stop is surfaced once as a user systemMessage, no project or path text; Claude is not blocked', async () => {
    const t = await setup();
    const deps = { ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn() };
    const raw = JSON.stringify(hook({ hook_event_name: 'SessionStart', source: 'resume' }));
    await t.plugin.processOtlpEvent(raw, deps as never);
    await t.plugin.processOtlpEvent(raw, deps as never);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as { systemMessage: string; decision?: string };
    expect(out.systemMessage).toMatch(/paused for this session/);
    expect(out.systemMessage).not.toContain('proj');
    expect(out.systemMessage).not.toContain(tmpdir());
    expect(out.systemMessage).not.toContain(home);
    expect(out.decision).toBeUndefined();
    expect(deps.ensureOtlpProxy).not.toHaveBeenCalled();
    expect(deps.forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('a daemon-written first-hold notice is shown exactly once and the hook still continues', async () => {
    const t = await setup();
    await t.record();
    await t.sm.writeNotice(t.key(), 'hold_contract_unavailable', 's1');
    expect(await t.gate(hook())).toBe('continue');
    expect((t.plugin as unknown as { pendingNotice?: string }).pendingNotice).toMatch(/not ready/);
    (t.plugin as unknown as { pendingNotice?: string }).pendingNotice = undefined;
    expect(await t.gate(hook())).toBe('continue');
    expect((t.plugin as unknown as { pendingNotice?: string }).pendingNotice).toBeUndefined();
  });

  describe('identity outage (no owner to key a record by)', () => {
    const recordGate = (t: Awaited<ReturnType<typeof setup>>, rec: object) =>
      (t.plugin as unknown as { recordGate(c: object, r: object): Promise<string> }).recordGate({ cwd: hook().cwd }, rec);

    it('only a fresh session, a held session or one with a record goes on; an unknown mid-session scope is not parked', async () => {
      const t = await setup();
      identityMock.mockResolvedValue(null);
      expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'startup' }))).toBe('continue');
      expect(await t.gate(hook({ session_id: 'unknown' }))).toBe('stop');
      await t.record();
      expect(await t.gate(hook())).toBe('continue'); // has a record: parked, re-checked at replay or stamp
    });

    it('the record the stamp later returns is re-checked: a folder move during the outage stops with a marker', async () => {
      const t = await setup();
      const created = await t.record();
      identityMock.mockResolvedValue(null);
      await t.gate(hook());
      projectMock.mockResolvedValue('other');
      expect(await recordGate(t, (created as { record: object }).record)).toBe('stop');
      expect(await t.sm.isStopped(t.key())).toBe(true);
    });

    it('an already stopped record spools nothing even when its folder, generation and consent still match', async () => {
      const t = await setup();
      const rec = (await t.record() as { record: object }).record;
      await t.sm.writeStop(t.key(), 'consent_revoked', 's1');
      identityMock.mockResolvedValue(null);
      await t.gate(hook());
      expect(await recordGate(t, rec)).toBe('stop');
    });

    it('an unmoved folder continues; with no outage at the gate the post-stamp check is not run', async () => {
      const t = await setup();
      const rec = (await t.record() as { record: object }).record;
      projectMock.mockResolvedValue('other');
      expect(await recordGate(t, rec)).toBe('continue'); // gate resolved the owner: already checked there
      identityMock.mockResolvedValue(null);
      await t.gate(hook());
      projectMock.mockResolvedValue('proj');
      expect(await recordGate(t, rec)).toBe('continue');
    });
  });

  it('a marker that cannot be written spools nothing', async () => {
    const t = await setup();
    mkdirSync(join(home, 'analytics', 'state'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, 'analytics', 'state', 'evidence'), 'a file where the directory belongs');
    expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'resume' }))).toBe('stop');
  });
});
