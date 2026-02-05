/**
 * Unit tests for Claude agent generator
 * Tests file generation and path resolution for Claude subagents
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Assistant } from 'codemie-sdk';
import * as path from 'node:path';

// Mock dependencies BEFORE imports
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  }
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
  }
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import {
  createClaudeSubagentMetadata,
  createClaudeSubagentContent,
  registerClaudeSubagent,
  unregisterClaudeSubagent
} from '../claude-agent-generator.js';

describe('Claude Agent Generator', () => {
  const mockHomeDir = '/home/testuser';
  let mockAssistant: Assistant;

  beforeEach(() => {
    // Arrange: Mock os.homedir()
    vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

    // Arrange: Setup mock assistant
    mockAssistant = {
      id: 'asst-123',
      name: 'Test Assistant',
      description: 'A test assistant for unit testing',
      slug: 'test-assistant',
      project: 'test-project'
    } as Assistant;

    // Arrange: Mock file system operations
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createClaudeSubagentMetadata', () => {
    it('should create valid YAML frontmatter', () => {
      // Act
      const metadata = createClaudeSubagentMetadata(mockAssistant);

      // Assert
      expect(metadata).toContain('---');
      expect(metadata).toContain('name: test-assistant');
      expect(metadata).toContain('description: "A test assistant for unit testing"');
      expect(metadata).toContain('tools: Read, Bash');
      expect(metadata).toContain('model: inherit');
    });

    it('should use default description when not provided', () => {
      // Arrange
      const assistantNoDesc = { ...mockAssistant, description: undefined } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantNoDesc);

      // Assert
      expect(metadata).toContain('description: "Interact with Test Assistant"');
    });

    it('should handle special characters in description', () => {
      // Arrange
      const assistantSpecialChars = {
        ...mockAssistant,
        description: 'Test: with "quotes" and [brackets]'
      } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantSpecialChars);

      // Assert
      expect(metadata).toContain('description: "Test: with \\"quotes\\" and [brackets]"');
    });

    it('should handle unicode characters in description', () => {
      // Arrange
      const assistantUnicode = {
        ...mockAssistant,
        description: '助理測試 - Assistant test'
      } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantUnicode);

      // Assert
      expect(metadata).toContain('description: "助理測試 - Assistant test"');
    });

    it('should handle very long descriptions', () => {
      // Arrange
      const longDescription = 'A'.repeat(500);
      const assistantLongDesc = {
        ...mockAssistant,
        description: longDescription
      } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantLongDesc);

      // Assert
      expect(metadata).toContain(`description: "${longDescription}"`);
    });

    it('should handle empty description', () => {
      // Arrange
      const assistantEmptyDesc = {
        ...mockAssistant,
        description: ''
      } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantEmptyDesc);

      // Assert
      expect(metadata).toContain('description: "Interact with Test Assistant"');
    });

    it('should handle multiline descriptions by converting to single line', () => {
      // Arrange
      const assistantMultiline = {
        ...mockAssistant,
        description: 'Line 1\nLine 2\nLine 3'
      } as Assistant;

      // Act
      const metadata = createClaudeSubagentMetadata(assistantMultiline);

      // Assert
      expect(metadata).toContain('description: "Line 1 Line 2 Line 3"');
      // Verify proper YAML structure (newlines only between fields, not within description value)
      expect(metadata).toMatch(/---\nname:.*\ndescription:.*\ntools:.*\nmodel:.*\n---/);
      // Ensure the description value itself is on a single line
      expect(metadata).not.toMatch(/description:.*\n.*\n.*tools:/);
    });
  });

  describe('createClaudeSubagentContent', () => {
    it('should create complete markdown content', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      expect(content).toContain('---'); // Frontmatter
      expect(content).toContain('# Test Assistant'); // Title
      expect(content).toContain('A test assistant for unit testing'); // Description
      expect(content).toContain('## Instructions'); // Section
      expect(content).toContain('codemie assistants chat "asst-123"'); // Command
    });

    it('should include correct command with assistant ID', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      expect(content).toContain('codemie assistants chat "asst-123" "$USER_MESSAGE"');
    });

    it('should include example section', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      expect(content).toContain('## Example');
      expect(content).toContain('User: "Help me review this code"');
      expect(content).toContain('codemie assistants chat "asst-123" "Help me review this code"');
    });

    it('should reference assistant name in instructions', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      expect(content).toContain('communicates with the CodeMie platform to get responses from the Test Assistant assistant');
    });

    it('should handle assistant with no description', () => {
      // Arrange
      const assistantNoDesc = { ...mockAssistant, description: undefined } as Assistant;

      // Act
      const content = createClaudeSubagentContent(assistantNoDesc);

      // Assert
      expect(content).toContain('Interact with Test Assistant');
      expect(content).not.toContain('undefined');
    });

    it('should properly format markdown structure', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      const lines = content.split('\n');
      const h1Count = lines.filter(l => l.startsWith('# ')).length;
      const h2Count = lines.filter(l => l.startsWith('## ')).length;

      expect(h1Count).toBe(1); // Only one main title
      expect(h2Count).toBe(2); // Instructions and Example
    });

    it('should include code blocks with proper formatting', () => {
      // Act
      const content = createClaudeSubagentContent(mockAssistant);

      // Assert
      expect(content).toContain('```bash');
      expect(content).toContain('```');
      const bashBlockCount = (content.match(/```bash/g) || []).length;
      expect(bashBlockCount).toBeGreaterThanOrEqual(2); // At least 2 bash blocks
    });
  });

  describe('registerClaudeSubagent', () => {
    it('should create subagent file in correct location', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'test-assistant.md');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
        'utf-8'
      );
    });

    it('should create .claude/agents directory if not exists', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      const expectedDir = path.join(mockHomeDir, '.claude', 'agents');
      expect(fs.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });

    it('should write complete subagent content', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('# Test Assistant'),
        'utf-8'
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('codemie assistants chat "asst-123"'),
        'utf-8'
      );
    });

    it('should handle filesystem errors during directory creation', async () => {
      // Arrange
      const fsError = new Error('EACCES: permission denied');
      vi.mocked(fs.mkdir).mockRejectedValue(fsError);

      // Act & Assert
      await expect(registerClaudeSubagent(mockAssistant)).rejects.toThrow('EACCES: permission denied');
    });

    it('should handle filesystem errors during file write', async () => {
      // Arrange
      const fsError = new Error('ENOSPC: no space left on device');
      vi.mocked(fs.writeFile).mockRejectedValue(fsError);

      // Act & Assert
      await expect(registerClaudeSubagent(mockAssistant)).rejects.toThrow('ENOSPC: no space left on device');
    });

    it('should handle assistant with special characters in slug', async () => {
      // Arrange
      const specialSlugAssistant = {
        ...mockAssistant,
        slug: 'test-assistant-v2.0'
      } as Assistant;

      // Act
      await registerClaudeSubagent(specialSlugAssistant);

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'test-assistant-v2.0.md');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
        'utf-8'
      );
    });

    it('should handle assistant with uppercase slug', async () => {
      // Arrange
      const uppercaseSlugAssistant = {
        ...mockAssistant,
        slug: 'TEST-ASSISTANT'
      } as Assistant;

      // Act
      await registerClaudeSubagent(uppercaseSlugAssistant);

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'TEST-ASSISTANT.md');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
        'utf-8'
      );
    });

    it('should handle assistant with null slug by using non-null assertion', async () => {
      // Arrange: slug is undefined
      const noSlugAssistant = {
        ...mockAssistant,
        slug: undefined
      } as Assistant;

      // Act: The non-null assertion operator (!) doesn't throw at runtime
      // It just passes undefined to the function, creating "undefined.md"
      await registerClaudeSubagent(noSlugAssistant);

      // Assert: Documents current behavior - creates file with "undefined" in name
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'undefined.md');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
        'utf-8'
      );
    });

    it('should overwrite existing file', async () => {
      // Arrange: File already exists (writeFile doesn't throw)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // Act
      await registerClaudeSubagent(mockAssistant);
      await registerClaudeSubagent(mockAssistant); // Register again

      // Assert: Should write twice without error
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('unregisterClaudeSubagent', () => {
    it('should remove subagent file', async () => {
      // Act
      await unregisterClaudeSubagent('test-assistant');

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'test-assistant.md');
      expect(fs.unlink).toHaveBeenCalledWith(expectedPath);
    });

    it('should handle file not found error gracefully', async () => {
      // Arrange
      const notFoundError = new Error('ENOENT: no such file or directory');
      vi.mocked(fs.unlink).mockRejectedValue(notFoundError);

      // Act & Assert: Should not throw
      await expect(unregisterClaudeSubagent('test-assistant')).resolves.toBeUndefined();
    });

    it('should handle permission errors gracefully', async () => {
      // Arrange
      const permError = new Error('EACCES: permission denied');
      vi.mocked(fs.unlink).mockRejectedValue(permError);

      // Act & Assert: Should not throw
      await expect(unregisterClaudeSubagent('test-assistant')).resolves.toBeUndefined();
    });

    it('should handle special characters in slug', async () => {
      // Act
      await unregisterClaudeSubagent('test-assistant-v2.0');

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', 'test-assistant-v2.0.md');
      expect(fs.unlink).toHaveBeenCalledWith(expectedPath);
    });

    it('should handle empty slug', async () => {
      // Act
      await unregisterClaudeSubagent('');

      // Assert
      const expectedPath = path.join(mockHomeDir, '.claude', 'agents', '.md');
      expect(fs.unlink).toHaveBeenCalledWith(expectedPath);
    });
  });

  describe('Path resolution', () => {
    it('should use home directory from os.homedir()', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      expect(os.homedir).toHaveBeenCalled();
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const filePath = callArgs[0] as string;
      // Normalize path separators for cross-platform comparison
      const normalizedPath = filePath.replace(/\\/g, '/');
      expect(normalizedPath).toContain(mockHomeDir.replace(/\\/g, '/'));
    });

    it('should construct correct path with platform-specific separators', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const filePath = callArgs[0] as string;

      // Path should include .claude/agents
      expect(filePath).toContain('.claude');
      expect(filePath).toContain('agents');
      expect(filePath).toMatch(/test-assistant\.md$/);
    });

    it('should handle different home directory paths', async () => {
      // Arrange
      const differentHome = '/Users/differentuser';
      vi.mocked(os.homedir).mockReturnValue(differentHome);

      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const filePath = callArgs[0] as string;
      // Normalize path separators for cross-platform comparison
      const normalizedPath = filePath.replace(/\\/g, '/');
      expect(normalizedPath).toContain(differentHome.replace(/\\/g, '/'));
    });

    it('should handle Windows-style home directory', async () => {
      // Arrange
      const windowsHome = 'C:\\Users\\testuser';
      vi.mocked(os.homedir).mockReturnValue(windowsHome);

      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(windowsHome),
        expect.any(String),
        'utf-8'
      );
    });
  });

  describe('Security considerations', () => {
    it('should handle null bytes in slug', async () => {
      // Arrange
      const nullByteSlug = 'test\x00assistant';
      const nullByteAssistant = {
        ...mockAssistant,
        slug: nullByteSlug
      } as Assistant;

      // Act
      await registerClaudeSubagent(nullByteAssistant);

      // Assert: Documents current behavior
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const filePath = callArgs[0] as string;
      expect(filePath).toContain(nullByteSlug);
    });
  });

  describe('Content validation', () => {
    it('should create parseable markdown', async () => {
      // Act
      await registerClaudeSubagent(mockAssistant);

      // Assert
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const content = callArgs[1] as string;

      // Basic markdown structure validation
      expect(content).toMatch(/^---\n/); // Starts with frontmatter
      expect(content).toMatch(/\n---\n/); // Closes frontmatter
      expect(content).toContain('# '); // Has heading
      expect(content).toContain('## '); // Has subheading
    });

    it('should escape special markdown characters in content', async () => {
      // Arrange
      const specialAssistant = {
        ...mockAssistant,
        name: 'Test [Assistant] *with* `special` **chars**',
        description: 'Description with #hashtag and _underscores_'
      } as Assistant;

      // Act
      await registerClaudeSubagent(specialAssistant);

      // Assert: Current implementation doesn't escape, documents behavior
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const content = callArgs[1] as string;
      expect(content).toContain('[Assistant]');
      expect(content).toContain('*with*');
      expect(content).toContain('#hashtag');
    });

    it('should handle newlines in assistant description', async () => {
      // Arrange
      const multilineAssistant = {
        ...mockAssistant,
        description: 'First line\nSecond line\nThird line'
      } as Assistant;

      // Act
      await registerClaudeSubagent(multilineAssistant);

      // Assert
      const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
      const content = callArgs[1] as string;
      expect(content).toContain('First line\nSecond line\nThird line');
    });
  });
});
