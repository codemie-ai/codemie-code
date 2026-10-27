/**
 * Shared Claude file-operation extraction — used by both the live metrics processor
 * and the session adapter's parse path so native (re-parsed) sessions get the same
 * line counts as live-tracked ones.
 */

import { describe, it, expect } from 'vitest';
import { extractClaudeFileOperation } from '../claude-file-operation.js';

describe('extractClaudeFileOperation', () => {
  it('counts lines added for a Write from its content', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\nb\nc' }, {
      filePath: '/repo/a.ts',
      content: 'a\nb\nc',
    });
    expect(op).toMatchObject({ type: 'write', path: '/repo/a.ts', language: 'typescript', linesAdded: 3 });
  });

  it('counts added/removed lines for an Edit from its structuredPatch', () => {
    const op = extractClaudeFileOperation('Edit', { file_path: '/repo/b.py' }, {
      filePath: '/repo/b.py',
      structuredPatch: [
        { lines: [' ctx', '-old1', '-old2', '+new1', '+new2', '+new3', ' end'] },
      ],
    });
    expect(op).toMatchObject({ type: 'edit', path: '/repo/b.py', linesAdded: 3, linesRemoved: 2 });
  });

  it('resolves the path from toolUseResult.filePath (current native log shape)', () => {
    const op = extractClaudeFileOperation('Edit', {}, { filePath: '/repo/c.md', structuredPatch: [] });
    expect(op?.path).toBe('/repo/c.md');
  });

  it('returns undefined for a non-file tool', () => {
    expect(extractClaudeFileOperation('Bash', { command: 'ls' }, {})).toBeUndefined();
  });

  it('does not overcount lines when Write content ends with a trailing newline', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\nb\nc\n' }, {
      filePath: '/repo/a.ts',
      content: 'a\nb\nc\n',
    });
    expect(op).toMatchObject({ linesAdded: 3 });
  });

  it('counts a single-line Write with no trailing newline as 1', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a' }, {
      filePath: '/repo/a.ts',
      content: 'a',
    });
    expect(op).toMatchObject({ linesAdded: 1 });
  });

  it('counts a blank line in the middle of a Write', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\n\nb' }, {
      filePath: '/repo/a.ts',
      content: 'a\n\nb',
    });
    expect(op).toMatchObject({ linesAdded: 3 });
  });

  it('treats CRLF-terminated Write content the same as LF-terminated', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\r\nb\r\nc\r\n' }, {
      filePath: '/repo/a.ts',
      content: 'a\r\nb\r\nc\r\n',
    });
    expect(op).toMatchObject({ linesAdded: 3 });
  });

  it('reports linesAdded: 0 for an empty-content Write, not undefined', () => {
    const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: '' }, {
      filePath: '/repo/a.ts',
      content: '',
    });
    expect(op).toMatchObject({ linesAdded: 0 });
  });
});
