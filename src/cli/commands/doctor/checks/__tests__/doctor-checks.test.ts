/**
 * Doctor health-check contract tests.
 *
 * Pins the current result shape ({ name, success, details: [{status, message, hint?}] })
 * and the pass / warn / fail / info branches of each doctor check. Every external
 * system the checks touch (exec, config, credential store, registries, VCS, frameworks)
 * is mocked so results are deterministic and no real process/network/fs probing occurs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthMethod } from '@/providers/core/types.js';

// ── Hoisted mock functions (available inside the hoisted vi.mock factories) ──────────
const h = vi.hoisted(() => ({
  execMock: vi.fn(),
  loadMock: vi.fn(),
  listProfilesMock: vi.fn(),
  getActiveProfileNameMock: vi.fn(),
  retrieveJWTMock: vi.fn(),
  resolveEnvVarMock: vi.fn(),
  getProviderMock: vi.fn(),
  getInstalledAgentsMock: vi.fn(),
  getAllFrameworksMock: vi.fn(),
  detectVCSMock: vi.fn(),
  listWorkflowsMock: vi.fn(),
}));

// exec() drives AwsCliCheck and UvCheck.
vi.mock('@/utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/processes.js')>();
  return { ...actual, exec: h.execMock };
});

// ConfigLoader drives JWTAuthCheck and AIConfigCheck (mutate statics, keep other exports).
vi.mock('@/utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/config.js')>();
  (actual.ConfigLoader as unknown as Record<string, unknown>).load = h.loadMock;
  (actual.ConfigLoader as unknown as Record<string, unknown>).listProfiles = h.listProfilesMock;
  (actual.ConfigLoader as unknown as Record<string, unknown>).getActiveProfileName = h.getActiveProfileNameMock;
  return actual;
});

// CredentialStore.getInstance().retrieveJWTCredentials drives JWTAuthCheck.
vi.mock('@/utils/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/security.js')>();
  (actual.CredentialStore as unknown as Record<string, unknown>).getInstance = () => ({
    retrieveJWTCredentials: h.retrieveJWTMock,
  });
  return actual;
});

// resolveJwtTokenEnvVar drives which env var JWTAuthCheck reads.
vi.mock('@/providers/plugins/jwt/jwt.utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/plugins/jwt/jwt.utils.js')>();
  return { ...actual, resolveJwtTokenEnvVar: h.resolveEnvVarMock };
});

// ProviderRegistry.getProvider drives AIConfigCheck provider-template lookups.
vi.mock('@/providers/core/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/core/registry.js')>();
  (actual.ProviderRegistry as unknown as Record<string, unknown>).getProvider = h.getProviderMock;
  return actual;
});

// AgentRegistry.getInstalledAgents drives AgentsCheck.
vi.mock('@/agents/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/registry.js')>();
  (actual.AgentRegistry as unknown as Record<string, unknown>).getInstalledAgents = h.getInstalledAgentsMock;
  return actual;
});

// FrameworkRegistry.getAllFrameworks drives FrameworksCheck.
vi.mock('@/frameworks/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/frameworks/index.js')>();
  (actual.FrameworkRegistry as unknown as Record<string, unknown>).getAllFrameworks = h.getAllFrameworksMock;
  return actual;
});

// detectVCSProvider / listInstalledWorkflows drive WorkflowsCheck.
vi.mock('@/workflows/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workflows/index.js')>();
  return { ...actual, detectVCSProvider: h.detectVCSMock, listInstalledWorkflows: h.listWorkflowsMock };
});

// Import checks AFTER mocks are registered.
import { NodeVersionCheck } from '../NodeVersionCheck.js';
import { AwsCliCheck } from '../AwsCliCheck.js';
import { UvCheck } from '../UvCheck.js';
import { JWTAuthCheck } from '../JWTAuthCheck.js';
import { AgentsCheck } from '../AgentsCheck.js';
import { AIConfigCheck } from '../AIConfigCheck.js';
import { WorkflowsCheck } from '../WorkflowsCheck.js';
import { FrameworksCheck } from '../FrameworksCheck.js';

/** Build a fake JWT whose payload has the given exp (seconds since epoch), or none. */
function fakeJwt(exp?: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(JSON.stringify(exp === undefined ? { sub: 'x' } : { exp })).toString('base64');
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('NodeVersionCheck', () => {
  const original = process.version;
  const setVersion = (v: string) =>
    Object.defineProperty(process, 'version', { value: v, configurable: true });
  afterEach(() => Object.defineProperty(process, 'version', { value: original, configurable: true }));

  it('passes for Node >= 18', async () => {
    setVersion('v20.11.0');
    const result = await new NodeVersionCheck().run();
    expect(result.name).toBe('Node.js');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ status: 'ok', message: 'Version v20.11.0' }]);
  });

  it('warns and fails for Node < 18', async () => {
    setVersion('v16.20.0');
    const result = await new NodeVersionCheck().run();
    expect(result.success).toBe(false);
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].hint).toBe('Recommended: >= 18.0.0');
  });

  it('treats exactly v18 as ok (boundary)', async () => {
    setVersion('v18.0.0');
    const result = await new NodeVersionCheck().run();
    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('AwsCliCheck', () => {
  it('passes when aws --version succeeds', async () => {
    h.execMock.mockResolvedValueOnce({ stdout: 'aws-cli/2.15.0', stderr: '' });
    const result = await new AwsCliCheck().run();
    expect(result.name).toBe('AWS CLI');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ status: 'ok', message: 'Version aws-cli/2.15.0' }]);
    expect(h.execMock).toHaveBeenCalledWith('aws', ['--version']);
  });

  it('warns (success=false) when aws is not installed', async () => {
    h.execMock.mockRejectedValueOnce(new Error('command not found'));
    const result = await new AwsCliCheck().run();
    expect(result.success).toBe(false);
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toBe('AWS CLI not found');
    expect(result.details[0].hint).toContain('aws.amazon.com/cli');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('UvCheck', () => {
  it('passes and strips the "uv " prefix from the version', async () => {
    h.execMock.mockResolvedValueOnce({ stdout: 'uv 0.4.18\n', stderr: '' });
    const result = await new UvCheck().run();
    expect(result.name).toBe('uv');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ status: 'ok', message: 'Version 0.4.18' }]);
  });

  it('reports info (not a failure) when uv is absent', async () => {
    h.execMock.mockRejectedValueOnce(new Error('not found'));
    const result = await new UvCheck().run();
    // uv is optional: missing uv must NOT flip success to false.
    expect(result.success).toBe(true);
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toBe('uv not found');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('JWTAuthCheck', () => {
  const ENV = 'CODEMIE_JWT_TOKEN_TEST';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV];
    delete process.env[ENV];
    h.resolveEnvVarMock.mockReturnValue(ENV);
    h.loadMock.mockResolvedValue({ authMethod: AuthMethod.JWT, baseUrl: 'https://api.example.com' });
    h.retrieveJWTMock.mockResolvedValue(null);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  it('skips (info) when the profile is not using JWT auth', async () => {
    h.loadMock.mockResolvedValueOnce({ authMethod: AuthMethod.SSO, baseUrl: 'https://api.example.com' });
    const result = await new JWTAuthCheck().run();
    expect(result.name).toBe('JWT Authentication');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { status: 'info', message: 'Not using JWT authentication (skipped)' },
    ]);
  });

  it('errors when no token is present in env or credential store', async () => {
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(false);
    expect(result.details[0].status).toBe('error');
    expect(result.details[0].message).toContain(`JWT token not found in ${ENV}`);
  });

  it('passes with an env token that expires far in the future', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // +30 days
    process.env[ENV] = fakeJwt(exp);
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(true);
    const statuses = result.details.map((d) => d.status);
    expect(statuses).toContain('ok');
    expect(result.details.some((d) => d.message.includes(`JWT token found in ${ENV}`))).toBe(true);
    expect(result.details.some((d) => d.message.startsWith('JWT token expires on'))).toBe(true);
  });

  it('warns when the token expires within 7 days', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3; // +3 days
    process.env[ENV] = fakeJwt(exp);
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(true); // near-expiry is a warn, not a failure
    expect(result.details.some((d) => d.status === 'warn' && d.message.includes('expires in'))).toBe(true);
  });

  it('errors (success=false) when the token is already expired', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    process.env[ENV] = fakeJwt(exp);
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(false);
    expect(result.details.some((d) => d.status === 'error' && d.message.includes('expired on'))).toBe(true);
  });

  it('reports info when the token has no expiration field', async () => {
    process.env[ENV] = fakeJwt(undefined);
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(true);
    expect(result.details.some((d) => d.message === 'JWT token has no expiration date')).toBe(true);
  });

  it('falls back to the credential store when env is empty', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    h.retrieveJWTMock.mockResolvedValue({ token: fakeJwt(exp) });
    const result = await new JWTAuthCheck().run();
    expect(result.success).toBe(true);
    expect(result.details.some((d) => d.message === 'JWT token found in credential store')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('AgentsCheck', () => {
  it('reports info when no agents are installed', async () => {
    h.getInstalledAgentsMock.mockResolvedValue([]);
    const result = await new AgentsCheck().run();
    expect(result.name).toBe('Installed Agents');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { status: 'info', message: 'No agents installed (CodeMie Code is built-in)' },
    ]);
  });

  it('lists installed agents with versions (ok)', async () => {
    h.getInstalledAgentsMock.mockResolvedValue([
      { displayName: 'Claude Code', getVersion: async () => '1.2.3' },
      { displayName: 'Codex', getVersion: async () => null },
    ]);
    const result = await new AgentsCheck().run();
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { status: 'ok', message: 'Claude Code (1.2.3)' },
      { status: 'ok', message: 'Codex' },
    ]);
  });

  it('warns for agents installed via the deprecated npm method', async () => {
    h.getInstalledAgentsMock.mockResolvedValue([
      {
        displayName: 'Claude Code',
        getVersion: async () => '1.0.0',
        getInstallationMethod: async () => 'npm',
      },
    ]);
    const result = await new AgentsCheck().run();
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toContain('installed via npm (deprecated');
  });

  it('runWithItemDisplay emits start + display callbacks per agent', async () => {
    h.getInstalledAgentsMock.mockResolvedValue([
      { displayName: 'Gemini', getVersion: async () => '2.0.0' },
    ]);
    const started: string[] = [];
    const displayed: unknown[] = [];
    const result = await new AgentsCheck().runWithItemDisplay(
      (n) => started.push(n),
      (d) => displayed.push(d),
    );
    expect(started).toEqual(['Checking Gemini...']);
    expect(displayed).toEqual([{ status: 'ok', message: 'Gemini (2.0.0)' }]);
    expect(result.details).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('AIConfigCheck', () => {
  it('errors when no profiles exist', async () => {
    h.listProfilesMock.mockResolvedValue([]);
    const result = await new AIConfigCheck().run();
    expect(result.name).toBe('Active Profile');
    expect(result.success).toBe(false);
    expect(result.details).toEqual([
      { status: 'error', message: 'No configuration found', hint: 'Run: codemie setup' },
    ]);
  });

  it('passes with a fully configured non-SSO provider that requires auth', async () => {
    h.listProfilesMock.mockResolvedValue([{ name: 'default', active: true }]);
    h.getActiveProfileNameMock.mockResolvedValue('default');
    h.loadMock.mockResolvedValue({
      provider: 'litellm',
      baseUrl: 'https://llm.example.com',
      apiKey: 'test-key-not-a-real-secret',
      model: 'claude-sonnet',
    });
    h.getProviderMock.mockReturnValue({ requiresAuth: true, authType: 'api-key' });

    const result = await new AIConfigCheck().run();
    expect(result.success).toBe(true);
    const messages = result.details.map((d) => d.message);
    expect(messages).toContain('Active Profile: default');
    expect(messages).toContain('Provider: litellm');
    expect(messages).toContain('Base URL: https://llm.example.com');
    expect(messages).toContain('Model: claude-sonnet');
    // API key is masked, never shown in full.
    const apiKeyDetail = result.details.find((d) => d.message.startsWith('API Key:'));
    expect(apiKeyDetail?.message).toContain('***');
    expect(apiKeyDetail?.message).not.toContain('not-a-real-secret');
  });

  it('shows CodeMie URL (not base URL) for SSO providers and skips API-key requirement', async () => {
    h.listProfilesMock.mockResolvedValue([{ name: 'sso', active: true }]);
    h.getActiveProfileNameMock.mockResolvedValue('sso');
    h.loadMock.mockResolvedValue({
      provider: 'ai-run-sso',
      codeMieUrl: 'https://codemie.example.com',
      model: 'claude-sonnet',
    });
    h.getProviderMock.mockReturnValue({ requiresAuth: true, authType: 'sso' });

    const result = await new AIConfigCheck().run();
    expect(result.success).toBe(true);
    const messages = result.details.map((d) => d.message);
    expect(messages).toContain('CodeMie URL: https://codemie.example.com');
    expect(messages.some((m) => m.startsWith('Base URL'))).toBe(false);
    expect(messages.some((m) => m.startsWith('API Key'))).toBe(false);
  });

  it('produces a consolidated error listing missing fields', async () => {
    h.listProfilesMock.mockResolvedValue([{ name: 'partial', active: true }]);
    h.getActiveProfileNameMock.mockResolvedValue('partial');
    h.loadMock.mockResolvedValue({ provider: 'litellm', baseUrl: 'https://x' }); // no model
    h.getProviderMock.mockReturnValue({ requiresAuth: false, authType: 'api-key' });

    const result = await new AIConfigCheck().run();
    expect(result.success).toBe(false);
    const errorDetail = result.details.find((d) => d.status === 'error');
    expect(errorDetail?.message).toContain('Missing configuration');
    expect(errorDetail?.message).toContain('Model');
  });

  it('catches load errors and reports a configuration error', async () => {
    h.listProfilesMock.mockResolvedValue([{ name: 'x', active: true }]);
    h.getActiveProfileNameMock.mockResolvedValue('x');
    h.loadMock.mockRejectedValue(new Error('disk boom'));
    const result = await new AIConfigCheck().run();
    expect(result.success).toBe(false);
    expect(result.details[0].status).toBe('error');
    expect(result.details[0].message).toContain('Configuration error: disk boom');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('WorkflowsCheck', () => {
  it('reports info when not a git repository', async () => {
    h.detectVCSMock.mockReturnValue({ isGitRepo: false });
    const result = await new WorkflowsCheck().run();
    expect(result.name).toBe('Repository & Workflows');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ status: 'info', message: 'Not a git repository' }]);
  });

  it('lists provider, remote and installed workflows for a git repo', async () => {
    h.detectVCSMock.mockReturnValue({
      isGitRepo: true,
      provider: 'github',
      remoteUrl: 'git@github.com:acme/repo.git',
    });
    h.listWorkflowsMock.mockReturnValue(['/path/.github/workflows/ci.yml']);
    const result = await new WorkflowsCheck().run();
    const messages = result.details.map((d) => d.message);
    expect(messages).toContain('Git repository detected');
    expect(messages).toContain('Provider: github');
    expect(messages).toContain('Remote: git@github.com:acme/repo.git');
    expect(messages).toContain('1 workflow(s) installed');
    expect(messages.some((m) => m.includes('ci.yml'))).toBe(true);
    expect(h.listWorkflowsMock).toHaveBeenCalledWith('github');
  });

  it('reports "no workflows installed" hint when none are present', async () => {
    h.detectVCSMock.mockReturnValue({ isGitRepo: true, provider: 'gitlab' });
    h.listWorkflowsMock.mockReturnValue([]);
    const result = await new WorkflowsCheck().run();
    const noWorkflows = result.details.find((d) => d.message === 'No workflows installed');
    expect(noWorkflows?.status).toBe('info');
    expect(noWorkflows?.hint).toContain('codemie workflow install');
  });

  it('warns when a git repo has no detected VCS provider', async () => {
    h.detectVCSMock.mockReturnValue({ isGitRepo: true, provider: undefined });
    const result = await new WorkflowsCheck().run();
    expect(result.details.some((d) => d.status === 'warn' && d.message === 'VCS provider not detected')).toBe(true);
    expect(h.listWorkflowsMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
describe('FrameworksCheck', () => {
  const framework = (displayName: string, installed: boolean, version: string | null) => ({
    metadata: { displayName },
    isInstalled: async () => installed,
    getVersion: async () => version,
  });

  it('reports info when no frameworks are registered', async () => {
    h.getAllFrameworksMock.mockReturnValue([]);
    const result = await new FrameworksCheck().run();
    expect(result.name).toBe('Frameworks');
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ status: 'info', message: 'No frameworks registered' }]);
  });

  it('marks installed frameworks ok (with version) and uninstalled as info', async () => {
    h.getAllFrameworksMock.mockReturnValue([
      framework('LangGraph', true, '0.9.1'),
      framework('CrewAI', false, null),
    ]);
    const result = await new FrameworksCheck().run();
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { status: 'ok', message: 'LangGraph (0.9.1)' },
      { status: 'info', message: 'CrewAI - not installed' },
    ]);
  });

  it('returns an error result when a framework probe throws', async () => {
    h.getAllFrameworksMock.mockReturnValue([
      {
        metadata: { displayName: 'Broken' },
        isInstalled: async () => {
          throw new Error('probe failed');
        },
        getVersion: async () => null,
      },
    ]);
    const result = await new FrameworksCheck().run();
    expect(result.success).toBe(false);
    expect(result.details[0].status).toBe('error');
    expect(result.details[0].message).toContain('Failed to check frameworks: probe failed');
  });

  it('runWithItemDisplay streams a start + display per framework', async () => {
    h.getAllFrameworksMock.mockReturnValue([framework('LangGraph', true, '1.0.0')]);
    const started: string[] = [];
    const displayed: unknown[] = [];
    const result = await new FrameworksCheck().runWithItemDisplay(
      (n) => started.push(n),
      (d) => displayed.push(d),
    );
    expect(started).toEqual(['Checking LangGraph...']);
    expect(displayed).toEqual([{ status: 'ok', message: 'LangGraph (1.0.0)' }]);
    expect(result.details).toHaveLength(1);
  });
});
