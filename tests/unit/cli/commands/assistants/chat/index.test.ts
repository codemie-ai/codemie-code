/**
 * Chat Command Unit Tests
 *
 * Tests the main chat command structure and configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAssistantsChatCommand } from '@/cli/commands/assistants/chat/index.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';

describe('Chat Command Structure', () => {
  let command: ReturnType<typeof createAssistantsChatCommand>;

  beforeEach(() => {
    command = createAssistantsChatCommand();
  });

  describe('Command Configuration', () => {
    it('should create a command with name "chat"', () => {
      expect(command.name()).toBe('chat');
    });

    it('should have correct description', () => {
      expect(command.description()).toBe(MESSAGES.CHAT.COMMAND_DESCRIPTION);
    });

    it('should accept optional assistant-id argument', () => {
      const args = command.registeredArguments;
      expect(args).toHaveLength(2);
      expect(args[0].name()).toBe('assistant-id');
      expect(args[0].required).toBe(false);
    });

    it('should accept optional message argument', () => {
      const args = command.registeredArguments;
      expect(args).toHaveLength(2);
      expect(args[1].name()).toBe('message');
      expect(args[1].required).toBe(false);
    });
  });

  describe('Command Options', () => {
    it('should have verbose option', () => {
      const verboseOption = command.options.find(opt => opt.long === '--verbose');
      expect(verboseOption).toBeDefined();
      expect(verboseOption?.short).toBe('-v');
      expect(verboseOption?.description).toBe(MESSAGES.SHARED.OPTION_VERBOSE);
    });

    it('should have conversation-id option', () => {
      const convOption = command.options.find(opt => opt.long === '--conversation-id');
      expect(convOption).toBeDefined();
      expect(convOption?.description).toBe('Conversation ID for maintaining context across calls');
    });

    it('should have load-history option', () => {
      const historyOption = command.options.find(opt => opt.long === '--load-history');
      expect(historyOption).toBeDefined();
      expect(historyOption?.defaultValue).toBe(true);
    });

    it('should have all expected options', () => {
      expect(command.options).toHaveLength(3);
    });
  });

  describe('Command Modes', () => {
    it('should support interactive mode (no arguments)', () => {
      const args = command.registeredArguments;
      // Both arguments are optional, allowing interactive mode
      expect(args.every(arg => !arg.required)).toBe(true);
    });

    it('should support single-message mode (both arguments)', () => {
      // Command should be able to accept both arguments
      expect(command.registeredArguments).toHaveLength(2);
    });
  });
});
