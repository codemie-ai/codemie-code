/**
 * Contract probe (fake credentials, no network): for an SSO profile whose baseUrl (P=Preview) differs from the
 * workspace codeMieUrl (W=prod), the daemon spawn parameters decide where analytics go. Config -> spawnForProfile
 * -> recorded daemon state -> resolveAnalyticsEndpoint, next to the project the native hook would stamp.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const daemon = vi.hoisted(() => ({ state: undefined as Record<string, unknown> | undefined }));

vi.mock('../daemon-manager.js', async (orig) => ({
  ...(await orig<typeof import('../daemon-manager.js')>()),
  spawnDaemon: async (opts: Record<string, unknown>) => (daemon.state = { ...opts }),
  readState: async () => daemon.state,
}));
vi.mock('../connect-orchestrator.js', () => ({ verifySsoCredentials: async () => undefined }));
vi.mock('../../skills/setup/sync.js', () => ({ syncRegisteredSkills: async () => undefined }));
vi.mock('../../skills/setup/sync-plugin.js', () => ({ syncPluginSkills: async () => undefined }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { ConfigLoader } = await import('@/utils/config.js');
const { spawnForProfile } = await import('../launch-daemon.js');
const { resolveAnalyticsEndpoint } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/classification.js');

const PREVIEW = 'https://preview.example.com/code-assistant-api';
const PROD = 'https://prod.example.com';
const creds = (apiUrl: string) => ({
  cookies: { codemie_access_token: `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url')}.s` },
  apiUrl,
  timestamp: 0,
});

let root: string;
let saved: string | undefined;

function setup(linkUrl: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.codemie'), { recursive: true });
  writeFileSync(join(root, 'codemie-cli.config.json'), JSON.stringify({
    version: 2, activeProfile: 'p',
    profiles: { p: { name: 'p', provider: 'ai-run-sso', baseUrl: PREVIEW, model: 'm' } },
    workspace: { codeMieUrl: `${PROD}/`, codeMieProject: 'global-proj' },
  }));
  writeFileSync(join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify({
    version: 2, activeProfile: 'p', profiles: {}, workspace: { codeMieUrl: linkUrl, codeMieProject: 'linked-proj' },
  }));
  return repo;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dest-'));
  saved = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = root;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

describe('P=Preview baseUrl, W=prod workspace: what the daemon actually uses', () => {
  // The selected global profile's project is used in managed and native alike; a workspace-only linked folder does not
  // replace it, whichever server it names, so the project is always one the analytics server (W) knows.
  for (const [label, link] of [
    ['link matches W (prod)', PROD],
    ['link matches P (preview)', 'https://preview.example.com'],
  ] as const) {
    it(`${label}`, async () => {
      const repo = setup(link);
      const native = await ConfigLoader.load(repo, { name: 'p' });
      await spawnForProfile(native as never, 'p', {});
      const endpoint = {
        prodCreds: await resolveAnalyticsEndpoint(creds(`${PROD}/code-assistant-api`) as never),
        previewCreds: await resolveAnalyticsEndpoint(creds(PREVIEW) as never),
      };
      console.log(JSON.stringify({ label, project: native.codeMieProject, daemon: { targetUrl: daemon.state?.targetUrl, syncCodeMieUrl: daemon.state?.syncCodeMieUrl, syncApiUrl: daemon.state?.syncApiUrl, project: daemon.state?.project }, endpoint: { prodCreds: endpoint.prodCreds?.baseUrl ?? null, previewCreds: endpoint.previewCreds?.baseUrl ?? null } }));
      expect(native.codeMieProject).toBe('global-proj');
      expect(daemon.state?.project).toBe('global-proj');
      expect(daemon.state?.targetUrl).toBe(PREVIEW);
      expect(daemon.state?.syncCodeMieUrl).toBe(`${PROD}/`);
      // Analytics only go to W's API: preview-issued credentials are never accepted for them.
      expect(endpoint.previewCreds).toBeNull();
      expect(endpoint.prodCreds?.baseUrl).toBe(`${PROD}/code-assistant-api`);
    });
  }
});
