/**
 * Unit tests for skill command — createRunCommand
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SkillDetail } from 'codemie-sdk';
import { NotFoundError, ApiError } from 'codemie-sdk';
import { ConfigLoader } from '../../../utils/config.js';
import { getAuthenticatedClient, handleAuthError } from '../../../utils/auth.js';
import { formatErrorForUser } from '../../../utils/errors.js';
import { createSkillCommand } from '../skill.js';

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
  },
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn(),
  promptReauthentication: vi.fn(),
  handleAuthError: vi.fn(),
}));

vi.mock('@/utils/errors.js', () => ({
  createErrorContext: vi.fn((err: unknown) => ({ error: err, message: String(err) })),
  formatErrorForUser: vi.fn(() => 'Formatted error message'),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function getRunCommand() {
  const skillCommand = createSkillCommand();
  const runCmd = skillCommand.commands.find(c => c.name() === 'run');
  if (!runCmd) throw new Error('run subcommand not found on skill command');
  return runCmd;
}

/**
 * Invoke `codemie skill run <args>`.
 * process.exit is mocked to throw so execution stops at the call site,
 * matching real CLI behaviour. The thrown error is swallowed here so
 * callers don't need to handle it.
 */
async function invokeRun(args: string[]): Promise<void> {
  const skillCommand = createSkillCommand();
  try {
    // { from: 'user' } — no argv stripping; 'run' is routed as the subcommand name
    await skillCommand.parseAsync(['run', ...args], { from: 'user' });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('process.exit:')) {
      return;
    }
    throw err;
  }
}

