import { BackendPolicy } from '@/agents/core/collection-policy.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const backendPolicy = new BackendPolicy();
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identityMock = vi.fn();
const gateMock = vi.fn();
const projectMock = vi.fn();
const prefsMock = vi.fn();
const authGateMock = vi.fn();
const authProfileMock = vi.fn();
const credsMock = vi.fn();

vi.mock('@/agents/core/evidence/hook-identity.js', () => ({ currentEvidenceIdentity: identityMock }));
vi.mock('../claude-code-otlp.gate.js', () => ({ evaluateClaudeAnalyticsGate: gateMock }));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuthOrWait: authGateMock }));
vi.mock('@/agents/core/hook-auth-profile.js', () => ({ resolveHookAuthProfile: authProfileMock }));
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: credsMock }));
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
  authProfileMock.mockClear();
  authProfileMock.mockResolvedValue({
    provider: 'ai-run-sso',
    ssoUrl: 'https://sso.example.com',
    baseUrl: 'https://api.example.com',
  });
  authGateMock.mockClear();
  authGateMock.mockResolvedValue({ ok: true });
  credsMock.mockReset();
  credsMock.mockResolvedValue(null); // signed out unless a test signs in
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

  it.each(['not-in-allowlist', 'allowlist-unresolved'])('an already-known session answered %s is stopped as scope_excluded', async (reason) => {
    const t = await setup();
    await t.record();
    gateMock.mockResolvedValue({ tracked: false, reason });
    await t.untracked(hook());
    expect(await t.sm.isStopped(t.key())).toBe(true);
    const [stopFile] = evidenceFiles().filter((f) => f.endsWith('.stop.json'));
    expect(JSON.parse(readFileSync(join(home, 'analytics', 'state', 'evidence', stopFile), 'utf-8')).reason).toBe('scope_excluded');
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
    expect(projectMock).toHaveBeenCalledWith(hook().cwd, 'original', { configuredWins: true });
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
    const deps = { policy: backendPolicy, ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn() };
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

    it('blocks a no-owner UserPromptSubmit when authentication is missing', async () => {
      const t = await setup();
      const { logger } = await import('@/utils/logger.js');
      const errorSpy = vi.spyOn(logger, 'error');
      identityMock.mockResolvedValue(null);
      authGateMock.mockResolvedValue({
        ok: false,
        reason: 'no valid CodeMie SSO credentials found',
        loginOutcome: 'started',
      });
      const deps = { policy: backendPolicy, ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn() };

      await t.plugin.processOtlpEvent(JSON.stringify(hook({ session_id: 'unknown' })), deps as never);

      expect(authGateMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Blocking prompt:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"decision":"block"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hookEventName":"UserPromptSubmit"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"suppressOriginalPrompt":true'));
      expect(deps.ensureOtlpProxy).not.toHaveBeenCalled();
      expect(deps.forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    });

    it('authenticates but still stops an unknown ownerless mid-session prompt', async () => {
      const t = await setup();
      identityMock.mockResolvedValue(null);
      const deps = { policy: backendPolicy, ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn() };

      await t.plugin.processOtlpEvent(JSON.stringify(hook({ session_id: 'unknown' })), deps as never);

      expect(authGateMock).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(deps.ensureOtlpProxy).not.toHaveBeenCalled();
      expect(deps.forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    });

    const signedIn = { api_identity: api, owner_hash: owner };
    const ownerlessMarkers = () => {
      try { return readdirSync(join(home, 'analytics', 'state', 'ownerless-sessions')); } catch { return []; }
    };

    // End-to-end helpers: the real stamp, record store and forwarder call; only identity, credentials and auth are faked.
    const token = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
    const signInAs = async (email: string) => {
      const { apiIdentity, ownerHash } = await import('@/agents/core/evidence/api-identity.js');
      credsMock.mockResolvedValue({ cookies: { codemie_access_token: token(email) }, apiUrl: api, timestamp: 0 });
      const id = { api_identity: apiIdentity(api), owner_hash: ownerHash(email) };
      identityMock.mockResolvedValue(id);
      projectMock.mockResolvedValue(''); // the real stamp records no project for this folder; the live check must agree
      return id;
    };
    const runHook = async (over: Record<string, unknown> = {}) => {
      const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
      const deps = { policy: backendPolicy, ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn().mockResolvedValue(true) };
      await new ClaudeCodeOtlpPlugin().processOtlpEvent(JSON.stringify(hook(over)), deps as never); // a hook is its own process
      return deps;
    };
    const forwardedSessions = (deps: Awaited<ReturnType<typeof runHook>>) =>
      deps.forwardOtlpEventsToSpool.mock.calls.flatMap((c) => (c[0] as { session_id: string }[]).map((e) => e.session_id));
    const recordOf = async (id: { api_identity: string; owner_hash: string }, session = 's1') => {
      const rs = await import('@/agents/core/evidence/record-store.js');
      return rs.readRecord(rs.recordKey(id.api_identity, id.owner_hash, session));
    };

    it('a session that started signed out: the first prompt after sign-in is forwarded and makes the record, the next is judged on it', async () => {
      identityMock.mockResolvedValue(null);
      const start = await runHook({ hook_event_name: 'SessionStart', source: 'startup' });
      expect(forwardedSessions(start)).toEqual([]); // no owner yet: nothing to stamp
      expect(ownerlessMarkers()).toHaveLength(1);

      const id = await signInAs('dev@example.com'); // sign-in during the prompt's auth wait restores the owner
      identityMock.mockReset();
      identityMock.mockResolvedValueOnce(null).mockResolvedValue(id); // the gate read the owner before the sign-in
      const first = await runHook();
      expect(forwardedSessions(first)).toContain('s1');
      const made = await recordOf(id); // made by the forwarded prompt, not written by the test
      expect(made?.kind).toBe('existing');
      expect(ownerlessMarkers()).toHaveLength(0); // the marker admitted this one record and is gone

      const second = await runHook();
      expect(forwardedSessions(second)).toContain('s1');
      const again = await recordOf(id);
      expect(again && 'record' in again && again.record.created).toBe(made && 'record' in made && made.record.created); // the same record
    });

    it('a resumed session with no record stays stopped after sign-in, as it would for a signed-in user', async () => {
      const t = await setup();
      identityMock.mockResolvedValue(null);
      expect(await t.gate(hook({ hook_event_name: 'SessionStart', source: 'resume' }))).toBe('stop');
      expect(ownerlessMarkers()).toHaveLength(0);

      identityMock.mockResolvedValueOnce(null).mockResolvedValueOnce(signedIn);
      expect(await t.gate(hook())).toBe('stop');
      expect(await t.sm.isStopped(t.key())).toBe(true);
      expect(await t.rs.readRecord(t.key())).toBeUndefined();

      identityMock.mockResolvedValue(signedIn);
      expect(await t.gate(hook())).toBe('stop'); // later prompts are stopped too
      expect(await t.rs.readRecord(t.key())).toBeUndefined();
    });

    it('a prompt of an unknown session stays stopped after sign-in even when no SessionStart was seen', async () => {
      const t = await setup();
      identityMock.mockClear();
      identityMock.mockResolvedValueOnce(null).mockResolvedValueOnce(signedIn);

      expect(await t.gate(hook({ session_id: 'unknown' }))).toBe('stop');
      expect(identityMock).toHaveBeenCalledTimes(2);
    });

    it('a failed owner lookup after sign-in holds the first prompt for its owner, and the record exists once the owner resolves', async () => {
      identityMock.mockResolvedValue(null);
      await runHook({ hook_event_name: 'SessionStart', source: 'startup' });

      // signed in, but /v1/user failed: credentials without an owner
      credsMock.mockResolvedValue({ cookies: { _oauth2_proxy: 'cookie' }, apiUrl: api, timestamp: 0 });
      const held = await runHook();
      expect(forwardedSessions(held)).toEqual([]); // not sent: it waits for its owner
      const pending = await import('@/agents/core/evidence/owner-pending.js');
      expect(await pending.hasPendingOwnerSession('s1')).toBe(true);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('paused for this session')); // not silently stopped

      const id = await signInAs('dev@example.com'); // the lookup now succeeds
      expect(await recordOf(id)).toBeUndefined();
      const next = await runHook();
      expect(forwardedSessions(next)).toContain('s1');
      expect(await recordOf(id)).toBeDefined(); // made by the forwarded prompt
    });

    it("the new session's prompt is forwarded while a resumed session's is not and leaves no record", async () => {
      identityMock.mockResolvedValue(null);
      await runHook({ hook_event_name: 'SessionStart', source: 'startup' });
      await runHook({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'resumed' });
      const id = await signInAs('dev@example.com');

      const resumed = await runHook({ session_id: 'resumed' });
      expect(forwardedSessions(resumed)).toEqual([]);
      expect(resumed.ensureOtlpProxy).not.toHaveBeenCalled();
      expect(await recordOf(id, 'resumed')).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('paused for this session'));

      const fresh = await runHook();
      expect(forwardedSessions(fresh)).toContain('s1');
      expect(await recordOf(id)).toBeDefined();
    });

    it('the marker admits only the first record: a later change of account cannot create a second one mid-session', async () => {
      identityMock.mockResolvedValue(null);
      await runHook({ hook_event_name: 'SessionStart', source: 'startup' });
      const a = await signInAs('a@example.com');
      await runHook();
      expect(await recordOf(a)).toBeDefined();
      expect(ownerlessMarkers()).toHaveLength(0);

      const b = await signInAs('b@example.com'); // another account within the 24 h marker lifetime
      const other = await runHook();
      expect(forwardedSessions(other)).toEqual([]);
      expect(await recordOf(b)).toBeUndefined(); // no second record
      expect(await recordOf(a)).toBeDefined(); // the first is untouched
    });

    it('an ownerless-start marker expires, so an old marker no longer opens a session', async () => {
      const m = await import('@/agents/core/evidence/ownerless-session.js');
      const t0 = Date.now();
      await m.markOwnerlessSessionStart('s1', t0);
      expect(await m.hasOwnerlessSessionStart('s1', t0 + m.OWNERLESS_SESSION_TTL_MS - 1000)).toBe(true);
      expect(await m.hasOwnerlessSessionStart('s1', t0 + m.OWNERLESS_SESSION_TTL_MS + 60_000)).toBe(false);
      expect(await m.hasOwnerlessSessionStart('other')).toBe(false);
    });

    it('blocks a recorded ownerless prompt before starting the proxy when authentication is missing', async () => {
      const t = await setup();
      await t.record();
      identityMock.mockResolvedValue(null);
      authGateMock.mockResolvedValue({
        ok: false,
        reason: 'no valid CodeMie SSO credentials found',
        loginOutcome: 'started',
      });
      const deps = { policy: backendPolicy, ensureOtlpProxy: vi.fn(), forwardOtlpEventsToSpool: vi.fn() };

      await t.plugin.processOtlpEvent(JSON.stringify(hook()), deps as never);

      expect(authGateMock).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"decision":"block"'));
      expect(deps.ensureOtlpProxy).not.toHaveBeenCalled();
      expect(deps.forwardOtlpEventsToSpool).not.toHaveBeenCalled();
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
