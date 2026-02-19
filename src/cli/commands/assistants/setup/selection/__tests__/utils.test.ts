/**
 * Unit tests for selection utility functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import {
  buildAssistantDisplayInfo,
  createAssistantChoices,
  displayNoAssistantsMessage,
  getProjectFilter,
  type AssistantChoice,
} from '../utils.js';

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    dim: (str: string) => `[dim]${str}[/dim]`,
    yellow: (str: string) => `[yellow]${str}[/yellow]`,
    cyan: (str: string) => `[cyan]${str}[/cyan]`,
  },
}));

describe('Selection Utils - utils.ts', () => {
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('buildAssistantDisplayInfo', () => {
    it('should build display info with name only', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test Assistant',
        slug: 'test',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Test Assistant');
      expect(result).not.toContain('[dim]');
    });

    it('should include project in display info', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test Assistant',
        slug: 'test',
        project: { id: 'proj-1', name: 'My Project' },
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Test Assistant');
      expect(result).toContain('My Project');
    });

    it('should include description in display info', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test Assistant',
        slug: 'test',
        description: 'This is a test assistant',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Test Assistant');
      expect(result).toContain('[dim]\n   This is a test assistant[/dim]');
    });

    it('should include both project and description', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test Assistant',
        slug: 'test',
        project: { id: 'proj-1', name: 'My Project' },
        description: 'This is a test assistant',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Test Assistant');
      expect(result).toContain('My Project');
      expect(result).toContain('This is a test assistant');
    });

    it('should handle long assistant names', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Very Long Assistant Name That Exceeds Normal Display Width',
        slug: 'long-test',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Very Long Assistant Name That Exceeds Normal Display Width');
    });

    it('should handle special characters in name', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test & Special <chars>',
        slug: 'test',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Test & Special <chars>');
    });

    it('should handle empty description', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test',
        slug: 'test',
        description: '',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toBe('Test');
    });
  });

  describe('createAssistantChoices', () => {
    it('should create choices from assistants', () => {
      const assistants: Assistant[] = [
        {
          id: '1',
          name: 'Assistant One',
          slug: 'assistant-one',
          description: 'First assistant',
        },
        {
          id: '2',
          name: 'Assistant Two',
          slug: 'assistant-two',
          description: 'Second assistant',
        },
      ];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result).toHaveLength(2);
      expect(result[0].value).toBe('1');
      expect(result[0].short).toBe('Assistant One');
      expect(result[0].checked).toBe(false);
      expect(result[1].value).toBe('2');
      expect(result[1].short).toBe('Assistant Two');
      expect(result[1].checked).toBe(false);
    });

    it('should mark registered assistants as checked', () => {
      const assistants: Assistant[] = [
        {
          id: '1',
          name: 'Assistant One',
          slug: 'assistant-one',
        },
        {
          id: '2',
          name: 'Assistant Two',
          slug: 'assistant-two',
        },
      ];
      const registeredIds = new Set(['1']);

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result[0].checked).toBe(true);
      expect(result[1].checked).toBe(false);
    });

    it('should handle assistants with project information', () => {
      const assistants: Assistant[] = [
        {
          id: '1',
          name: 'Assistant',
          slug: 'assistant',
          project: { id: 'proj-1', name: 'Project' },
        },
      ];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result).toHaveLength(1);
      expect(result[0].name).toContain('Assistant');
      expect(result[0].name).toContain('Project');
    });

    it('should handle empty assistants list', () => {
      const assistants: Assistant[] = [];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result).toHaveLength(0);
    });

    it('should handle all assistants registered', () => {
      const assistants: Assistant[] = [
        { id: '1', name: 'A1', slug: 'a1' },
        { id: '2', name: 'A2', slug: 'a2' },
      ];
      const registeredIds = new Set(['1', '2']);

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result.every(choice => choice.checked)).toBe(true);
    });

    it('should handle AssistantBase type (without full details)', () => {
      const assistants: AssistantBase[] = [
        { id: '1', name: 'Base Assistant', slug: 'base' },
      ];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('1');
      expect(result[0].short).toBe('Base Assistant');
    });

    it('should preserve choice structure', () => {
      const assistants: Assistant[] = [
        { id: '1', name: 'Test', slug: 'test' },
      ];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);
      const choice: AssistantChoice = result[0];

      expect(choice).toHaveProperty('name');
      expect(choice).toHaveProperty('value');
      expect(choice).toHaveProperty('short');
      expect(choice).toHaveProperty('checked');
    });
  });

  describe('displayNoAssistantsMessage', () => {
    it('should display basic no assistants message', () => {
      const options = { allProjects: false };
      const config = {} as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain('yellow');
      expect(consoleLogSpy.mock.calls[0][0]).toContain('No assistants');
    });

    it('should display filtered by project message when project option is set', () => {
      const options = { project: 'my-project', allProjects: false };
      const config = {} as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy.mock.calls[1][0]).toContain('dim');
      expect(consoleLogSpy.mock.calls[1][0]).toContain('my-project');
    });

    it('should display filtered by project message when config project is set', () => {
      const options = { allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy.mock.calls[1][0]).toContain('config-project');
    });

    it('should show try all projects hint when filtered by project', () => {
      const options = { project: 'my-project', allProjects: false };
      const config = {} as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy.mock.calls[2][0]).toContain('dim');
      expect(consoleLogSpy.mock.calls[2][0]).toContain('--all-projects');
    });

    it('should not show project filter hint when allProjects is true', () => {
      const options = { allProjects: true };
      const config = {} as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should prioritize options.project over config.codeMieProject', () => {
      const options = { project: 'options-project', allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      displayNoAssistantsMessage(options, config);

      expect(consoleLogSpy.mock.calls[1][0]).toContain('options-project');
      expect(consoleLogSpy.mock.calls[1][0]).not.toContain('config-project');
    });
  });

  describe('getProjectFilter', () => {
    it('should return undefined when allProjects is true', () => {
      const options = { project: 'my-project', allProjects: true };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      const result = getProjectFilter(options, config);

      expect(result).toBeUndefined();
    });

    it('should return options.project when set', () => {
      const options = { project: 'my-project', allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      const result = getProjectFilter(options, config);

      expect(result).toBe('my-project');
    });

    it('should return config.codeMieProject when options.project is not set', () => {
      const options = { allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      const result = getProjectFilter(options, config);

      expect(result).toBe('config-project');
    });

    it('should return undefined when no project is set and allProjects is false', () => {
      const options = { allProjects: false };
      const config = {} as ProviderProfile;

      const result = getProjectFilter(options, config);

      expect(result).toBeUndefined();
    });

    it('should prioritize options.project over config.codeMieProject', () => {
      const options = { project: 'options-project', allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      const result = getProjectFilter(options, config);

      expect(result).toBe('options-project');
    });

    it('should handle empty string in options.project', () => {
      const options = { project: '', allProjects: false };
      const config = { codeMieProject: 'config-project' } as ProviderProfile;

      const result = getProjectFilter(options, config);

      // Empty string is falsy, so config.codeMieProject should be used
      expect(result).toBe('config-project');
    });
  });

  describe('edge cases', () => {
    it('should handle assistants with minimal data', () => {
      const assistants: AssistantBase[] = [
        { id: '1', name: 'A', slug: 's' },
      ];
      const registeredIds = new Set<string>();

      const result = createAssistantChoices(assistants, registeredIds);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('1');
      expect(result[0].short).toBe('A');
    });

    it('should handle very long descriptions', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test',
        slug: 'test',
        description: 'A'.repeat(500),
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('A'.repeat(500));
    });

    it('should handle unicode characters in names', () => {
      const assistant: Assistant = {
        id: '1',
        name: '测试助手 🤖',
        slug: 'test',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('测试助手 🤖');
    });

    it('should handle newlines in descriptions', () => {
      const assistant: Assistant = {
        id: '1',
        name: 'Test',
        slug: 'test',
        description: 'Line 1\nLine 2\nLine 3',
      };

      const result = buildAssistantDisplayInfo(assistant);

      expect(result).toContain('Line 1\nLine 2\nLine 3');
    });
  });
});
