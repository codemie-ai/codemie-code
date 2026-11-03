/**
 * Contract: launcher-exported inputs -> real ConfigLoader/loadHookConfig -> frozen evidence record ->
 * analytics headers -> the backend's destination order. Only credentials, git and the Claude
 * settings/login files are replaced; the config resolver is real (EPMCDME-16440 review findings 1-3).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = vi.hoisted(() => ({
  org: 'Gmail Personal' as string | undefined,
  env: {} as Record<string, unknown>,
  apiKeyHelper: false,
}));

vi.mock('@/utils/processes.js', async (orig) => ({
  ...(await orig<typeof import('@/utils/processes.js')>()),
  getRawGitOrigin: async () => 'https://git.example.com/org/repo.git',
}));
vi.mock('../../hook-credentials.js', () => ({
  resolveHookCredentials: async () => ({
    cookies: { codemie_access_token: `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url')}.s` },
    apiUrl: 'https://analytics.example.com',
    timestamp: 0,
  }),
}));
vi.mock('../../session-project-pin.js', () => ({
  readPinnedProjectName: async () => undefined,
  pinProjectName: async (_s: string, p: string) => p,
}));
vi.mock('@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js', () => ({
  readClaudeSettingsEnv: async () => ({ env: claude.env, complete: true, ...(claude.apiKeyHelper ? { apiKeyHelper: true } : {}) }),
}));
vi.mock('@/agents/plugins/claude-code-otlp/event-fields/claude-org.js', () => ({ readClaudeOrganization: async () => claude.org }));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: async () => '1.0.0' }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

await import('@/providers/index.js');
const { ClaudeCodeOtlpPlugin } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.js');
const { stampEvidence } = await import('../stamp.js');
const { classify } = await import('../classify.js');
const { evidenceHeaders } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/evidence-send.js');

const WORK_GW = 'https://work-gw.example.com/code-assistant-api';
const OTHER_GW = 'https://other-gw.example.com/code-assistant-api';
const PROXY = 'http://127.0.0.1:5555';
const POLICY = { organizations: ['corp'], version: 'v1' };
const KEYS = [
  'CODEMIE_HOME', 'CODEMIE_SESSION_ID', 'CODEMIE_PROFILE_NAME', 'CODEMIE_PROJECT', 'CLAUDE_PROJECT_DIR',
  'CODEMIE_BASE_URL', 'CODEMIE_TARGET_API_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN',
];

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

function writeGlobal(config: unknown): void {
  writeFileSync(join(home, 'codemie-cli.config.json'), JSON.stringify(config));
}
function linkFolder(project: string): void {
  mkdirSync(join(repo, '.codemie'), { recursive: true });
  writeFileSync(
    join(repo, '.codemie', 'codemie-cli.config.json'),
    JSON.stringify({ version: 2, activeProfile: 'work', profiles: {}, workspace: { codeMieProject: project } })
  );
}
const profile = (name: string, baseUrl: string, codeMieProject?: string) => ({
  name, provider: 'ai-run-sso', baseUrl, model: 'm', ...(codeMieProject ? { codeMieProject } : {}),
});

/** One hook: the plugin's real context extraction, the real stamp, then the analytics headers. */
async function frozen(sessionId: string) {
  const plugin = new ClaudeCodeOtlpPlugin();
  const context = await (plugin as unknown as {
    extractHookContext: (i: { cwd: string; session_id: string; hook_event_name: string }) => Promise<Parameters<typeof stampEvidence>[0]>;
  }).extractHookContext({ cwd: repo, session_id: sessionId, hook_event_name: 'Stop' });
  const stamped = await stampEvidence(context, context.evidenceInputs as Parameters<typeof stampEvidence>[1]);
  if (!stamped.ok) throw new Error(`stamp failed: ${stamped.reason}`);
  const record = stamped.record;
  const headers = evidenceHeaders(sessionId, { record, result: classify(record, POLICY) } as Parameters<typeof evidenceHeaders>[1]);
  return { record, headers };
}

