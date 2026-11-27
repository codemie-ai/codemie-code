import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { mockEnsure, mockStatus, mockLogin, mockPrompt } = vi.hoisted(() => ({
  mockEnsure: vi.fn(),
  mockStatus: vi.fn(),
  mockLogin: vi.fn(),
  mockPrompt: vi.fn(),
}));

vi.mock('../anthropic-subscription.auth.js', () => ({
  ensureClaudeCliAvailable: mockEnsure,
  getClaudeAuthStatus: mockStatus,
  runClaudeBrowserLogin: mockLogin,
}));
vi.mock('inquirer', () => ({ default: { prompt: mockPrompt } }));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AnthropicSubscriptionSetupSteps } from '../anthropic-subscription.setup-steps.js';

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('AnthropicSubscriptionSetupSteps headless login', () => {
  let out: string;
  beforeEach(() => {
    vi.clearAllMocks();
    out = '';
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
    mockEnsure.mockResolvedValue(undefined);
    mockPrompt.mockResolvedValue({ enableCodeMieAnalytics: false });
    setTTY(true);
  });
  afterEach(() => setTTY(false));

  it('prints both routes and runs claude auth login interactively when not logged in', async () => {
    mockStatus
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({ loggedIn: true, authMethod: 'claude.ai' });

    await AnthropicSubscriptionSetupSteps.getCredentials(false, { headless: true });

    expect(out).toContain('claude auth login');
    expect(out).toContain('claude setup-token');
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('skips login when already logged in via an oauth token', async () => {
    mockStatus.mockResolvedValue({ loggedIn: true, authMethod: 'oauth_token' });

    await AnthropicSubscriptionSetupSteps.getCredentials(false, { headless: true });

    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('fails fast with a clear error without a TTY', async () => {
    setTTY(false);
    mockStatus.mockResolvedValue({ loggedIn: false });

    await expect(
      AnthropicSubscriptionSetupSteps.getCredentials(false, { headless: true })
    ).rejects.toThrow(/interactive terminal/);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('final-status error mentions both routes, with or without the flag', async () => {
    mockStatus.mockResolvedValue({ loggedIn: false });
    setTTY(true);

    for (const options of [undefined, { headless: true }]) {
      const err = await AnthropicSubscriptionSetupSteps.getCredentials(false, options).catch((e: Error) => e);
      expect((err as Error).message).toContain('claude auth login');
      expect((err as Error).message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    }
  });

  it('names both routes when the headless TTY check fails', async () => {
    setTTY(false);
    mockStatus.mockResolvedValue({ loggedIn: false });

    const err = await AnthropicSubscriptionSetupSteps.getCredentials(false, { headless: true }).catch((e: Error) => e);

    expect((err as Error).message).toContain('claude auth login');
    expect((err as Error).message).toContain('claude setup-token');
    expect((err as Error).message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('names both routes when the headless login does not complete', async () => {
    mockStatus.mockResolvedValue({ loggedIn: false });
    mockLogin.mockRejectedValueOnce(new Error('Command timed out after 300000ms'));

    const err = await AnthropicSubscriptionSetupSteps.getCredentials(false, { headless: true }).catch((e: Error) => e);

    expect((err as Error).message).toContain('claude auth login');
    expect((err as Error).message).toContain('claude setup-token');
    expect((err as Error).message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect((err as Error).message).not.toContain('timed out');
  });

  it('keeps the browser path unchanged without the flag', async () => {
    mockStatus
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({ loggedIn: true, authMethod: 'claude.ai' });

    await AnthropicSubscriptionSetupSteps.getCredentials(false);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('claude setup-token');
  });
});
