import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrompt, mockGetCredentials } = vi.hoisted(() => ({
  mockPrompt: vi.fn(),
  mockGetCredentials: vi.fn(),
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
    getAllProviders: () => [],
    getProvider: () => undefined,
    getSetupSteps: () => ({ getCredentials: mockGetCredentials }),
  },
}));
vi.mock('@/providers/integration/setup-ui.js', () => ({
  getAllProviderChoices: () => [],
  getAllModelChoices: () => [],
  displaySetupSuccess: () => undefined,
  displaySetupError: () => undefined,
}));
vi.mock('@/agents/registry.js', () => ({ AgentRegistry: { getAgent: () => undefined } }));

import { createSetupCommand } from '../setup.js';

async function runSetup(args: string[]): Promise<void> {
  await createSetupCommand().parseAsync(args, { from: 'user' });
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
});
