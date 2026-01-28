/**
 * Unit tests for skill generator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { Assistant } from 'codemie-sdk';
import { generateAssistantSkill, removeAssistantSkill } from '../skill-generator.js';

// Mock dependencies
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn()
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

describe('Skill Generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateAssistantSkill', () => {
    const mockAssistant: Assistant = {
      id: 'test-assistant-123',
      name: 'Test Assistant',
      slug: 'test-assistant',
      description: 'A helpful test assistant',
      system_prompt: 'You are a test assistant',
      llm_model_type: 'claude-3-sonnet',
    } as Assistant;

    it('should generate skill file with all assistant information', async () => {
      const result = await generateAssistantSkill(mockAssistant);

      expect(result).toBe('test-assistant');
      expect(fs.mkdir).toHaveBeenCalledWith(
        '/home/test/.claude/skills/test-assistant',
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/home/test/.claude/skills/test-assistant/SKILL.md',
        expect.stringContaining('# Test Assistant'),
        'utf-8'
      );
    });

    it('should include description in skill content', async () => {
      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('A helpful test assistant');
    });


    it('should include assistant ID in bash command', async () => {
      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('codemie assistants chat "test-assistant-123"');
    });

    it('should handle assistant without description', async () => {
      const assistantWithoutDesc: Assistant = {
        ...mockAssistant,
        description: undefined as any
      };

      await generateAssistantSkill(assistantWithoutDesc);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('Interact with Test Assistant assistant');
    });

    it('should handle assistant without model info', async () => {
      const assistantWithoutModel: Assistant = {
        ...mockAssistant,
        llm_model_type: undefined
      };

      await generateAssistantSkill(assistantWithoutModel);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('Test Assistant');
    });

    it('should throw error if assistant has no slug', async () => {
      const assistantWithoutSlug: Assistant = {
        ...mockAssistant,
        slug: undefined as any
      };

      await expect(generateAssistantSkill(assistantWithoutSlug)).rejects.toThrow(
        'Assistant Test Assistant does not have a slug'
      );
    });

    it('should use assistant slug for directory and file paths', async () => {
      const assistantWithCustomSlug: Assistant = {
        ...mockAssistant,
        slug: 'my-custom-slug'
      };

      await generateAssistantSkill(assistantWithCustomSlug);

      expect(fs.mkdir).toHaveBeenCalledWith(
        '/home/test/.claude/skills/my-custom-slug',
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/home/test/.claude/skills/my-custom-slug/SKILL.md',
        expect.any(String),
        'utf-8'
      );
    });

    it('should include skill frontmatter metadata', async () => {
      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('---');
      expect(content).toContain('name: test-assistant');
      expect(content).toContain('description:');
    });

    it('should include usage instructions', async () => {
      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('## Instructions');
      expect(content).toContain('/test-assistant "your question here"');
    });

    it('should include technical implementation note', async () => {
      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('exactly as received');
    });

    it('should return the skill slug', async () => {
      const result = await generateAssistantSkill(mockAssistant);

      expect(result).toBe('test-assistant');
    });
  });

  describe('removeAssistantSkill', () => {
    it('should remove skill directory with force and recursive options', async () => {
      await removeAssistantSkill('test-assistant');

      expect(fs.rm).toHaveBeenCalledWith(
        '/home/test/.claude/skills/test-assistant',
        { recursive: true, force: true }
      );
    });

    it('should handle removal errors gracefully', async () => {
      const error = new Error('Permission denied');
      (fs.rm as any).mockRejectedValueOnce(error);

      // Should not throw
      await expect(removeAssistantSkill('test-assistant')).resolves.toBeUndefined();
    });

    it('should use correct skill directory path', async () => {
      await removeAssistantSkill('my-custom-slug');

      expect(fs.rm).toHaveBeenCalledWith(
        '/home/test/.claude/skills/my-custom-slug',
        { recursive: true, force: true }
      );
    });

    it('should work with different home directories', async () => {
      (os.homedir as any).mockReturnValueOnce('/Users/testuser');

      await removeAssistantSkill('test-assistant');

      expect(fs.rm).toHaveBeenCalledWith(
        '/Users/testuser/.claude/skills/test-assistant',
        { recursive: true, force: true }
      );
    });
  });

  describe('Skill Directory Structure', () => {
    it('should create skills in .claude/skills directory', async () => {
      const mockAssistant: Assistant = {
        id: 'test-123',
        name: 'Test',
        slug: 'test',
        description: 'Test assistant'
      } as Assistant;

      await generateAssistantSkill(mockAssistant);

      const mkdirCall = (fs.mkdir as any).mock.calls[0];
      expect(mkdirCall[0]).toBe('/home/test/.claude/skills/test');
    });

    it('should create SKILL.md file in skill directory', async () => {
      const mockAssistant: Assistant = {
        id: 'test-123',
        name: 'Test',
        slug: 'test',
        description: 'Test assistant'
      } as Assistant;

      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      expect(writeCall[0]).toBe('/home/test/.claude/skills/test/SKILL.md');
    });
  });

  describe('Integration with Template', () => {
    it('should pass assistant object to template function', async () => {
      const mockAssistant: Assistant = {
        id: 'test-123',
        name: 'Full Test',
        slug: 'full-test',
        description: 'Complete test assistant',
        system_prompt: 'You are helpful',
        llm_model_type: 'gpt-4'
      } as Assistant;

      await generateAssistantSkill(mockAssistant);

      const writeCall = (fs.writeFile as any).mock.calls[0];
      const content = writeCall[1];

      // Verify all data is in the generated content
      expect(content).toContain('full-test');
      expect(content).toContain('Full Test');
      expect(content).toContain('Complete test assistant');
      expect(content).toContain('test-123');
    });
  });
});
