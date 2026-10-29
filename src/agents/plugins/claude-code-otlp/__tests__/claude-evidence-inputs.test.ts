import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('ClaudeCodeOtlpPlugin.resolveEvidenceInputs', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const call = () =>
    (plugin as unknown as { resolveEvidenceInputs: (c: { cwd: string }) => Promise<{ organization?: string; routing: unknown }> })
      .resolveEvidenceInputs({ cwd: '/x' });
  const settings = (env: Record<string, unknown>, complete = true) => readSettingsMock.mockResolvedValue({ env, complete });
  const profile = (provider: string, authType: string, extra: Record<string, unknown> = {}) => {
    getProviderMock.mockReturnValue({ authType });
    loadHookConfigMock.mockResolvedValue({ config: { provider, baseUrl: GATEWAY, ...extra }, configDir: '/x' });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CODEMIE_SESSION_ID'];
    delete process.env['ANTHROPIC_BASE_URL'];
    readOrgMock.mockResolvedValue('Acme');
    settings({});
    profile('ai-run-sso', 'sso');
  });

  it('reads settings for the hook cwd; native with the settings.json endpoint on the gateway is routed and proven; org passes through', async () => {
    settings({ ANTHROPIC_BASE_URL: GATEWAY });
    expect(await call()).toEqual({ organization: 'Acme', routing: PROVEN_ROUTED });
    expect(readSettingsMock).toHaveBeenCalledWith('/x');
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
