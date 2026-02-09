/**
 * Chat Utils Unit Tests
 *
 * Tests utility functions for the chat command
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger before importing
vi.mock('@/utils/logger.js', () => ({
  logger: {
    getLogFilePath: vi.fn(() => '/mock/log/path.log')
  }
}));

// Mock EXIT_PROMPTS constant
vi.mock('@/cli/commands/assistants/constants.js', () => ({
  EXIT_PROMPTS: ['exit', 'quit', '/exit', '/quit', 'bye']
}));

describe('Chat Utils', () => {
  let isExitCommand: any;
  let enableVerboseMode: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.CODEMIE_DEBUG;

    // Dynamic import to get fresh module
    const module = await import('@/cli/commands/assistants/chat/utils.js');
    isExitCommand = module.isExitCommand;
    enableVerboseMode = module.enableVerboseMode;
  });

  describe('isExitCommand', () => {
    describe('with valid exit commands', () => {
      const exitCommands = ['exit', 'quit', '/exit', '/quit', 'bye'];

      exitCommands.forEach(cmd => {
        it(`should return true for "${cmd}"`, () => {
          expect(isExitCommand(cmd)).toBe(true);
        });

        it(`should be case-insensitive for "${cmd}"`, () => {
          expect(isExitCommand(cmd.toUpperCase())).toBe(true);
          expect(isExitCommand(cmd.toLowerCase())).toBe(true);
        });

        it(`should handle whitespace for "${cmd}"`, () => {
          expect(isExitCommand(`  ${cmd}  `)).toBe(true);
          expect(isExitCommand(`\t${cmd}\t`)).toBe(true);
        });
      });
    });

    describe('with non-exit commands', () => {
      const nonExitCommands = [
        'hello',
        'help',
        'exiting',
        'quitting',
        'not exit',
        '',
        'EXIT NOW' // includes EXIT but not exact match
      ];

      nonExitCommands.forEach(cmd => {
        it(`should return false for "${cmd}"`, () => {
          expect(isExitCommand(cmd)).toBe(false);
        });
      });
    });
  });

  describe('enableVerboseMode', () => {
    let consoleLogSpy: any;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should set CODEMIE_DEBUG environment variable', () => {
      enableVerboseMode();
      expect(process.env.CODEMIE_DEBUG).toBe('true');
    });

    it('should log the log file path', () => {
      enableVerboseMode();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('/mock/log/path.log')
      );
    });

    it('should display dimmed log message', () => {
      enableVerboseMode();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Debug logs:')
      );
    });
  });
});
