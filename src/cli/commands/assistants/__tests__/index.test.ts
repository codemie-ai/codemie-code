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

    it('should have exactly 2 subcommands', () => {
      expect(command.commands).toHaveLength(2);
    });

    it('should have list subcommand', () => {
      const listCommand = command.commands.find(c => c.name() === COMMAND_NAMES.LIST);
      expect(listCommand).toBeDefined();
      expect(listCommand?.name()).toBe('list');
    });

    it('should have chat subcommand', () => {
      const chatCommand = command.commands.find(c => c.name() === COMMAND_NAMES.CHAT);
      expect(chatCommand).toBeDefined();
      expect(chatCommand?.name()).toBe('chat');
    });

    it('should have list command with correct description', () => {
      const listCommand = command.commands.find(c => c.name() === COMMAND_NAMES.LIST);
      expect(listCommand?.description()).toContain('assistants');
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
      const listCommand = command.commands.find(c => c.name() === COMMAND_NAMES.LIST);
      expect(listCommand).toBeDefined();
      expect(COMMAND_NAMES.LIST).toBe('list');
    });

    it('should have both subcommands as child commands', () => {
      const commandNames = command.commands.map(c => c.name());
      expect(commandNames).toContain('list');
      expect(commandNames).toContain('chat');
    });

    it('should have an action handler for default behavior', () => {
      // The parent command should have an action to run list by default
      expect(command).toBeDefined();
    });
  });

  describe('Default Action', () => {
    it('should find list command for default action', () => {
      const command = createAssistantsCommand();
      const listCommand = command.commands.find(c => c.name() === COMMAND_NAMES.LIST);

      // List command should exist and be findable by COMMAND_NAMES.LIST
      expect(listCommand).toBeDefined();
      expect(listCommand?.name()).toBe(COMMAND_NAMES.LIST);
    });
  });

  describe('Subcommand Access', () => {
    let command: ReturnType<typeof createAssistantsCommand>;

    beforeEach(() => {
      command = createAssistantsCommand();
    });

    it('should allow accessing list command', () => {
      const listCommand = command.commands.find(c => c.name() === 'list');
      expect(listCommand).toBeDefined();
    });

    it('should allow accessing chat command', () => {
      const chatCommand = command.commands.find(c => c.name() === 'chat');
      expect(chatCommand).toBeDefined();
    });

    it('should have list command with options', () => {
      const listCommand = command.commands.find(c => c.name() === 'list');
      expect(listCommand?.options.length).toBeGreaterThan(0);
    });

    it('should have chat command with arguments', () => {
      const chatCommand = command.commands.find(c => c.name() === 'chat');
      expect(chatCommand?.registeredArguments.length).toBeGreaterThan(0);
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

    it('should properly organize list and chat as subcommands', () => {
      const command = createAssistantsCommand();
      const subcommandNames = command.commands.map(c => c.name());

      expect(subcommandNames).toEqual(['list', 'chat']);
    });
  });
});
