import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrompt, mockGetCredentials, mockGetAllProviderChoices, PROVIDERS } = vi.hoisted(() => ({
  mockPrompt: vi.fn(),
  mockGetCredentials: vi.fn(),
  mockGetAllProviderChoices: vi.fn(),
  PROVIDERS: [
    { name: 'ai-run-sso', displayName: 'CodeMie SSO' },
    { name: 'moonshot-subscription', displayName: 'Moonshot Subscription' },
  ],
}));

vi.mock('inquirer', () => ({ default: { prompt: mockPrompt } }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    hasGlobalConfig: async () => false,
    hasLocalConfig: async () => false,
  },
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/cli/first-time.js', () => ({
  FirstTimeExperience: { showEcosystemIntro: () => undefined },
}));
vi.mock('@/providers/index.js', () => ({
  ProviderRegistry: {
    getAllProviders: () => PROVIDERS,
    getProvider: () => undefined,
    getSetupSteps: () => ({ getCredentials: mockGetCredentials }),
  },
}));
vi.mock('@/providers/integration/setup-ui.js', () => ({
  getAllProviderChoices: (providers: unknown[]) => mockGetAllProviderChoices(providers),
  getAllModelChoices: () => [],
  displaySetupSuccess: () => undefined,
  displaySetupError: () => undefined,
}));
vi.mock('@/agents/registry.js', () => ({ AgentRegistry: { getAgent: () => undefined } }));

import { createSetupCommand } from '../setup.js';

async function runSetup(args: string[]): Promise<void> {
  await createSetupCommand().parseAsync(args, { from: 'user' });
}

/** Names of the providers the setup wizard offered in its provider list. */
function offeredProviderNames(): string[] {
  const call = mockGetAllProviderChoices.mock.calls[0];
  return (call[0] as Array<{ name: string }>).map(p => p.name);
}

describe('codemie setup --no-browser wiring', () => {
  beforeEach(() => {
    mockPrompt.mockReset();
    mockPrompt
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ provider: 'ai-run-sso' });
    mockGetCredentials.mockReset();
    // Stop the wizard right after the credential step: the wiring is all these tests need
    mockGetCredentials.mockRejectedValue(new Error('stop after credentials'));
    mockGetAllProviderChoices.mockReset();
    mockGetAllProviderChoices.mockImplementation((providers: Array<{ name: string; displayName: string }>) =>
      providers.map(p => ({ name: p.displayName, value: p.name }))
    );
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the SSO credential step to run headless with --no-browser', async () => {
    await runSetup(['--no-browser']);
    expect(mockGetCredentials).toHaveBeenCalledWith(false, { headless: true });
  });

  it('asks for headless with the --headless alias', async () => {
    await runSetup(['--headless']);
    expect(mockGetCredentials).toHaveBeenCalledWith(false, { headless: true });
  });

  it('keeps the browser path when no flag is given', async () => {
    await runSetup([]);
    expect(mockGetCredentials).toHaveBeenCalledWith(false);
  });

  it('hides Moonshot Subscription from the provider list with --no-browser', async () => {
    await runSetup(['--no-browser']);
    const offered = offeredProviderNames();
    expect(offered).toContain('ai-run-sso');
    expect(offered).not.toContain('moonshot-subscription');
  });

  it('still offers Moonshot Subscription in the provider list without the flag', async () => {
    await runSetup([]);
    const offered = offeredProviderNames();
    expect(offered).toContain('ai-run-sso');
    expect(offered).toContain('moonshot-subscription');
  });
});
