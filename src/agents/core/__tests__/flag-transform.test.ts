import { describe, it, expect } from 'vitest';
import { transformFlags } from '../flag-transform.js';
import type { FlagMappings, AgentConfig } from '../types.js';

describe('transformFlags', () => {
  const mockConfig: AgentConfig = {
    provider: 'test-provider',
    model: 'test-model'
  };

  describe('single flag transformation', () => {
    it('should transform --task to target flag', () => {
      const args = ['--task', 'hello world', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'hello world', '--verbose']);
    });

    it('should transform positional flag', () => {
      const args = ['--task', 'analyze code', '--debug'];
      const mappings: FlagMappings = {
        '--task': { type: 'positional', target: null }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['analyze code', '--debug']);
    });

    it('should transform subcommand with position=before', () => {
      const args = ['--task', 'hello', '--json'];
      const mappings: FlagMappings = {
        '--task': { type: 'subcommand', target: 'exec', position: 'before' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['exec', 'hello', '--json']);
    });

    it('should transform subcommand with position=after', () => {
      const args = ['--task', 'hello', '--json'];
      const mappings: FlagMappings = {
        '--task': { type: 'subcommand', target: 'exec', position: 'after' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['exec', '--json', 'hello']);
    });
  });

  describe('multiple flag transformation', () => {
    it('should transform multiple flags', () => {
      const args = ['--task', 'hello', '--profile', 'work', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' },
        '--profile': { type: 'flag', target: '--workspace' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'hello', '--workspace', 'work', '--verbose']);
    });

    it('should transform multiple flags with different types', () => {
      const args = ['--task', 'test', '--timeout', '300', '--model', 'gpt-4'];
      const mappings: FlagMappings = {
        '--task': { type: 'positional', target: null },
        '--timeout': { type: 'flag', target: '-t' },
        '--model': { type: 'flag', target: '-m' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['test', '-t', '300', '-m', 'gpt-4']);
    });

    it('should preserve order of non-mapped flags', () => {
      const args = ['--debug', '--task', 'hello', '--json', '--profile', 'work', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' },
        '--profile': { type: 'flag', target: '--workspace' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['--debug', '-p', 'hello', '--json', '--workspace', 'work', '--verbose']);
    });

    it('should handle multiple flags with subcommand', () => {
      const args = ['--task', 'test', '--profile', 'work', '--json'];
      const mappings: FlagMappings = {
        '--task': { type: 'subcommand', target: 'exec' },
        '--profile': { type: 'flag', target: '--workspace' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['exec', 'test', '--workspace', 'work', '--json']);
    });
  });

  describe('no mapping scenarios', () => {
    it('should return original args when mappings is undefined', () => {
      const args = ['--task', 'hello', '--verbose'];

      const result = transformFlags(args, undefined, mockConfig);

      expect(result).toEqual(['--task', 'hello', '--verbose']);
    });

    it('should return original args when no flags match', () => {
      const args = ['-p', 'hello world', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'hello world', '--verbose']);
    });

    it('should handle empty mappings object', () => {
      const args = ['--task', 'hello', '--verbose'];
      const mappings: FlagMappings = {};

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['--task', 'hello', '--verbose']);
    });
  });

  describe('edge cases', () => {
    it('should handle empty args array', () => {
      const args: string[] = [];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual([]);
    });

    it('should handle flag without value', () => {
      const args = ['--task'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['--task']);
    });

    it('should handle task value with spaces', () => {
      const args = ['--task', 'hello world with spaces', '--json'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'hello world with spaces', '--json']);
    });

    it('should handle task value with special characters', () => {
      const args = ['--task', 'add feature --with-flag', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'subcommand', target: 'exec' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['exec', 'add feature --with-flag', '--verbose']);
    });

    it('should handle target=null for flag type (fallback)', () => {
      const args = ['--task', 'hello', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: null }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['hello', '--verbose']);
    });
  });

  describe('real-world agent mappings', () => {
    it('should transform for Claude (flag type)', () => {
      const args = ['--task', 'fix bug in auth', '--profile', 'work'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'fix bug in auth', '--profile', 'work']);
    });

    it('should transform for Codex (subcommand type)', () => {
      const args = ['--task', 'add unit tests', '--model', 'gpt-4'];
      const mappings: FlagMappings = {
        '--task': { type: 'subcommand', target: 'exec', position: 'before' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['exec', 'add unit tests', '--model', 'gpt-4']);
    });

    it('should transform for Gemini (flag type)', () => {
      const args = ['--task', 'refactor code', '-m', 'gemini-2.5-flash'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'refactor code', '-m', 'gemini-2.5-flash']);
    });

    it('should transform for Deep Agents (positional type)', () => {
      const args = ['--task', 'analyze codebase'];
      const mappings: FlagMappings = {
        '--task': { type: 'positional', target: null }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['analyze codebase']);
    });

    it('should transform complex multi-flag scenario', () => {
      const args = ['--task', 'test', '--profile', 'prod', '--timeout', '600', '--verbose'];
      const mappings: FlagMappings = {
        '--task': { type: 'flag', target: '-p' },
        '--profile': { type: 'flag', target: '--workspace' },
        '--timeout': { type: 'flag', target: '-t' }
      };

      const result = transformFlags(args, mappings, mockConfig);

      expect(result).toEqual(['-p', 'test', '--workspace', 'prod', '-t', '600', '--verbose']);
    });
  });
});