describe('skill run command', () => {
  let mockClient: {
    skills: { get: ReturnType<typeof vi.fn> };
    assistants: { askVirtual: ReturnType<typeof vi.fn> };
  };
  let mockSkill: SkillDetail;
  let mockConfig: object;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockConfig = { apiUrl: 'https://api.example.com' };

    mockSkill = {
      id: 'skill-abc-123',
      name: 'Test Skill',
      description: 'A test skill',
      content: 'You are a test assistant.',
      toolkits: [],
      mcp_servers: [],
      skills: [],
    } as unknown as SkillDetail;

    mockClient = {
      skills: { get: vi.fn().mockResolvedValue(mockSkill) },
      assistants: {
        askVirtual: vi.fn().mockResolvedValue({ generated: 'Hello from virtual assistant', success: true }),
      },
    };

    vi.mocked(ConfigLoader.load).mockResolvedValue(mockConfig as any);
    vi.mocked(getAuthenticatedClient).mockResolvedValue(mockClient as any);
    vi.mocked(handleAuthError).mockResolvedValue(false);

    // Throw on process.exit so code after exit() never runs (mirrors real behaviour)
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as any);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    processExitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('command structure', () => {
    it('should be registered as "run" subcommand under "skill"', () => {
      expect(getRunCommand().name()).toBe('run');
    });

    it('should require a <skill-id> positional argument', () => {
      const skillIdArg = getRunCommand().registeredArguments.find(a => a.name() === 'skill-id');
      expect(skillIdArg).toBeDefined();
      expect(skillIdArg?.required).toBe(true);
    });

    it('should have an optional [message] positional argument', () => {
      const messageArg = getRunCommand().registeredArguments.find(a => a.name() === 'message');
      expect(messageArg).toBeDefined();
      expect(messageArg?.required).toBe(false);
    });

    it('should have a --verbose option', () => {
      expect(getRunCommand().options.some(o => o.long === '--verbose')).toBe(true);
    });

    it('should have a --conversation-id option', () => {
      expect(getRunCommand().options.some(o => o.long === '--conversation-id')).toBe(true);
    });
  });

  describe('happy path', () => {
    it('should fetch skill by ID', async () => {
      await invokeRun(['skill-abc-123', 'hello']);

      expect(mockClient.skills.get).toHaveBeenCalledWith('skill-abc-123');
    });

    it('should call askVirtual with extracted assistant params and message', async () => {
      await invokeRun(['skill-abc-123', 'hello']);

      expect(mockClient.assistants.askVirtual).toHaveBeenCalledWith(
        expect.objectContaining({
          system_prompt: 'You are a test assistant.',
          toolkits: [],
          mcp_servers: [],
          text: 'hello',
          stream: false,
        })
      );
    });

    it('should print response.generated to stdout', async () => {
      await invokeRun(['skill-abc-123', 'hello']);

      expect(consoleLogSpy).toHaveBeenCalledWith('Hello from virtual assistant');
    });

    it('should print empty string when response.generated is null', async () => {
      mockClient.assistants.askVirtual.mockResolvedValue({ generated: null, success: true });

      await invokeRun(['skill-abc-123', 'hello']);

      expect(consoleLogSpy).toHaveBeenCalledWith('');
    });

    it('should pass conversation_id option to askVirtual when provided', async () => {
      await invokeRun(['skill-abc-123', 'hello', '--conversation-id', 'conv-xyz']);

      expect(mockClient.assistants.askVirtual).toHaveBeenCalledWith(
        expect.objectContaining({ conversation_id: 'conv-xyz' })
      );
    });
  });

  describe('empty message', () => {
    it('should print error and exit 1', async () => {
      await invokeRun(['skill-abc-123', '']);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Message is required');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should not call skills.get', async () => {
      await invokeRun(['skill-abc-123', '']);

      expect(mockClient.skills.get).not.toHaveBeenCalled();
    });
  });

  describe('404 skill not found', () => {
    it('should print "Skill not found: <id>" and exit 1', async () => {
      mockClient.skills.get.mockRejectedValue(new NotFoundError('skill', 'unknown-skill-id'));

      await invokeRun(['unknown-skill-id', 'hello']);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Skill not found: unknown-skill-id');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should not call askVirtual', async () => {
      mockClient.skills.get.mockRejectedValue(new NotFoundError('skill', 'unknown-skill-id'));

      await invokeRun(['unknown-skill-id', 'hello']);

      expect(mockClient.assistants.askVirtual).not.toHaveBeenCalled();
    });
  });

  describe('authentication errors on skills.get', () => {
    it('should call handleAuthError and exit 1 on 401', async () => {
      mockClient.skills.get.mockRejectedValue(new ApiError('Unauthorized', 401));
      vi.mocked(handleAuthError).mockResolvedValue(true);

      await invokeRun(['skill-abc-123', 'hello']);

      expect(handleAuthError).toHaveBeenCalledWith(expect.any(ApiError), mockConfig);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should call handleAuthError and exit 1 on 403', async () => {
      mockClient.skills.get.mockRejectedValue(new ApiError('Forbidden', 403));
      vi.mocked(handleAuthError).mockResolvedValue(true);

      await invokeRun(['skill-abc-123', 'hello']);

      expect(handleAuthError).toHaveBeenCalledWith(expect.any(ApiError), mockConfig);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('authentication errors on askVirtual', () => {
    it('should call handleAuthError and exit 1 on 401', async () => {
      mockClient.assistants.askVirtual.mockRejectedValue(new ApiError('Unauthorized', 401));
      vi.mocked(handleAuthError).mockResolvedValue(true);

      await invokeRun(['skill-abc-123', 'hello']);

      expect(handleAuthError).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('other API errors on skills.get', () => {
    it('should print formatted error and exit 1', async () => {
      mockClient.skills.get.mockRejectedValue(new ApiError('Internal Server Error', 500));

      await invokeRun(['skill-abc-123', 'hello']);

      expect(formatErrorForUser).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Formatted error message');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('extractAssistantParams', () => {
    it('should map skill.content to system_prompt', async () => {
      mockClient.skills.get.mockResolvedValue(
        { ...mockSkill, content: 'Custom system prompt' } as unknown as SkillDetail
      );

      await invokeRun(['skill-abc-123', 'hello']);

      expect(mockClient.assistants.askVirtual).toHaveBeenCalledWith(
        expect.objectContaining({ system_prompt: 'Custom system prompt' })
      );
    });

    it('should map skill.toolkits and skill.mcp_servers', async () => {
      mockClient.skills.get.mockResolvedValue({
        ...mockSkill,
        toolkits: [{ toolkit: 'jira', tools: [] }],
        mcp_servers: [{ name: 'my-mcp', enabled: true }],
      } as unknown as SkillDetail);

      await invokeRun(['skill-abc-123', 'hello']);

      expect(mockClient.assistants.askVirtual).toHaveBeenCalledWith(
        expect.objectContaining({
          toolkits: [{ toolkit: 'jira', tools: [] }],
          mcp_servers: [{ name: 'my-mcp', enabled: true }],
        })
      );
    });
  });
});
