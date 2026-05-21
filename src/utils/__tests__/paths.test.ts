/**
 * Cross-Platform Path Utilities Tests
 *
 * Tests for platform-agnostic path operations
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  normalizePathSeparators,
  splitPath,
  getFilename,
  matchesPathStructure,
  validatePathDepth,
  getDirname,
  extractRepository,
} from '../paths.js';

// Test-only helper functions
function findDirectoryIndex(filePath: string, dirName: string): number {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.findIndex(part => part === dirName);
}

describe('Path Utilities - Cross-Platform', () => {
  describe('normalizePathSeparators', () => {
    it('should convert Windows backslashes to forward slashes', () => {
      const input = 'C:\\Users\\john\\Documents\\file.txt';
      const expected = 'C:/Users/john/Documents/file.txt';
      expect(normalizePathSeparators(input)).toBe(expected);
    });

    it('should leave Unix paths unchanged', () => {
      const input = '/home/user/documents/file.txt';
      expect(normalizePathSeparators(input)).toBe(input);
    });

    it('should handle mixed separators', () => {
      const input = 'C:\\Users/john\\Documents/file.txt';
      const expected = 'C:/Users/john/Documents/file.txt';
      expect(normalizePathSeparators(input)).toBe(expected);
    });

    it('should handle empty string', () => {
      expect(normalizePathSeparators('')).toBe('');
    });
  });

  describe('splitPath', () => {
    it('should split Windows path correctly', () => {
      const input = 'C:\\Users\\john\\Documents\\file.txt';
      const expected = ['C:', 'Users', 'john', 'Documents', 'file.txt'];
      expect(splitPath(input)).toEqual(expected);
    });

    it('should split Unix path correctly', () => {
      const input = '/home/user/documents/file.txt';
      const expected = ['', 'home', 'user', 'documents', 'file.txt'];
      expect(splitPath(input)).toEqual(expected);
    });

    it('should handle relative paths', () => {
      const input = 'src/utils/file.ts';
      const expected = ['src', 'utils', 'file.ts'];
      expect(splitPath(input)).toEqual(expected);
    });

    it('should handle paths with dots', () => {
      const input = '/home/user/.config/app/settings.json';
      const expected = ['', 'home', 'user', '.config', 'app', 'settings.json'];
      expect(splitPath(input)).toEqual(expected);
    });
  });

  describe('findDirectoryIndex', () => {
    it('should find directory in Windows path', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl';
      expect(findDirectoryIndex(path, '.claude')).toBe(3);
      expect(findDirectoryIndex(path, 'projects')).toBe(4);
    });

    it('should find directory in Unix path', () => {
      const path = '/home/user/.claude/projects/abc/file.jsonl';
      expect(findDirectoryIndex(path, '.claude')).toBe(3);
      expect(findDirectoryIndex(path, 'projects')).toBe(4);
    });

    it('should return -1 if directory not found', () => {
      const path = '/home/user/documents/file.txt';
      expect(findDirectoryIndex(path, '.claude')).toBe(-1);
    });

    it('should be case-sensitive', () => {
      const path = '/home/user/.Claude/projects/file.jsonl';
      expect(findDirectoryIndex(path, '.claude')).toBe(-1);
      expect(findDirectoryIndex(path, '.Claude')).toBe(3);
    });
  });

  describe('getFilename', () => {
    it('should extract filename from Windows path', () => {
      const path = 'C:\\Users\\john\\Documents\\report.pdf';
      expect(getFilename(path)).toBe('report.pdf');
    });

    it('should extract filename from Unix path', () => {
      const path = '/home/user/documents/report.pdf';
      expect(getFilename(path)).toBe('report.pdf');
    });

    it('should handle path with multiple extensions', () => {
      const path = '/var/www/archive.tar.gz';
      expect(getFilename(path)).toBe('archive.tar.gz');
    });

    it('should return empty string for empty path', () => {
      expect(getFilename('')).toBe('');
    });

    it('should handle filename without extension', () => {
      const path = '/usr/bin/node';
      expect(getFilename(path)).toBe('node');
    });
  });

  describe('matchesPathStructure', () => {
    it('should validate Windows path structure', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl';
      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
    });

    it('should validate Unix path structure', () => {
      const path = '/home/user/.claude/projects/abc/file.jsonl';
      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
    });

    it('should validate multi-level structure', () => {
      const path = '/var/app/.config/settings/user/preferences.json';
      expect(matchesPathStructure(path, '.config', ['settings', 'user'])).toBe(true);
    });

    it('should reject incorrect structure', () => {
      const path = '/home/user/.claude/sessions/abc/file.jsonl';
      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(false);
    });

    it('should reject missing base directory', () => {
      const path = '/home/user/projects/abc/file.jsonl';
      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(false);
    });

    it('should handle empty expected structure', () => {
      const path = '/home/user/.claude/file.jsonl';
      expect(matchesPathStructure(path, '.claude', [])).toBe(true);
    });
  });

  describe('validatePathDepth', () => {
    it('should validate depth in Windows path', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl';
      // After .claude: projects, abc, file.jsonl = 3 segments
      expect(validatePathDepth(path, '.claude', 3)).toBe(true);
    });

    it('should validate depth in Unix path', () => {
      const path = '/home/user/.claude/projects/abc/file.jsonl';
      // After .claude: projects, abc, file.jsonl = 3 segments
      expect(validatePathDepth(path, '.claude', 3)).toBe(true);
    });

    it('should reject incorrect depth', () => {
      const path = '/home/user/.claude/projects/abc/file.jsonl';
      expect(validatePathDepth(path, '.claude', 2)).toBe(false);
      expect(validatePathDepth(path, '.claude', 4)).toBe(false);
    });

    it('should handle missing base directory', () => {
      const path = '/home/user/projects/abc/file.jsonl';
      expect(validatePathDepth(path, '.claude', 3)).toBe(false);
    });

    it('should validate zero depth (base dir is last)', () => {
      const path = '/home/user/.claude';
      expect(validatePathDepth(path, '.claude', 0)).toBe(true);
    });

    it('should validate single depth', () => {
      const path = '/home/user/.claude/file.jsonl';
      expect(validatePathDepth(path, '.claude', 1)).toBe(true);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle Claude session path pattern (Windows)', () => {
      const path = 'C:\\Users\\admin\\.claude\\projects\\user-hash\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';

      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
      expect(validatePathDepth(path, '.claude', 3)).toBe(true);
      expect(getFilename(path)).toBe('f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl');
    });

    it('should handle Claude session path pattern (Unix)', () => {
      const path = '/Users/admin/.claude/projects/user-hash/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';

      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
      expect(validatePathDepth(path, '.claude', 3)).toBe(true);
      expect(getFilename(path)).toBe('f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl');
    });

    it('should reject Claude agent files', () => {
      const path = '/Users/admin/.claude/projects/user-hash/agent-123abc.jsonl';
      const filename = getFilename(path);

      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
      expect(filename.startsWith('agent-')).toBe(true); // Should be rejected by caller
    });

    it('should handle deeply nested project paths', () => {
      const path = 'D:\\Projects\\team\\repository\\.claude\\projects\\hash\\session.jsonl';

      expect(findDirectoryIndex(path, '.claude')).toBeGreaterThan(-1);
      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle paths with trailing slashes', () => {
      const path = '/home/user/.claude/projects/abc/';
      const parts = splitPath(path);

      // Trailing slash creates empty last segment
      expect(parts[parts.length - 1]).toBe('');
    });

    it('should handle UNC paths (Windows network paths)', () => {
      const path = '\\\\server\\share\\.claude\\projects\\abc\\file.jsonl';

      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
      expect(getFilename(path)).toBe('file.jsonl');
    });

    it('should handle relative paths', () => {
      const path = '.claude/projects/abc/file.jsonl';

      expect(matchesPathStructure(path, '.claude', ['projects'])).toBe(true);
      expect(validatePathDepth(path, '.claude', 3)).toBe(true);
    });

    it('should handle paths with special characters', () => {
      const path = '/home/user-name/.claude/projects/hash_123-abc/file.jsonl';

      expect(findDirectoryIndex(path, '.claude')).toBe(3);
      expect(getFilename(path)).toBe('file.jsonl');
    });
  });

  describe('extractRepository', () => {
    describe('normal project paths — unchanged', () => {
      it('should return last two segments for a standard project path', () => {
        expect(extractRepository('/Users/alice/projects/codemie-code')).toBe('projects/codemie-code');
      });

      it('should return last two segments for a deeply nested path', () => {
        expect(extractRepository('/home/user/work/epam/codemie-ui')).toBe('epam/codemie-ui');
      });

      it('should return single segment when path has only one meaningful part', () => {
        expect(extractRepository('/myrepo')).toBe('myrepo');
      });

      it('should handle Windows-style paths', () => {
        expect(extractRepository('C:\\Users\\alice\\projects\\codemie-code')).toBe('projects/codemie-code');
      });
    });

    describe('Claude Desktop sandbox paths — return Claude Desktop', () => {
      it('should detect real Desktop sandbox path observed in logs', () => {
        const path = '/Users/mykola/Library/Application Support/Claude-3p/local-agent-mode-sessions/759182a5-1458-46d1-92e3-d6b6bc1262bd/00000000-0000-4000-8000-000000000001/local_2d5f3a0f-6a50-4778-ac55-9ffbca0446da/outputs';
        expect(extractRepository(path)).toBe('Claude Desktop');
      });

      it('should detect sandbox path with different UUID', () => {
        const path = '/Users/alice/Library/Application Support/Claude-3p/local-agent-mode-sessions/abc/def/local_7fb4c6a0-a7b9-4121-960c-035d0e4830ff/outputs';
        expect(extractRepository(path)).toBe('Claude Desktop');
      });

      it('should detect sandbox path ending at the local_<uuid> directory itself', () => {
        const path = '/some/path/local_74f67be8-ddc7-44c4-a911-1d6cd034ec9d';
        expect(extractRepository(path)).toBe('Claude Desktop');
      });

      it('should detect sandbox path with a project subfolder inside outputs', () => {
        const path = '/Users/alice/Library/Application Support/Claude-3p/local-agent-mode-sessions/s/u/local_95002bb5-744b-4b94-b87b-711c0ebf7a47/outputs/my-project';
        expect(extractRepository(path)).toBe('Claude Desktop');
      });

      it('should be case-insensitive for hex digits', () => {
        const path = '/some/path/local_2D5F3A0F-6A50-4778-AC55-9FFBCA0446DA/outputs';
        expect(extractRepository(path)).toBe('Claude Desktop');
      });
    });

    describe('false-positive guard — must NOT match legitimate project names', () => {
      it('should NOT match a project named local_ with only 8 hex chars (no UUID dashes)', () => {
        expect(extractRepository('/home/alice/work/local_deadbeef')).toBe('work/local_deadbeef');
      });

      it('should NOT match local_cafebabe (8 hex, no dashes)', () => {
        expect(extractRepository('/home/alice/projects/local_cafebabe/src')).toBe('local_cafebabe/src');
      });

      it('should NOT match a directory starting with local_ but containing non-hex chars', () => {
        expect(extractRepository('/home/alice/local_myproject/src')).toBe('local_myproject/src');
      });

      it('should NOT match a UUID-like name that lacks the local_ prefix', () => {
        expect(extractRepository('/home/alice/2d5f3a0f-6a50-4778-ac55-9ffbca0446da/outputs')).toBe('2d5f3a0f-6a50-4778-ac55-9ffbca0446da/outputs');
      });
    });
  });

  describe('getDirname', () => {
    it('should return the directory path from import.meta.url', () => {
      // Create a mock URL for testing (platform-aware)
      const mockUrl = process.platform === 'win32'
        ? 'file:///C:/Users/test/project/src/utils/module.js'
        : 'file:///Users/test/project/src/utils/module.js';

      // Expected result: directory of the mock URL
      const expected = dirname(fileURLToPath(mockUrl));

      // Test the function
      const result = getDirname(mockUrl);

      // Assert the result matches expected
      expect(result).toBe(expected);
    });

    it('should handle different file paths correctly', () => {
      // Use platform-appropriate file URL
      const mockUrl = process.platform === 'win32'
        ? 'file:///C:/home/user/app/index.js'
        : 'file:///home/user/app/index.js';

      const expected = dirname(fileURLToPath(mockUrl));
      const result = getDirname(mockUrl);

      expect(result).toBe(expected);
    });

    it('should return a string', () => {
      // Use platform-appropriate file URL
      const mockUrl = process.platform === 'win32'
        ? 'file:///C:/test/path/file.js'
        : 'file:///test/path/file.js';

      const result = getDirname(mockUrl);

      expect(typeof result).toBe('string');
    });
  });
});
