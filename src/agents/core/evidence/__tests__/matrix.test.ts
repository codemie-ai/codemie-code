import { evidenceDir } from '../record-store.js';
/**
 * AC1 matrix: routed/direct/unproven x managed/native x user / project-in-allowlist / project-outside,
 * through the real adapter gate, routing, stampEvidence, record-store and classify.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const m = vi.hoisted(() => ({ project: undefined as string | undefined }));

vi.mock('@/utils/processes.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/processes.js')>()),
  detectGitBranch: async () => 'main',
  detectGitRemoteRepo: async () => 'org/repo',
  getRawGitOrigin: async () => 'https://user:secret@git.example.com/org/repo.git',
}));
vi.mock('../../hook-credentials.js', () => ({
  resolveHookCredentials: async () => ({
    cookies: { codemie_access_token: `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url')}.s` },
    apiUrl: 'https://analytics.example.com',
    timestamp: 0,
  }),
}));
vi.mock('../../identity-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../identity-resolver.js')>()),
  resolveIdentity: async () => ({ developerName: 'dev@example.com', identitySource: 'jwt' }),
}));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: async () => 'work',
    load: async () => ({ codeMieProject: m.project }),
    hasLocalConfig: async () => false,
    resolveProjectOrigin: async () => 'profile',
    isLocalProfile: async () => false,
  },
}));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: async () => '1.0.0' }));
vi.mock('../../session-project-pin.js', () => ({
  readPinnedProjectName: async () => undefined,
  pinProjectName: async (_s: string, p: string) => p,
}));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { OtlpAgentAdapter } = await import('../../OtlpAgentAdapter.js');
const { routedViaCodemie, launchMode } = await import('../routing.js');
const { classify } = await import('../classify.js');
type Routing = import('../routing.js').RoutingInput;

const GATEWAY = 'https://llm-gateway.example.com'; // model gateway; analytics is analytics.example.com
const PROXY = 'http://127.0.0.1:5555'; // local proxy
const DIRECT = 'https://api.anthropic.com';
const POLICY = { organizations: ['corp'], version: 'v1' };

const managedEnv = { CODEMIE_SESSION_ID: 'x', CODEMIE_BASE_URL: PROXY, CODEMIE_TARGET_API_URL: GATEWAY };
interface Row { name: string; env: Record<string, string>; settings?: string; provider: boolean; routed: boolean; proof: 'proven' | 'unproven'; cls: string; basis: string }
const rows: Row[] = [
  { name: 'managed routed', env: { ...managedEnv, ANTHROPIC_BASE_URL: PROXY }, provider: true, routed: true, proof: 'proven', cls: 'codemie', basis: 'routed' },
  { name: 'managed direct subscription', env: { CODEMIE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: DIRECT }, provider: false, routed: false, proof: 'proven', cls: 'personal', basis: 'org_no_match' },
  { name: 'managed, settings.json override away from the proxy', env: { ...managedEnv, ANTHROPIC_BASE_URL: PROXY }, settings: DIRECT, provider: true, routed: false, proof: 'unproven', cls: 'unknown', basis: 'routing_unproven' },
  { name: 'native with the configured gateway', env: { ANTHROPIC_BASE_URL: GATEWAY }, provider: true, routed: true, proof: 'proven', cls: 'codemie', basis: 'routed' },
  { name: 'native positively direct', env: { ANTHROPIC_BASE_URL: DIRECT }, provider: false, routed: false, proof: 'proven', cls: 'personal', basis: 'org_no_match' },
  { name: 'native with an unmatched endpoint', env: { ANTHROPIC_BASE_URL: 'https://other.example.net' }, provider: true, routed: false, proof: 'unproven', cls: 'unknown', basis: 'routing_unproven' },
];
const scopes = [
  { scope: 'user', project: undefined, tracked: true, source: 'none' },
  { scope: 'project in allowlist', project: 'proj-1', tracked: true, source: 'profile' },
  { scope: 'project outside allowlist', project: 'proj-1', tracked: false, source: '' },
] as const;

let current: { row: Row; tracked: boolean } | undefined;
class Adapter extends OtlpAgentAdapter<{ cwd: string; sessionId: string }> {
  readonly name = 'fake';
  protected parseHookInput(raw: string) { return JSON.parse(raw); }

  protected async isTracked(): Promise<boolean> { return current!.tracked; }
  protected requiresSpoolAcceptance(): boolean { return false; }
  protected async evaluate() { return { decision: 'forward' as const, payload: [{ a: 1 }] }; }
  protected async resolveAgentFields() { return {}; }
  protected resolveEventType() { return 'fake.event'; }
  protected buildEventId(e: Record<string, unknown>) { return String(e['type']); }
  protected extractHookContext(i: { cwd: string; sessionId: string }) {
    const { row } = current!;
    const input: Routing = { env: row.env, codemieProvider: row.provider, profileBaseUrl: GATEWAY, ...(row.settings ? { settingsEnv: { ANTHROPIC_BASE_URL: row.settings } } : {}) };
    return { cwd: i.cwd, sessionId: i.sessionId, evidenceInputs: { organization: 'Gmail Personal', routing: routedViaCodemie(input) } };
  }
}

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CODEMIE_HOME', 'CODEMIE_SESSION_ID', 'CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR', 'CODEMIE_BASE_URL', 'CODEMIE_TARGET_API_URL', 'ANTHROPIC_BASE_URL'];
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), 'evidence-matrix-'));
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

describe('AC1 routing x launch mode x scope matrix', () => {
  for (const row of rows) {
    for (const sc of scopes) {
      it(`${row.name} / ${sc.scope}`, async () => {
        Object.assign(process.env, row.env);
        m.project = sc.project;
        current = { row, tracked: sc.tracked };
        const forward = vi.fn(async () => true);
        const proxy = vi.fn(async () => {});
        await new Adapter().processOtlpEvent(JSON.stringify({ cwd: '/repo', sessionId: 's1' }), {
          ensureOtlpProxy: proxy,
          forwardOtlpEventsToSpool: forward,
        });

        const dir = evidenceDir();
        const files = (() => { try { return readdirSync(dir); } catch { return []; } })();
        if (!sc.tracked) {
          // Untracked project: nothing stamped, nothing spooled, daemon not started.
          expect(files).toEqual([]);
          expect(forward).not.toHaveBeenCalled();
          expect(proxy).not.toHaveBeenCalled();
          return;
        }
        expect(forward).toHaveBeenCalledWith(expect.any(Array), 'fake', { evidenceV: 1 });
        const record = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
        expect(record).toMatchObject({
          session_id: 's1',
          launch_mode: launchMode(row.env),
          routed_via_codemie: row.routed,
          routing_proof: row.proof,
          organization: 'Gmail Personal',
          project_source: sc.source,
          repo_key: 'git.example.com/org/repo',
        });
        expect(record.project).toBe(sc.project);
        expect(JSON.stringify(record)).not.toContain('secret');

        // Classification from the stored evidence: an unproven route is never Personal.
        const result = classify(record, POLICY);
        expect(result).toMatchObject({ class: row.cls, basis: row.basis });
        expect(result.status).toBe(row.proof === 'unproven' ? 'indeterminate' : 'determinate');
      });
    }
  }
});
