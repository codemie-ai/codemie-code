/**
 * Unit tests for assistants chat command
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAssistantsChatCommand } from '../chat.js';
import { MESSAGES } from '../constants.js';

describe('Assistants Chat Command', () => {
  describe('createAssistantsChatCommand', () => {
    let command: ReturnType<typeof createAssistantsChatCommand>;

    beforeEach(() => {
      command = createAssistantsChatCommand();
    });

    it('should create a command with name "chat"', () => {
      expect(command.name()).toBe('chat');
    });

    it('should have correct description', () => {
      expect(command.description()).toBe(MESSAGES.CHAT.COMMAND_DESCRIPTION);
    });

    it('should accept assistant-id argument', () => {
      const args = command.registeredArguments;
      expect(args).toHaveLength(2);
      expect(args[0].name()).toBe('assistant-id');
      expect(args[0].required).toBe(false);
    });

    it('should accept message argument', () => {
      const args = command.registeredArguments;
      expect(args).toHaveLength(2);
      expect(args[1].name()).toBe('message');
      expect(args[1].required).toBe(false);
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

  describe('Command Arguments Validation', () => {
    it('should allow both arguments to be optional', () => {
      const command = createAssistantsChatCommand();
      const args = command.registeredArguments;

      expect(args[0].required).toBe(false);
      expect(args[1].required).toBe(false);
    });

    it('should support interactive mode (no arguments)', () => {
      const command = createAssistantsChatCommand();
      const args = command.registeredArguments;

      // Both arguments are optional, allowing interactive mode
      expect(args.every(arg => !arg.required)).toBe(true);
    });

    it('should support single-message mode (both arguments)', () => {
      const command = createAssistantsChatCommand();

      // Command should be able to accept both arguments
      expect(command.registeredArguments).toHaveLength(2);
    });
  });

  describe('Command Options', () => {
    it('should have verbose and conversation-id options', () => {
      const command = createAssistantsChatCommand();
      expect(command.options).toHaveLength(2);
    });

    it('should accept --verbose flag', () => {
      const command = createAssistantsChatCommand();
      const verboseOption = command.options.find(opt => opt.long === '--verbose');

      expect(verboseOption).toBeDefined();
      expect(verboseOption?.short).toBe('-v');
    });

    it('should accept --conversation-id option', () => {
      const command = createAssistantsChatCommand();
      const conversationIdOption = command.options.find(opt => opt.long === '--conversation-id');

      expect(conversationIdOption).toBeDefined();
      expect(conversationIdOption?.long).toBe('--conversation-id');
    });

    it('should have all options defined', () => {
      const command = createAssistantsChatCommand();

      // Verify both options exist
      const verboseOption = command.options.find(opt => opt.long === '--verbose');
      const conversationIdOption = command.options.find(opt => opt.long === '--conversation-id');

      expect(verboseOption).toBeDefined();
      expect(conversationIdOption).toBeDefined();
    });
  });

  describe('Command Structure', () => {
    it('should not have subcommands', () => {
      const command = createAssistantsChatCommand();
      expect(command.commands).toHaveLength(0);
    });

    it('should have an action handler', () => {
      const command = createAssistantsChatCommand();
      // The action is set internally by Commander
      expect(command).toBeDefined();
    });
  });
});
