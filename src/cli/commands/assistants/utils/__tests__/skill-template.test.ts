/**
 * Unit tests for skill template
 */

import { describe, it, expect } from 'vitest';
import type { Assistant } from 'codemie-sdk';
import { createSkillMarkdown } from '../skill-template.js';

describe('Skill Template', () => {
  const mockAssistant = {
    id: 'test-123',
    name: 'Test Assistant',
    slug: 'test-assistant',
    description: 'A test assistant for testing'
  } as Assistant;

  describe('createSkillMarkdown', () => {
    it('should generate valid YAML frontmatter', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('---');
      expect(result).toContain('name: test-assistant');
      expect(result).toContain('description: A test assistant for testing');
    });

    it('should include assistant name as title', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('# Test Assistant');
    });

    it('should include description in content', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('## What I Do');
      expect(result).toContain('A test assistant for testing');
    });

    it('should include instructions section', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('## Instructions');
      expect(result).toContain('codemie assistants chat');
    });

    it('should include assistant ID in bash command', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('codemie assistants chat "test-123"');
    });

    it('should include example usage', () => {
      const result = createSkillMarkdown(mockAssistant);

      expect(result).toContain('## Example Usage');
      expect(result).toContain('/test-assistant');
    });

    it('should handle assistant without description', () => {
      const assistant = {
        ...mockAssistant,
        description: undefined
      } as Assistant;

      const result = createSkillMarkdown(assistant);

      expect(result).toContain('Interact with Test Assistant assistant');
    });

    it('should use slug for skill name', () => {
      const assistant = {
        ...mockAssistant,
        slug: 'custom-slug'
      } as Assistant;

      const result = createSkillMarkdown(assistant);

      expect(result).toContain('name: custom-slug');
      expect(result).toContain('/custom-slug');
    });
  });
});