/** Backend `_shared_route` order (cli_analytics_project_gate.py): source-qualified project, registered repo, default. */
function destination(headers: Record<string, string>, registered?: Record<string, string>): string {
  const source = (headers['X-CodeMie-Project-Source'] ?? '').toLowerCase();
  if (['linked_folder', 'profile'].includes(source) && headers['X-CodeMie-Project']) return headers['X-CodeMie-Project'];
  const repoProject = registered?.[headers['X-CodeMie-Repo-Remote'] ?? ''];
  return repoProject ?? 'DEFAULT (folder not linked)';
}

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), 'routing-contract-home-'));
  repo = mkdtempSync(join(tmpdir(), 'routing-contract-repo-'));
  process.env.CODEMIE_HOME = home;
  claude.org = 'Gmail Personal';
  claude.env = {};
  claude.apiKeyHelper = false;
  writeGlobal({
    version: 2,
    activeProfile: 'work',
    profiles: { work: profile('work', WORK_GW, 'work-proj'), other: profile('other', OTHER_GW, 'other-proj') },
  });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('finding 1: native without a genuine local link', () => {
  const registered = { 'git.example.com/org/repo': 'repo-proj' };
  // `codemie setup` keeps the profile's project in the global workspace.
  beforeEach(() => {
    writeGlobal({ version: 2, activeProfile: 'work', profiles: { work: profile('work', WORK_GW) }, workspace: { codeMieProject: 'work-proj' } });
  });

  it('the global profile project is no source: the registered repository wins', async () => {
    const { headers } = await frozen('n1');
    expect(headers['X-CodeMie-Project-Source']).toBeUndefined();
    expect(destination(headers, registered)).toBe('repo-proj');
  });

  it('with no registration either, default routing applies (unlinked-folder marking is the backend\'s)', async () => {
    const { headers } = await frozen('n2');
    expect(destination(headers)).toBe('DEFAULT (folder not linked)');
  });

  it('a genuinely linked folder still wins and is a linked_folder source', async () => {
    linkFolder('linked-proj');
    const { record, headers } = await frozen('n3');
    expect(record).toMatchObject({ project: 'linked-proj', project_source: 'linked_folder' });
    expect(destination(headers, registered)).toBe('linked-proj');
  });

  it('a local profile that only falls back to the global workspace project is not a link either', async () => {
    writeGlobal({ version: 2, activeProfile: 'work', profiles: { work: profile('work', WORK_GW) }, workspace: { codeMieProject: 'global-ws' } });
    mkdirSync(join(repo, '.codemie'), { recursive: true });
    writeFileSync(join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'work', profiles: { work: profile('work', WORK_GW) } }));
    const { record, headers } = await frozen('n4');
    expect(record.project_source).toBe('none');
    expect(destination(headers, registered)).toBe('repo-proj');
  });

  it('managed keeps the selected profile project as a profile source', async () => {
    Object.assign(process.env, { CODEMIE_SESSION_ID: 'm1', CODEMIE_PROFILE_NAME: 'work', CODEMIE_BASE_URL: PROXY, CODEMIE_TARGET_API_URL: WORK_GW, ANTHROPIC_BASE_URL: PROXY });
    const { record, headers } = await frozen('m1');
    expect(record).toMatchObject({ launch_mode: 'managed', project: 'work-proj', project_source: 'profile' });
    expect(destination(headers, registered)).toBe('work-proj');
  });
});

