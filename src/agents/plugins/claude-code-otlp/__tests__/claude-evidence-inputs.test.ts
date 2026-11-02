import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readSettingsMock = vi.fn();
const readOrgMock = vi.fn();
const loadHookConfigMock = vi.fn();
const getProviderMock = vi.fn();

vi.mock('../event-fields/claude-settings-env.js', () => ({ readClaudeSettingsEnv: readSettingsMock }));
vi.mock('../event-fields/claude-org.js', () => ({ readClaudeOrganization: readOrgMock }));
vi.mock('@/agents/core/event-fields/identity-fields.js', () => ({ loadHookConfig: loadHookConfigMock }));
vi.mock('@/providers/index.js', () => ({ ProviderRegistry: { getProvider: getProviderMock } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const GATEWAY = 'https://llm-gateway.example.com';
const PROVEN_ROUTED = { routed: true, routing_proof: 'proven' };
const PROVEN_DIRECT = { routed: false, routing_proof: 'proven' };
const UNPROVEN = { routed: false, routing_proof: 'unproven' };

describe('ClaudeCodeOtlpPlugin.extractHookContext', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const call = async () => {
    const context = await (plugin as unknown as {
      extractHookContext: (input: { cwd: string; session_id: string }) => Promise<{ evidenceInputs: { organization?: string; routing: unknown } }>;
    }).extractHookContext({ cwd: '/x', session_id: 's1' });
    return context.evidenceInputs;
  };
  const settings = (env: Record<string, unknown>, complete = true) => readSettingsMock.mockResolvedValue({ env, complete });
  const profile = (provider: string, authType: string, extra: Record<string, unknown> = {}) => {
    getProviderMock.mockReturnValue({ authType });
    loadHookConfigMock.mockResolvedValue({ config: { provider, baseUrl: GATEWAY, ...extra }, configDir: '/x' });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CODEMIE_SESSION_ID'];
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[k];
    readOrgMock.mockResolvedValue('Acme');
    settings({});
    profile('ai-run-sso', 'sso');
  });

  it('reads settings for the hook cwd; native with the settings.json endpoint on the gateway is routed and proven; a gateway session is not paid by the saved login', async () => {
    settings({ ANTHROPIC_BASE_URL: GATEWAY });
    expect(await call()).toEqual({ organization: undefined, routing: PROVEN_ROUTED });
    expect(readSettingsMock).toHaveBeenCalledWith('/x');
  });

  describe('organization only when the saved OAuth login is what pays (review finding 2)', () => {
    afterEach(() => {
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[k];
    });

    it('a direct first-party session passes the organization through', async () => {
      expect((await call()).organization).toBe('Acme');
      settings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
      expect((await call()).organization).toBe('Acme');
    });

    it.each([
      ['process ANTHROPIC_API_KEY', () => { process.env.ANTHROPIC_API_KEY = 'k'; }],
      ['process ANTHROPIC_AUTH_TOKEN', () => { process.env.ANTHROPIC_AUTH_TOKEN = 'k'; }],
      ['process Bedrock flag', () => { process.env.CLAUDE_CODE_USE_BEDROCK = '1'; }],
      ['process Vertex flag', () => { process.env.CLAUDE_CODE_USE_VERTEX = 'true'; }],
      ['settings env API key', () => settings({ ANTHROPIC_API_KEY: 'k' })],
      ['settings env auth token', () => settings({ ANTHROPIC_AUTH_TOKEN: 'k' })],
      ['settings env Bedrock', () => settings({ CLAUDE_CODE_USE_BEDROCK: 'true' })],
      ['settings env Vertex', () => settings({ CLAUDE_CODE_USE_VERTEX: '1' })],
      ['settings env Foundry', () => settings({ CLAUDE_CODE_USE_FOUNDRY: '1' })],
      ['process Bedrock flag spelled yes', () => { process.env.CLAUDE_CODE_USE_BEDROCK = 'yes'; }],
      ['process Foundry flag', () => { process.env.CLAUDE_CODE_USE_FOUNDRY = 'on'; }],
      ['an apiKeyHelper (or forceLoginMethod console)', () => readSettingsMock.mockResolvedValue({ env: {}, complete: true, apiKeyHelper: true })],
      ['a non-CodeMie gateway', () => settings({ ANTHROPIC_BASE_URL: 'https://litellm.corp.example.net' })],
      ['an unreadable settings layer (ambiguous)', () => settings({}, false)],
      ['an empty settings value over a process key (ambiguous)', () => { process.env.ANTHROPIC_API_KEY = 'k'; settings({ ANTHROPIC_API_KEY: '' }); }],
    ])('%s: organization withheld', async (_name, arrange) => {
      arrange();
      expect((await call()).organization).toBeUndefined();
    });

    it('a Foundry session is never proven direct', async () => {
      process.env.CLAUDE_CODE_USE_FOUNDRY = '1';
      expect((await call()).routing).toEqual(UNPROVEN);
    });

    it('an API key does not change the routing verdict itself', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      expect((await call()).routing).toEqual(PROVEN_DIRECT);
    });
  });

  it('an unmatched endpoint is unproven, never routed', async () => {
    settings({ ANTHROPIC_BASE_URL: 'https://other.example.net' });
    expect((await call()).routing).toEqual(UNPROVEN);
  });

  it('no endpoint in complete settings is the direct default (proven)', async () => {
    expect((await call()).routing).toEqual(PROVEN_DIRECT);
  });

  it('an unreadable/malformed settings layer is unproven, not "no override" (CR-006)', async () => {
    settings({}, false);
    expect((await call()).routing).toEqual(UNPROVEN);
  });

  describe('codemieProvider derivation (CR-007)', () => {
    it('authType api-key with authMethod jwt on the gateway is routed and proven', async () => {
      profile('bearer-auth', 'api-key', { authMethod: 'jwt' });
      settings({ ANTHROPIC_BASE_URL: GATEWAY });
      expect((await call()).routing).toEqual(PROVEN_ROUTED);
    });

    it('authType api-key without jwt is not CodeMie-routed even on the gateway URL', async () => {
      profile('litellm', 'api-key');
      settings({ ANTHROPIC_BASE_URL: GATEWAY });
      expect((await call()).routing).toEqual(UNPROVEN);
    });

    it("authType 'none' with authMethod jwt is not routed (guard)", async () => {
      profile('ollama', 'none', { authMethod: 'jwt' });
      settings({ ANTHROPIC_BASE_URL: GATEWAY });
      expect((await call()).routing).toEqual(UNPROVEN);
    });

    it('an unloadable profile is not CodeMie-routed', async () => {
      loadHookConfigMock.mockResolvedValue(undefined);
      settings({ ANTHROPIC_BASE_URL: GATEWAY });
      expect((await call()).routing).toEqual(UNPROVEN);
    });
  });
});
