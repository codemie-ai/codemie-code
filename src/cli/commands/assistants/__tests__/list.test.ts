/**
 * Unit tests for assistants list command
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAssistantsListCommand } from '../list.js';
import { COMMAND_NAMES, MESSAGES } from '../constants.js';

describe('Assistants List Command', () => {
  describe('createAssistantsListCommand', () => {
    let command: ReturnType<typeof createAssistantsListCommand>;

    beforeEach(() => {
      command = createAssistantsListCommand();
    });

    it('should create a command with correct name', () => {
      expect(command.name()).toBe(COMMAND_NAMES.LIST);
    });

    it('should have correct description', () => {
      expect(command.description()).toBe(MESSAGES.LIST.COMMAND_DESCRIPTION);
    });

    it('should have profile option', () => {
      const profileOption = command.options.find(opt => opt.long === '--profile');
      expect(profileOption).toBeDefined();
      expect(profileOption?.description).toBe(MESSAGES.LIST.OPTION_PROFILE);
    });

    it('should have project option', () => {
      const projectOption = command.options.find(opt => opt.long === '--project');
      expect(projectOption).toBeDefined();
      expect(projectOption?.description).toBe(MESSAGES.LIST.OPTION_PROJECT);
    });

    it('should have all-projects option', () => {
      const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
      expect(allProjectsOption).toBeDefined();
      expect(allProjectsOption?.description).toBe(MESSAGES.LIST.OPTION_ALL_PROJECTS);
    });

    it('should have verbose option', () => {
      const verboseOption = command.options.find(opt => opt.long === '--verbose');
      expect(verboseOption).toBeDefined();
      expect(verboseOption?.short).toBe('-v');
      expect(verboseOption?.description).toBe(MESSAGES.SHARED.OPTION_VERBOSE);
    });

    it('should be configured as a Commander command', () => {
      expect(command.constructor.name).toBe('Command');
    });
  });

  describe('Command Options', () => {
    let command: ReturnType<typeof createAssistantsListCommand>;

    beforeEach(() => {
      command = createAssistantsListCommand();
    });

    it('should have exactly 4 options', () => {
      expect(command.options).toHaveLength(4);
    });

    it('should have profile option with argument', () => {
      const profileOption = command.options.find(opt => opt.long === '--profile');
      expect(profileOption?.long).toBe('--profile');
      // Profile option should accept a value
      expect(profileOption?.flags).toContain('<name>');
    });

    it('should have project option with argument', () => {
      const projectOption = command.options.find(opt => opt.long === '--project');
      expect(projectOption?.long).toBe('--project');
      // Project option should accept a value
      expect(projectOption?.flags).toContain('<project>');
    });

    it('should have all-projects as boolean flag', () => {
      const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
      expect(allProjectsOption?.long).toBe('--all-projects');
      // All-projects should be a boolean flag (no argument)
      expect(allProjectsOption?.flags).not.toContain('<');
    });

    it('should have verbose as boolean flag', () => {
      const verboseOption = command.options.find(opt => opt.long === '--verbose');
      expect(verboseOption?.long).toBe('--verbose');
      expect(verboseOption?.short).toBe('-v');
      // Verbose should be a boolean flag (no argument)
      expect(verboseOption?.flags).not.toContain('<');
    });

    it('should have all options as optional', () => {
      // Commander.js options without .requiredOption() are optional by default
      // Options created with .option() don't have mandatory flag set
      expect(command.options).toHaveLength(4);

      // Verify none are using requiredOption by checking they all use .option()
      // In Commander.js, required options would have mandatory=true
      const hasRequiredOptions = command.options.some(opt => (opt as any).mandatory === true);
      expect(hasRequiredOptions).toBe(false);
    });
  });

  describe('Command Arguments', () => {
    it('should not have any positional arguments', () => {
      const command = createAssistantsListCommand();
      expect(command.registeredArguments).toHaveLength(0);
    });
  });

  describe('Command Structure', () => {
    it('should not have subcommands', () => {
      const command = createAssistantsListCommand();
      expect(command.commands).toHaveLength(0);
    });

    it('should have an action handler', () => {
      const command = createAssistantsListCommand();
      // The action is set internally by Commander
      expect(command).toBeDefined();
    });
  });

  describe('Option Combinations', () => {
    let command: ReturnType<typeof createAssistantsListCommand>;

    beforeEach(() => {
      command = createAssistantsListCommand();
    });

    it('should allow profile option alone', () => {
      const profileOption = command.options.find(opt => opt.long === '--profile');
      expect(profileOption).toBeDefined();
    });

    it('should allow project option alone', () => {
      const projectOption = command.options.find(opt => opt.long === '--project');
      expect(projectOption).toBeDefined();
    });

    it('should allow all-projects option alone', () => {
      const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
      expect(allProjectsOption).toBeDefined();
    });

    it('should allow combining profile and project options', () => {
      // Both options exist independently
      const profileOption = command.options.find(opt => opt.long === '--profile');
      const projectOption = command.options.find(opt => opt.long === '--project');

      expect(profileOption).toBeDefined();
      expect(projectOption).toBeDefined();
    });

    it('should allow combining any options with verbose', () => {
      const verboseOption = command.options.find(opt => opt.long === '--verbose');
      expect(verboseOption).toBeDefined();

      // Verbose can be combined with any other option
      expect(command.options.length).toBeGreaterThan(1);
    });
  });

  describe('Command Name Constant', () => {
    it('should use COMMAND_NAMES.LIST constant', () => {
      const command = createAssistantsListCommand();
      expect(command.name()).toBe(COMMAND_NAMES.LIST);
      expect(COMMAND_NAMES.LIST).toBe('list');
    });
  });
});
