/**
 * EPMCDME-17845: a Copilot CLI session CodeMie launched and can prove routed through CodeMie is recorded with the
 * new publication contract (funding api_based, class codemie); nothing else ever acquires a CodeMie funding claim.
 * Real: the adapter hook flow, evidence stamp/record store, project resolution, session pin and the forwarder's
 * header builder. Synthetic: SSO credentials, profile config, the daemon spool transport (captured, not sent).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { BackendPolicy } from '@/agents/core/collection-policy.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cop-funding-'));
process.env.CODEMIE_HOME = join(root, 'codemie');
process.env.COPILOT_HOME = join(root, 'copilot');
const cwd = join(root, 'work');
mkdirSync(cwd, { recursive: true });

const GATEWAY = 'https://gw.example.com/code-assistant-api';
const PROXY = 'http://127.0.0.1:5555';
const creds = { cookies: { session: 'x' }, apiUrl: 'https://api.example.com', timestamp: 0, email: 'dev@example.com' };

vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: vi.fn(async () => creds) }));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/agents/core/hook-auth-profile.js', () => ({ resolveHookAuthProfile: vi.fn(async () => ({})) }));
vi.mock('@/agents/core/copilot-analytics-gate.js', () => ({ evaluateCopilotAnalyticsGate: vi.fn(async () => ({ tracked: true })) }));
vi.mock('@/providers/index.js', () => ({
  ProviderRegistry: { getProvider: (name: string) => (name === 'ai-run-sso' ? { authType: 'sso' } : { authType: 'api-key' }) },
}));
// Two profiles with different projects: the launched one (p1) and the globally active one.
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: vi.fn(async () => 'active'),
    hasLocalConfig: vi.fn(async () => false),
    load: vi.fn(async (_dir: string, sel?: { name: string }) => ({
      name: sel?.name ?? 'active', provider: 'ai-run-sso', codeMieProject: sel?.name === 'p1' ? 'proj-a' : 'proj-active',
    })),
    resolveProfileIdentity: vi.fn(async () => ({ projectOrigin: 'linked_folder', state: 'local' })),
  },
}));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CopilotCliOtlpPlugin } from '../copilot-cli-otlp.plugin.js';
import { apiIdentity } from '@/agents/core/evidence/api-identity.js';
import { ownerHash } from '@/agents/core/evidence/api-identity.js';
import { readRecord, recordKey } from '@/agents/core/evidence/record-store.js';
import { isStopped } from '@/agents/core/evidence/stop-marker.js';
import { classify } from '@/agents/core/evidence/classify.js';
import { evidenceHeaders } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/evidence-send.js';
import { PINNED_NATIVE_SESSION_ENV } from '@/agents/plugins/copilot-cli/copilot-cli.constants.js';
import { isDaemonAlive, readState, type DaemonState } from '@/cli/commands/proxy/daemon-manager.js';

vi.mock('@/cli/commands/proxy/daemon-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/cli/commands/proxy/daemon-manager.js')>()),
  readState: vi.fn(async () => null),
  isDaemonAlive: vi.fn(async () => false),
}));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const MANAGED_ENV: Record<string, string> = {
  CODEMIE_SESSION_ID: 'cm-session',
  CODEMIE_PROFILE_NAME: 'p1',
  CODEMIE_PROFILE_CONFIG: JSON.stringify({ name: 'p1', provider: 'ai-run-sso', baseUrl: GATEWAY }),
  CODEMIE_BASE_URL: PROXY,
  CODEMIE_TARGET_API_URL: GATEWAY,
  COPILOT_PROVIDER_BASE_URL: PROXY,
};
const ENV_KEYS = [...Object.keys(MANAGED_ENV), PINNED_NATIVE_SESSION_ENV, 'CODEMIE_PROJECT'];

let n = 0;
let sid = '';
const spooled: Array<{ events: Record<string, unknown>[]; options?: { evidenceV?: 1 } }> = [];
const deps = {
  policy: new BackendPolicy(),
  ensureOtlpProxy: vi.fn(async () => {}),
  forwardOtlpEventsToSpool: vi.fn(async (events: Record<string, unknown>[], _agent: string, options?: { evidenceV?: 1 }) => {
    spooled.push({ events, options });
    return true;
  }),
};
const plugin = new CopilotCliOtlpPlugin();
const hook = (name: string, extra: Record<string, unknown> = {}): Promise<void> =>
  plugin.processOtlpEvent(JSON.stringify({ sessionId: sid, cwd, timestamp: 1700000000000, codemieEventName: name, ...extra }), deps as never);
const recordOf = async () => {
  const found = await readRecord(recordKey(apiIdentity(creds.apiUrl), ownerHash(creds.email), sid));
  return found && (found.kind === 'existing' || found.kind === 'created') ? found.record : undefined;
};
const start = (source = 'new') => hook('sessionStart', { source });

beforeEach(() => {
  vi.mocked(readState).mockReset().mockResolvedValue(null);
  vi.mocked(isDaemonAlive).mockReset().mockResolvedValue(false);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, MANAGED_ENV);
  sid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  process.env[PINNED_NATIVE_SESSION_ENV] = sid;
  spooled.length = 0;
});

describe('CodeMie-proven managed Copilot session', () => {
  it('records a launcher-pinned sessionStart when source is omitted', async () => {
    await hook('sessionStart');
    expect(await recordOf()).toMatchObject({ funding_route: 'api_based' });
    expect(spooled[0]?.options).toEqual({ evidenceV: 1 });
  });

  it('is recorded with funding api_based, the launch profile project and its origin, and publishes codemie headers', async () => {
    await start();
    const record = await recordOf();
    expect(record).toMatchObject({
      routed_via_codemie: true, routing_proof: 'proven', launch_mode: 'managed', funding_route: 'api_based',
      negotiate_publication: true, project: 'proj-a', project_source: 'linked_folder', profile: 'p1', collection_generation: 0,
    });
    expect(spooled[0].options).toEqual({ evidenceV: 1 });
    expect(spooled[0].events[0]).toMatchObject({ session_id: sid, codemie_project_name: 'proj-a', platform: 'copilot-cli', entrypoint: 'managed' });

    const headers = evidenceHeaders(sid, {
      key: 'k', record: record!, ns: { api_identity: record!.api_identity, owner_hash: record!.owner_hash },
      baseUrl: creds.apiUrl, credentials: creds, newContract: true, consent: false, wireMode: 'contract',
      result: classify({ routed_via_codemie: true, routing_proof: 'proven' }, null),
    } as never);
    expect(headers).toMatchObject({
      'X-CodeMie-Subscription-Type': 'codemie', 'X-CodeMie-Funding-Route': 'api_based', 'X-CodeMie-Publication-Contract': '1',
      'X-CodeMie-Routed-Via-CodeMie': 'true', 'X-CodeMie-Project': 'proj-a', 'X-CodeMie-Project-Source': 'linked_folder',
    });
    expect(headers).not.toHaveProperty('X-CodeMie-Work-Consent');
  });

  it('keeps the frozen record across later hooks and a resume (no second claim, no re-resolution)', async () => {
    await start();
    const first = await recordOf();
    process.env.CODEMIE_PROFILE_NAME = 'active'; // a later switch must not change what the session froze
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    await start('resume');
    expect(await recordOf()).toEqual(expect.objectContaining({ created: first!.created, project: 'proj-a', funding_route: 'api_based' }));
    expect(spooled.map((s) => s.options)).toEqual([{ evidenceV: 1 }, { evidenceV: 1 }, { evidenceV: 1 }]);
  });

  it('stops spooling when the session moves to another project (privacy scope) and writes the stop marker', async () => {
    await start();
    process.env.CODEMIE_PROJECT = 'proj-other';
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(spooled).toHaveLength(1);
    expect(await isStopped(recordKey(apiIdentity(creds.apiUrl), ownerHash(creds.email), sid))).toBe(true);
  });
});

describe('sessions that must never acquire a CodeMie funding claim', () => {
  const noClaim = async (): Promise<void> => {
    await start();
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(await recordOf()).toBeUndefined();
    expect(spooled.length).toBeGreaterThan(0);
    for (const s of spooled) expect(s.options).toBeUndefined();
  };

  it('native Copilot with an active CodeMie profile and BYOK env pointing at the proxy', async () => {
    for (const k of ['CODEMIE_SESSION_ID', 'CODEMIE_PROFILE_NAME', 'CODEMIE_PROFILE_CONFIG', PINNED_NATIVE_SESSION_ENV]) delete process.env[k];
    await noClaim();
  });
  it('a native Copilot started inside a managed shell (its own id differs from the pinned one)', async () => {
    process.env[PINNED_NATIVE_SESSION_ENV] = '99999999-9999-4999-8999-999999999999';
    await noClaim();
  });
  it('an unrelated BYOK endpoint in a managed shell', async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
    await noClaim();
  });
  it('a managed launch whose proxy upstream is not the launch profile route', async () => {
    process.env.CODEMIE_TARGET_API_URL = 'https://other.example.org';
    await noClaim();
  });
  it('only the active profile, no launch profile export', async () => {
    delete process.env.CODEMIE_PROFILE_CONFIG;
    await noClaim();
  });
  it('a launch profile that is not a CodeMie route (LiteLLM)', async () => {
    process.env.CODEMIE_PROFILE_CONFIG = JSON.stringify({ name: 'p1', provider: 'litellm', baseUrl: GATEWAY });
    await noClaim();
  });
  it('a malformed launch profile export', async () => {
    process.env.CODEMIE_PROFILE_CONFIG = '{not json';
    await noClaim();
  });
});

describe('session binding for a new funding claim', () => {
  it('an unpinned launch (resume/continue) cannot create a claim: a fresh nested native Copilot inheriting the exports stays unrecorded', async () => {
    delete process.env[PINNED_NATIVE_SESSION_ENV];
    await start('new');
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(await recordOf()).toBeUndefined();
    for (const s of spooled) expect(s.options).toBeUndefined();
  });

  it('an unpinned resume of an already recorded session is still supported', async () => {
    await start('new');
    delete process.env[PINNED_NATIVE_SESSION_ENV];
    await start('resume');
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(spooled.map((s) => s.options)).toEqual([{ evidenceV: 1 }, { evidenceV: 1 }, { evidenceV: 1 }]);
  });
});

describe('sticky attribution boundary', () => {
  it('a recorded session that loses route proof sends nothing (no legacy bytes), stays stopped, and uses no stale claim', async () => {
    await start();
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(spooled).toHaveLength(1); // only the proven start
    expect(await isStopped(recordKey(apiIdentity(creds.apiUrl), ownerHash(creds.email), sid))).toBe(true);
    process.env.COPILOT_PROVIDER_BASE_URL = PROXY; // proof returning does not reopen a stopped session
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't2' });
    expect(spooled).toHaveLength(1);
  });

  describe('across a changed or missing login identity', () => {
    const other = { ...creds, email: 'other@example.com' };
    const otherKey = (): string => recordKey(apiIdentity(creds.apiUrl), ownerHash(other.email), sid);

    it.each([
      { state: null, label: 'missing daemon state' },
      { state: { pid: 123, port: 5555, startedAt: '2020-01-01T00:00:00Z' } as DaemonState, label: 'dead daemon without upstream' },
    ])('cold-starts before resuming an already recorded session with $label', async ({ state }) => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await start();
      delete process.env[PINNED_NATIVE_SESSION_ENV];
      vi.mocked(readState).mockResolvedValue(state);
      vi.mocked(resolveHookCredentials).mockResolvedValue(undefined as never);
      deps.ensureOtlpProxy.mockImplementationOnce(async () => {
        vi.mocked(resolveHookCredentials).mockResolvedValue(creds as never);
      });
      try {
        await start('resume');
        expect(spooled).toHaveLength(2);
        expect(spooled[1]?.options).toEqual({ evidenceV: 1 });
      } finally {
        deps.ensureOtlpProxy.mockReset();
        vi.mocked(resolveHookCredentials).mockResolvedValue(creds as never);
      }
    });

    it('lost proof under another login (record sits under the previous owner): no unstamped bytes, stopped', async () => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await start();
      expect(spooled).toHaveLength(1);
      vi.mocked(resolveHookCredentials).mockResolvedValueOnce(other as never).mockResolvedValueOnce(other as never);
      process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
      await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      expect(spooled).toHaveLength(1);
      expect(await isStopped(otherKey())).toBe(true);
    });

    it('proof present under another login is not positive authorization: no new claim for a session recorded elsewhere', async () => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await start();
      vi.mocked(resolveHookCredentials).mockResolvedValueOnce(other as never).mockResolvedValueOnce(other as never);
      await start('resume');
      expect(spooled).toHaveLength(1);
      expect(await readRecord(otherKey())).toBeUndefined();
    });

    it('missing identity with proof still present on a recorded session (no owner-held events) sends no unstamped batch', async () => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await start();
      vi.mocked(resolveHookCredentials).mockResolvedValue(undefined as never);
      try {
        await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      } finally {
        vi.mocked(resolveHookCredentials).mockResolvedValue(creds as never);
      }
      expect(spooled).toHaveLength(1);
    });

    it('missing identity with lost proof on a recorded session sends nothing', async () => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await start();
      vi.mocked(resolveHookCredentials).mockResolvedValue(undefined as never);
      try {
        process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
        await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      } finally {
        vi.mocked(resolveHookCredentials).mockResolvedValue(creds as never);
      }
      expect(spooled).toHaveLength(1);
    });
  });

  describe('events held for the session owner (pending-owner state)', () => {
    const hold = async (): Promise<void> => {
      const { enqueuePendingOwner } = await import('@/agents/core/evidence/owner-pending.js');
      expect(await enqueuePendingOwner({
        fp: 'fp-test', agentName: 'copilot-cli-otlp', api_identity: apiIdentity(creds.apiUrl), session_id: sid, fields: {} as never, events: [],
      })).toBe(true);
    };
    const keyOf = (): string => recordKey(apiIdentity(creds.apiUrl), ownerHash(creds.email), sid);

    it('proven and held for its owner (no record yet): the hook continues with a stamped claim, no stop', async () => {
      await hold();
      await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      expect(spooled.length).toBeGreaterThan(0);
      for (const s of spooled) expect(s.options).toEqual({ evidenceV: 1 });
      expect(await isStopped(keyOf())).toBe(false);
    });

    it('held for its owner but route proof lost: stopped, no unstamped bytes', async () => {
      await hold();
      process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
      await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      expect(spooled).toHaveLength(0);
      expect(await isStopped(keyOf())).toBe(true);
    });

    it('no identity, held for its owner, proof lost: stopped, no unstamped bytes', async () => {
      const { resolveHookCredentials } = await import('@/agents/core/hook-credentials.js');
      await hold();
      vi.mocked(resolveHookCredentials).mockResolvedValue(undefined as never);
      try {
        process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example.org/v1';
        await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
      } finally {
        vi.mocked(resolveHookCredentials).mockResolvedValue(creds as never);
      }
      expect(spooled).toHaveLength(0);
    });
  });

  it('a native session with a record under the same id (no managed launch) is stopped, not forwarded as legacy', async () => {
    await start();
    for (const k of ['CODEMIE_SESSION_ID', PINNED_NATIVE_SESSION_ENV]) delete process.env[k];
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(spooled).toHaveLength(1);
  });
});

describe('independent collection controls', () => {
  it('a Claude collection-generation change neither stops a Copilot session nor blocks its sender; Copilot controls still apply', async () => {
    const { updateClaudeAnalyticsPreferences } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
    const { sendGuard } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/evidence-send.js');
    await start();
    const record = (await recordOf())!;
    await updateClaudeAnalyticsPreferences((p) => ({ ...p, collectionGeneration: p.collectionGeneration + 1 }));
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    expect(spooled).toHaveLength(2);
    const key = recordKey(apiIdentity(creds.apiUrl), ownerHash(creds.email), sid);
    expect(await sendGuard(key, record)).toBe(true); // the forwarder's own consumer
    // a Claude-recorded session (no agent marker) is still bound to the generation
    expect(await sendGuard(key, { ...record, agent: undefined })).toBe(false);
  });
});

describe('pre-existing spool data and resume', () => {
  it('a mid-session hook with no record is never upgraded; a resume start without a record stays legacy', async () => {
    await hook('preToolUse', { toolName: 'bash', toolArgs: '{}', toolCallId: 't1' });
    await start('resume');
    expect(await recordOf()).toBeUndefined();
    for (const s of spooled) expect(s.options).toBeUndefined();
  });
});
