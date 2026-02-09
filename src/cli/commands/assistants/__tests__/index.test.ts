/**
 * Unit tests for assistants parent command
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAssistantsCommand } from '../index.js';
import { COMMAND_NAMES } from '../constants.js';

describe('Assistants Command (Parent)', () => {
  describe('createAssistantsCommand', () => {
    let command: ReturnType<typeof createAssistantsCommand>;

    beforeEach(() => {
      command = createAssistantsCommand();
    });

    it('should create a command with name "assistants"', () => {
      expect(command.name()).toBe('assistants');
    });

    it('should have correct description', () => {
      expect(command.description()).toBe('Manage CodeMie assistants');
    });

    it('should be configured as a Commander command', () => {
      expect(command.constructor.name).toBe('Command');
    });

    it('should have no options', () => {
      expect(command.options).toHaveLength(0);
    });

    it('should have no arguments', () => {
      expect(command.registeredArguments).toHaveLength(0);
    });
  });

  describe('Subcommands', () => {
    let command: ReturnType<typeof createAssistantsCommand>;

    beforeEach(() => {
      command = createAssistantsCommand();
    });

    it('should have exactly 1 subcommand', () => {
      expect(command.commands).toHaveLength(1);
    });

    it('should have chat subcommand', () => {
      const chatCommand = command.commands.find(c => c.name() === COMMAND_NAMES.CHAT);
      expect(chatCommand).toBeDefined();
      expect(chatCommand?.name()).toBe('chat');
    });

    it('should have chat command with correct description', () => {
      const chatCommand = command.commands.find(c => c.name() === COMMAND_NAMES.CHAT);
      expect(chatCommand?.description()).toContain('message');
    });
  });

  describe('Command Structure', () => {
    let command: ReturnType<typeof createAssistantsCommand>;

    beforeEach(() => {
      command = createAssistantsCommand();
    });

    it('should use COMMAND_NAMES constant for finding subcommands', () => {
      const chatCommand = command.commands.find(c => c.name() === COMMAND_NAMES.CHAT);
      expect(chatCommand).toBeDefined();
      expect(COMMAND_NAMES.CHAT).toBe('chat');
    });

    it('should have chat subcommand as child command', () => {
      const commandNames = command.commands.map(c => c.name());
      expect(commandNames).toContain('chat');
    });

    it('should not have default action handler', () => {
      // The parent command no longer has a default action since setup moved to `codemie setup assistants`
      expect(command).toBeDefined();
    });
  });

  describe('Command Purpose', () => {
    it('should be a parent command for assistant-related operations', () => {
      const command = createAssistantsCommand();

      // Assistants command is now focused on chat operations
      // Setup has been moved to `codemie setup assistants`
      expect(command.name()).toBe('assistants');
      expect(command.description()).toContain('assistants');
    });
  });

  describe('Subcommand Access', () => {
    let command: ReturnType<typeof createAssistantsCommand>;

    beforeEach(() => {
      command = createAssistantsCommand();
    });

    it('should allow accessing chat command', () => {
      const chatCommand = command.commands.find(c => c.name() === 'chat');
      expect(chatCommand).toBeDefined();
    });

    it('should have chat command with arguments', () => {
      const chatCommand = command.commands.find(c => c.name() === 'chat');
      expect(chatCommand?.registeredArguments.length).toBeGreaterThan(0);
    });

    it('should not have setup command (moved to codemie setup assistants)', () => {
      const setupCommand = command.commands.find(c => c.name() === 'setup');
      expect(setupCommand).toBeUndefined();
    });
  });

  describe('Command Hierarchy', () => {
    it('should be a parent command with subcommands', () => {
      const command = createAssistantsCommand();

      // Parent command should have no arguments/options
      expect(command.registeredArguments).toHaveLength(0);
      expect(command.options).toHaveLength(0);

      // But should have subcommands
      expect(command.commands.length).toBeGreaterThan(0);
    });

    it('should organize chat as the only subcommand', () => {
      const command = createAssistantsCommand();
      const subcommandNames = command.commands.map(c => c.name());

      expect(subcommandNames).toEqual(['chat']);
    });
  });
});
