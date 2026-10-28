import { describe, it, expect, vi, beforeEach } from 'vitest';

const readJsonFileMock = vi.fn();
const readOrgMock = vi.fn();
const loadHookConfigMock = vi.fn();

vi.mock('../event-fields/session-env-fields.js', () => ({ readJsonFile: readJsonFileMock, resolveSessionEnvFields: vi.fn() }));
vi.mock('../event-fields/claude-org.js', () => ({ readClaudeOrganization: readOrgMock }));
vi.mock('@/agents/core/event-fields/identity-fields.js', () => ({ loadHookConfig: loadHookConfigMock }));
vi.mock('@/providers/index.js', () => ({
  ProviderRegistry: { getProvider: (n: string) => ({ authType: n === 'ai-run-sso' ? 'sso' : 'api-key' }) },
}));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const GATEWAY = 'https://llm-gateway.example.com';

describe('ClaudeCodeOtlpPlugin.resolveEvidenceInputs', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const call = () =>
    (plugin as unknown as { resolveEvidenceInputs: (c: { cwd: string }) => Promise<{ organization?: string; routing: unknown }> })
      .resolveEvidenceInputs({ cwd: '/x' });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CODEMIE_SESSION_ID'];
    delete process.env['ANTHROPIC_BASE_URL'];
    readOrgMock.mockResolvedValue('Acme');
    loadHookConfigMock.mockResolvedValue({ config: { provider: 'ai-run-sso', baseUrl: GATEWAY }, configDir: '/x' });
  });

  it('native with the settings.json endpoint on the configured gateway is routed and proven; org passes through', async () => {
    readJsonFileMock.mockResolvedValue({ env: { ANTHROPIC_BASE_URL: GATEWAY } });
    expect(await call()).toEqual({ organization: 'Acme', routing: { routed: true, routing_proof: 'proven' } });
  });

  it('an unmatched endpoint is unproven, never routed', async () => {
    readJsonFileMock.mockResolvedValue({ env: { ANTHROPIC_BASE_URL: 'https://other.example.net' } });
    expect((await call()).routing).toEqual({ routed: false, routing_proof: 'unproven' });
  });

  it('an unreadable settings.json does not throw', async () => {
    readJsonFileMock.mockResolvedValue(null);
    expect((await call()).routing).toMatchObject({ routed: false });
  });
});
