/**
 * AC4 regression matrix: disable-all and exclude-one-project, crossed with Global/Project scope,
 * exercised end-to-end through the real allowlist/preferences/gate modules (only the filesystem
 * paths are redirected to a temp dir — nothing about the gate logic itself is mocked).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Initialized synchronously (not undefined) because some modules (e.g. security.ts) call
// getCodemiePath() at module-eval time, before the async beforeEach below has run.
let tempDir: string = tmpdir();

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    resolveHomeDir: (relativePath = '') => join(tempDir, relativePath),
    getCodemiePath: (...paths: string[]) => join(tempDir, '.codemie', ...paths),
  };
});

vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: vi.fn(async () => 'main'),
  detectGitRemoteRepo: vi.fn(async () => 'org/repo'),
  detectGitHeadSha: vi.fn(async () => 'abc123def456'),
  detectGitCommitsByAuthor: vi.fn(async () => []),
}));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null) },
}));
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: vi.fn(async () => null) }));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: vi.fn(async () => '9.9.9') }));
vi.mock('@/agents/core/identity-resolver.js', () => ({
  resolveGitEmail: vi.fn(async () => 'git@example.com'),
  resolveCodemieCliEmail: vi.fn(async () => 'cli@example.com'),
  resolveOsUser: vi.fn(() => 'osuser'),
  resolveIdentity: vi.fn(async () => ({ developerName: 'dev@example.com', identitySource: 'jwt' })),
  resolveEmailFromCredentials: vi.fn(() => 'dev@example.com'),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../client-version-cache.js', () => ({ resolveClientVersion: vi.fn(async () => '2.1.23') }));
vi.mock('../transcript/orchestrator.js', () => ({
  openMainTranscriptPass: vi.fn(async () => ({ events: [], finalize: vi.fn(async () => {}) })),
  openPostCompactPass: vi.fn(async () => ({ events: [], finalize: vi.fn(async () => {}) })),
  openSessionStartPass: vi.fn(async () => ({ events: [], finalize: vi.fn(async () => {}) })),
  openSessionEnvCheckPass: vi.fn(async () => ({ sessionEnvFields: null, finalize: vi.fn(async () => {}) })),
  openSubagentPass: vi.fn(async () => ({ events: [], finalize: vi.fn(async () => {}) })),
  openSessionEndPass: vi.fn(async () => ({ events: [], finalize: vi.fn(async () => {}), gitHeadStart: '', sessionStartedAt: '' })),
  buildSessionEnvEvent: (sessionId: string, fields: Record<string, unknown>) => ({
    type: 'agent.session.env',
    session_id: sessionId,
    ...fields,
  }),
}));
vi.mock('../transcript/subagent-usage.js', () => ({
  readSubagentMeta: vi.fn(async () => ({})),
  readForkedSkillMarker: vi.fn(async () => ({})),
  subagentFilePath: vi.fn((transcriptPath: string, agentId: string) => `${transcriptPath}:${agentId}`),
}));
vi.mock('../event-fields/session-env-fields.js', () => ({
  resolveSessionEnvFields: vi.fn(async () => ({
    provider: 'anthropic',
    api_host: 'api.anthropic.com',
    effort: '',
    output_style: '',
    plugins: {},
    mcp_servers: [],
    os: 'linux',
    arch: 'x64',
    node_version: 'v20.0.0',
    timezone: 'UTC',
    hostname_hash: 'deadbeef',
  })),
}));

const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
const { updateClaudeAnalyticsPreferences } = await import('../claude-code-otlp.preferences.js');

async function writeSettings(allowlist: string[] | undefined): Promise<void> {
  const path = join(tempDir, '.claude', 'settings.json');
  await mkdir(dirname(path), { recursive: true });
  const env: Record<string, string> = {};
  if (allowlist !== undefined) {
    env.CODEMIE_ANALYTICS_PROJECT_FILTER = JSON.stringify(allowlist);
  }
  await writeFile(path, JSON.stringify({ env }), 'utf-8');
}

function event(name: string, cwd: string): string {
  return JSON.stringify({ session_id: 's', transcript_path: '/tmp/t.jsonl', cwd, hook_event_name: name });
}

describe('regression: EPMCDME-16396 — analytics disable matrix', () => {
  let ensureOtlpProxy: ReturnType<typeof vi.fn>;
  let forwardOtlpEventsToSpool: ReturnType<typeof vi.fn>;
  let plugin: InstanceType<typeof ClaudeCodeOtlpPlugin>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-disable-matrix-'));
    ensureOtlpProxy = vi.fn(async () => {});
    forwardOtlpEventsToSpool = vi.fn(async () => true);
    plugin = new ClaudeCodeOtlpPlugin();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function fire(cwd: string): Promise<void> {
    await plugin.processOtlpEvent(event('SessionStart', cwd), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    await plugin.processOtlpEvent(event('UserPromptSubmit', cwd), { ensureOtlpProxy, forwardOtlpEventsToSpool });
  }

  describe.each([
    ['Global', undefined],
    ['Project', ['/work/a', '/work/b']],
  ] as const)('%s scope', (_label, allowlist) => {
    it('exclude /work/a leaves /work/b forwarded', async () => {
      await writeSettings(allowlist);
      await updateClaudeAnalyticsPreferences((current) => ({ ...current, excludedProjects: ['/work/a'] }));

      await fire('/work/a');
      expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();

      await fire('/work/b');
      expect(forwardOtlpEventsToSpool).toHaveBeenCalled();
    });

    it('disable all stops every project regardless of scope', async () => {
      await writeSettings(allowlist);
      await updateClaudeAnalyticsPreferences((current) => ({ ...current, enabled: false }));

      await fire('/work/a');
      await fire('/work/b');
      expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
      expect(ensureOtlpProxy).not.toHaveBeenCalled();
    });
  });

  it('include restores forwarding for a previously excluded project', async () => {
    await writeSettings(undefined);
    await updateClaudeAnalyticsPreferences((current) => ({ ...current, excludedProjects: ['/work/a'] }));
    await fire('/work/a');
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();

    await updateClaudeAnalyticsPreferences((current) => ({ ...current, excludedProjects: [] }));
    await fire('/work/a');
    expect(forwardOtlpEventsToSpool).toHaveBeenCalled();
  });

  it('enable restores forwarding after disable all', async () => {
    await writeSettings(undefined);
    await updateClaudeAnalyticsPreferences((current) => ({ ...current, enabled: false }));
    await fire('/work/a');
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();

    await updateClaudeAnalyticsPreferences((current) => ({ ...current, enabled: true }));
    await fire('/work/a');
    expect(forwardOtlpEventsToSpool).toHaveBeenCalled();
  });
});
