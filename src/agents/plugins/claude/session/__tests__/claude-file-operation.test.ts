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
});
