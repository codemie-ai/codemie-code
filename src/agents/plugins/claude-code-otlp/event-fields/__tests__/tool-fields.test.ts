import { describe, it, expect } from 'vitest';
import { resolveToolContextFields, resolveToolDiffFields } from '../tool-fields.js';

describe('resolveToolContextFields', () => {
  it.each(['Edit', 'Write', 'MultiEdit'])('reads file_path from tool_input.file_path for %s', (toolName) => {
    const fields = resolveToolContextFields(toolName, { file_path: '/repo/a.ts' });
    expect(fields.file_path).toBe('/repo/a.ts');
    expect(fields.subagent_type).toBe('');
    expect(fields.description).toBe('');
    expect(fields.skill_name).toBe('');
  });

  it('reads file_path from tool_input.notebook_path for NotebookEdit', () => {
    const fields = resolveToolContextFields('NotebookEdit', { notebook_path: '/repo/nb.ipynb', file_path: '/wrong' });
    expect(fields.file_path).toBe('/repo/nb.ipynb');
  });

  it.each(['Agent', 'Task'])('reads subagent_type/description for %s', (toolName) => {
    const fields = resolveToolContextFields(toolName, { subagent_type: 'Explore', description: 'find files' });
    expect(fields.subagent_type).toBe('Explore');
    expect(fields.description).toBe('find files');
    expect(fields.file_path).toBe('');
    expect(fields.skill_name).toBe('');
  });

  it('reads skill_name from tool_input.skill for Skill', () => {
    const fields = resolveToolContextFields('Skill', { skill: 'codemie:msgraph', args: 'ignored' });
    expect(fields.skill_name).toBe('codemie:msgraph');
    expect(fields.file_path).toBe('');
    expect(fields.subagent_type).toBe('');
  });

  it('returns every field empty for an unrelated tool', () => {
    expect(resolveToolContextFields('Bash', { command: 'ls' })).toEqual({
      file_path: '',
      subagent_type: '',
      description: '',
      skill_name: '',
    });
  });

  it('is safe against a non-object or missing tool_input', () => {
    expect(resolveToolContextFields('Edit', undefined)).toEqual({
      file_path: '',
      subagent_type: '',
      description: '',
      skill_name: '',
    });
    expect(resolveToolContextFields('Edit', 'not-an-object')).toEqual({
      file_path: '',
      subagent_type: '',
      description: '',
      skill_name: '',
    });
  });
});

describe('resolveToolDiffFields', () => {
  it('counts +/- lines from an Edit structuredPatch', () => {
    const fields = resolveToolDiffFields(
      'Edit',
      {},
      { structuredPatch: [{ lines: [' context', '+added one', '+added two', '-removed one'] }] }
    );
    expect(fields).toEqual({ lines_added: 2, lines_removed: 1 });
  });

  it('sums +/- lines across multiple MultiEdit structuredPatch hunks', () => {
    const fields = resolveToolDiffFields(
      'MultiEdit',
      {},
      {
        structuredPatch: [
          { lines: ['+a', '-b'] },
          { lines: ['+c', '+d'] },
        ],
      }
    );
    expect(fields).toEqual({ lines_added: 3, lines_removed: 1 });
  });

  it('omits line counts for an Edit with no structuredPatch field — unknown, not zero', () => {
    expect(resolveToolDiffFields('Edit', {}, {})).toEqual({});
  });

  it('counts a Write overwrite from its structuredPatch when non-empty', () => {
    const fields = resolveToolDiffFields(
      'Write',
      { content: 'a\nb\nc' },
      { structuredPatch: [{ lines: ['+a', '+b', '-old'] }] }
    );
    expect(fields).toEqual({ lines_added: 2, lines_removed: 1 });
  });

  it('falls back to counting content lines for a Write with an empty structuredPatch (new file)', () => {
    const fields = resolveToolDiffFields('Write', { content: 'line1\nline2\nline3\n' }, { structuredPatch: [] });
    expect(fields).toEqual({ lines_added: 3, lines_removed: 0 });
  });

  it('falls back to counting content lines for a Write with no structuredPatch field at all', () => {
    const fields = resolveToolDiffFields('Write', { content: 'only one line' }, {});
    expect(fields).toEqual({ lines_added: 1, lines_removed: 0 });
  });

  it('omits line counts for a Write with no content and no structuredPatch — unknown, not zero', () => {
    expect(resolveToolDiffFields('Write', {}, {})).toEqual({});
  });

  it('omits line counts for tools with no diff source (NotebookEdit, Bash)', () => {
    expect(resolveToolDiffFields('NotebookEdit', { notebook_path: '/x' }, { structuredPatch: [{ lines: ['+a'] }] })).toEqual({});
    expect(resolveToolDiffFields('Bash', { command: 'ls' }, {})).toEqual({});
  });

  it('is safe against a non-object tool_response and omits the unknown counts', () => {
    expect(resolveToolDiffFields('Edit', {}, 'not-an-object')).toEqual({});
    expect(resolveToolDiffFields('Edit', {}, undefined)).toEqual({});
  });
});
