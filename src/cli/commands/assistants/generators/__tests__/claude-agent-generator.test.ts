/**
 * Unit tests for Claude subagent generator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { Assistant } from 'codemie-sdk';

// Mock dependencies before importing
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn()
  }
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test')
  }
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn()
  }
}));

// Import after mocks
const {
  createClaudeSubagentMetadata,
  createClaudeSubagentContent,
  registerClaudeSubagent,
  unregisterClaudeSubagent
} = await import('../claude-agent-generator.js');

describe('Claude Subagent Generator', () => {
  const mockAssistant: Assistant = {
    id: 'test-assistant-123',
    name: 'Test Assistant',
    slug: 'test-assistant',
    description: 'A helpful test assistant',
    system_prompt: 'You are a test assistant',
    llm_model_type: 'claude-3-sonnet',
  } as Assistant;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createClaudeSubagentMetadata', () => {
    it('should generate valid YAML frontmatter', () => {
      const result = createClaudeSubagentMetadata(mockAssistant);

      expect(result).toContain('---');
      expect(result).toContain('name: test-assistant');
      expect(result).toContain('description: A helpful test assistant');
      expect(result).toContain('tools: Read, Bash');
      expect(result).toContain('model: inherit');
    });

    it('should use assistant slug as name', () => {
      const assistant = {
        ...mockAssistant,
        slug: 'custom-slug'
      } as Assistant;

      const result = createClaudeSubagentMetadata(assistant);

      expect(result).toContain('name: custom-slug');
    });
  });

  describe('createClaudeSubagentContent', () => {
    it('should include frontmatter', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('---');
      expect(result).toContain('name: test-assistant');
    });

    it('should include assistant name as heading', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('# Test Assistant');
    });

    it('should include description', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('A helpful test assistant');
    });

    it('should include instructions section', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('## Instructions');
      expect(result).toContain('When invoked:');
      expect(result).toContain('Extract the user\'s message');
      expect(result).toContain('Execute the command');
      expect(result).toContain('Return the response');
    });

    it('should include correct bash command with assistant ID', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('codemie assistants chat "test-assistant-123" "$USER_MESSAGE"');
    });

    it('should include example section', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('## Example');
      expect(result).toContain('User: "Help me review this code"');
      expect(result).toContain('codemie assistants chat "test-assistant-123" "Help me review this code"');
    });

    it('should include explanation about codemie assistants chat', () => {
      const result = createClaudeSubagentContent(mockAssistant);

      expect(result).toContain('The `codemie assistants chat` command communicates with the CodeMie platform');
    });
  });

  describe('registerClaudeSubagent', () => {
    it('should create ~/.claude/agents directory', async () => {
      await registerClaudeSubagent(mockAssistant);

      expect(fs.mkdir).toHaveBeenCalledWith(
        '/home/test/.claude/agents',
        { recursive: true }
      );
    });

    it('should write subagent file with correct path', async () => {
      await registerClaudeSubagent(mockAssistant);

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/home/test/.claude/agents/test-assistant.md',
        expect.any(String),
        'utf-8'
      );
    });

    it('should write complete subagent content', async () => {
      await registerClaudeSubagent(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('---');
      expect(content).toContain('name: test-assistant');
      expect(content).toContain('# Test Assistant');
      expect(content).toContain('## Instructions');
      expect(content).toContain('codemie assistants chat "test-assistant-123"');
    });

    it('should use custom slug in filename', async () => {
      const assistant = {
        ...mockAssistant,
        slug: 'my-custom-slug'
      };

      await registerClaudeSubagent(assistant);

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/home/test/.claude/agents/my-custom-slug.md',
        expect.any(String),
        'utf-8'
      );
    });

    it('should work with different home directories', async () => {
      (os.homedir as any).mockReturnValueOnce('/Users/testuser');

      await registerClaudeSubagent(mockAssistant);

      expect(fs.mkdir).toHaveBeenCalledWith(
        '/Users/testuser/.claude/agents',
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/Users/testuser/.claude/agents/test-assistant.md',
        expect.any(String),
        'utf-8'
      );
    });
  });

  describe('unregisterClaudeSubagent', () => {
    it('should remove subagent file with correct path', async () => {
      await unregisterClaudeSubagent('test-assistant');

      expect(fs.unlink).toHaveBeenCalledWith(
        '/home/test/.claude/agents/test-assistant.md'
      );
    });

    it('should handle removal errors gracefully', async () => {
      const error = new Error('File not found');
      (fs.unlink as any).mockRejectedValueOnce(error);

      // Should not throw
      await expect(unregisterClaudeSubagent('test-assistant')).resolves.toBeUndefined();
    });

    it('should work with custom slug', async () => {
      await unregisterClaudeSubagent('my-custom-slug');

      expect(fs.unlink).toHaveBeenCalledWith(
        '/home/test/.claude/agents/my-custom-slug.md'
      );
    });

    it('should work with different home directories', async () => {
      (os.homedir as any).mockReturnValueOnce('/Users/testuser');

      await unregisterClaudeSubagent('test-assistant');

      expect(fs.unlink).toHaveBeenCalledWith(
        '/Users/testuser/.claude/agents/test-assistant.md'
      );
    });
  });

  describe('File Path Generation', () => {
    it('should generate consistent paths for register and unregister', async () => {
      await registerClaudeSubagent(mockAssistant);
      const registerPath = (fs.writeFile as any).mock.calls[0][0];

      await unregisterClaudeSubagent(mockAssistant.slug!);
      const unregisterPath = (fs.unlink as any).mock.calls[0][0];

      expect(registerPath).toBe(unregisterPath);
    });

    it('should use .md extension for subagent files', async () => {
      await registerClaudeSubagent(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      expect(writeCall[0]).toMatch(/\.md$/);
    });

    it('should place files in .claude/agents directory', async () => {
      await registerClaudeSubagent(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      expect(writeCall[0]).toContain('/.claude/agents/');
    });
  });

  describe('Content Formatting', () => {
    it('should not have leading/trailing whitespace in content', () => {
      const content = createClaudeSubagentContent(mockAssistant);

      expect(content).not.toMatch(/^\s+/);
      expect(content).not.toMatch(/\s+$/);
    });

    it('should have consistent line breaks', () => {
      const content = createClaudeSubagentContent(mockAssistant);

      // Should not have more than 2 consecutive newlines
      expect(content).not.toMatch(/\n{3,}/);
    });

    it('should properly escape special characters in bash commands', () => {
      const content = createClaudeSubagentContent(mockAssistant);

      // Check that $USER_MESSAGE is used (not escaped, as it should be a variable)
      expect(content).toContain('$USER_MESSAGE');
    });
  });
});