describe('finding 3: the launched profile, not the active one', () => {
  const launch = (extra: Record<string, string> = {}) =>
    Object.assign(process.env, {
      CODEMIE_SESSION_ID: 'sid', CODEMIE_PROFILE_NAME: 'other', CODEMIE_BASE_URL: PROXY,
      CODEMIE_TARGET_API_URL: OTHER_GW, ANTHROPIC_BASE_URL: PROXY, ...extra,
    });

  it('--profile other (active: work): its project is sent as a profile source and its gateway proves routing', async () => {
    launch();
    const { record, headers } = await frozen('l1');
    expect(record).toMatchObject({
      launch_mode: 'managed', profile: 'other', project: 'other-proj', project_source: 'profile',
      routed_via_codemie: true, routing_proof: 'proven',
    });
    expect(headers).toMatchObject({ 'X-CodeMie-Project': 'other-proj', 'X-CodeMie-Project-Source': 'profile', 'X-CodeMie-Routed-Via-CodeMie': 'true', 'X-CodeMie-Subscription-Type': 'codemie' });
  });

  it('the exported CODEMIE_PROJECT of that launch agrees with the profile source', async () => {
    launch({ CODEMIE_PROJECT: 'other-proj' });
    expect((await frozen('l2')).record).toMatchObject({ project: 'other-proj', project_source: 'profile' });
  });

  it('a launch whose target gateway is the active profile\'s, not the launched one\'s, is not proven', async () => {
    launch({ CODEMIE_TARGET_API_URL: WORK_GW });
    expect((await frozen('l3')).record).toMatchObject({ routed_via_codemie: false, routing_proof: 'unproven' });
  });

  it('native ignores a stray CODEMIE_PROFILE_NAME and keeps the active profile', async () => {
    process.env.CODEMIE_PROFILE_NAME = 'other';
    const { record } = await frozen('l4');
    expect(record).toMatchObject({ launch_mode: 'native', profile: 'work', project: 'work-proj', project_source: 'none' });
  });
});

describe('finding 2: the saved OAuth login names the payer only when it pays', () => {
  const org = async (id: string) => (await frozen(id)).record.organization;

  it('direct first-party OAuth session: organization is evidence', async () => {
    expect(await org('o1')).toBe('Gmail Personal');
  });

  it.each([
    ['API key in the process env', () => { process.env.ANTHROPIC_API_KEY = 'k'; }],
    ['auth token in the process env', () => { process.env.ANTHROPIC_AUTH_TOKEN = 't'; }],
    ['long-lived OAuth token', () => { process.env.CLAUDE_CODE_OAUTH_TOKEN = 't'; }],
    ['Bedrock in the process env', () => { process.env.CLAUDE_CODE_USE_BEDROCK = '1'; }],
    ['Vertex in the process env', () => { process.env.CLAUDE_CODE_USE_VERTEX = 'true'; }],
    ['API key from settings.json env', () => { claude.env = { ANTHROPIC_API_KEY: 'k' }; }],
    ['Bedrock from settings.json env', () => { claude.env = { CLAUDE_CODE_USE_BEDROCK: '1' }; }],
    ['an apiKeyHelper', () => { claude.apiKeyHelper = true; }],
    ['a non-CodeMie gateway', () => { process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example.net'; }],
  ])('%s: organization withheld, session is Unknown, never Personal', async (_name, arrange) => {
    arrange();
    const { record, headers } = await frozen('o2');
    expect(record.organization).toBeUndefined();
    expect(headers['X-CodeMie-Subscription-Type']).toBe('unknown');
    expect(JSON.stringify([record, headers])).not.toMatch(/"k"|"t"/);
  });

  it('empty settings.json value overriding a process credential is ambiguous: withheld', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    claude.env = { ANTHROPIC_API_KEY: '' };
    expect(await org('o3')).toBeUndefined();
  });

  it('CodeMie-routed sessions are CodeMie regardless of the saved login', async () => {
    Object.assign(process.env, { CODEMIE_SESSION_ID: 'm', CODEMIE_PROFILE_NAME: 'work', CODEMIE_BASE_URL: PROXY, CODEMIE_TARGET_API_URL: WORK_GW, ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'proxy' });
    const { headers } = await frozen('o4');
    expect(headers['X-CodeMie-Subscription-Type']).toBe('codemie');
  });
});
