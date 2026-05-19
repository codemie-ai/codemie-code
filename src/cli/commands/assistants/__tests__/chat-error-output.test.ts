import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from 'codemie-sdk';

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn().mockResolvedValue({
      provider: 'sso',
      codemieAssistants: [
        {
          id: 'assistant-1',
          name: 'Confluence Expert',
          slug: 'confluence-expert'
        }
      ]
    })
  }
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({
    assistants: {
      chat: vi.fn().mockRejectedValue(new ApiError('', 500, {
        error: {
          detail: 'Confluence credential is missing'
        }
      }))
    }
  }),
  promptReauthentication: vi.fn()
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    fail: vi.fn()
  }))
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn()
      .mockResolvedValueOnce({ selectedId: 'assistant-1' })
      .mockResolvedValueOnce({ message: 'test connection to confluence' })
      .mockResolvedValueOnce({ message: '/exit' })
  }
}));

describe('assistants chat error output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints formatted API error details in interactive mode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { createAssistantsChatCommand } = await import('../chat/index.js');
    const command = createAssistantsChatCommand();

    await command.parseAsync(['node', 'codemie', 'chat']);

    const output = consoleError.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Confluence credential is missing');
  });
});
