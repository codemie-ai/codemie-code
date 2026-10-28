/**
 * Tests for the Claude Code analytics preferences file (claude-analytics.json).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
  };
});

describe('claude-code-otlp.preferences', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-claude-analytics-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readClaudeAnalyticsPreferences', () => {
    it('returns defaults when the file is absent', async () => {
      const { readClaudeAnalyticsPreferences, DEFAULT_CLAUDE_ANALYTICS_PREFERENCES } = await import(
        '../claude-code-otlp.preferences.js'
      );
      const result = await readClaudeAnalyticsPreferences();
      expect(result).toEqual({ kind: 'ok', value: DEFAULT_CLAUDE_ANALYTICS_PREFERENCES });
    });

    it('returns defaults when the file is empty', async () => {
      const { readClaudeAnalyticsPreferences, getClaudeAnalyticsPreferencesPath, DEFAULT_CLAUDE_ANALYTICS_PREFERENCES } =
        await import('../claude-code-otlp.preferences.js');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getClaudeAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '', 'utf-8');

      const result = await readClaudeAnalyticsPreferences();
      expect(result).toEqual({ kind: 'ok', value: DEFAULT_CLAUDE_ANALYTICS_PREFERENCES });
    });

    it('fills missing fields from defaults for a partial file', async () => {
      const { readClaudeAnalyticsPreferences, getClaudeAnalyticsPreferencesPath } = await import(
        '../claude-code-otlp.preferences.js'
      );
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getClaudeAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, enabled: false }), 'utf-8');

      const result = await readClaudeAnalyticsPreferences();
      expect(result).toEqual({ kind: 'ok', value: { version: 1, enabled: false, excludedProjects: [] } });
    });

    it.each([
      ['invalid JSON', '{not json'],
      ['array root', '[]'],
      ['enabled not boolean', JSON.stringify({ version: 1, enabled: 'no' })],
      ['excludedProjects not an array', JSON.stringify({ version: 1, excludedProjects: 'x' })],
      ['excludedProjects with a non-absolute path', JSON.stringify({ version: 1, excludedProjects: ['rel/path'] })],
    ])('treats %s as corrupt', async (_label, raw) => {
      const { readClaudeAnalyticsPreferences, getClaudeAnalyticsPreferencesPath } = await import(
        '../claude-code-otlp.preferences.js'
      );
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getClaudeAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw, 'utf-8');

      const result = await readClaudeAnalyticsPreferences();
      expect(result).toEqual({ kind: 'corrupt' });
    });
  });

  describe('updateClaudeAnalyticsPreferences', () => {
    it('creates the file and round-trips through read', async () => {
      const { updateClaudeAnalyticsPreferences, readClaudeAnalyticsPreferences } = await import(
        '../claude-code-otlp.preferences.js'
      );
      await updateClaudeAnalyticsPreferences((current) => ({ ...current, enabled: false }));

      const result = await readClaudeAnalyticsPreferences();
      expect(result).toEqual({ kind: 'ok', value: { version: 1, enabled: false, excludedProjects: [] } });
    });

    it('throws ConfigurationError on a corrupt existing file and leaves bytes unchanged', async () => {
      const { updateClaudeAnalyticsPreferences, getClaudeAnalyticsPreferencesPath } = await import(
        '../claude-code-otlp.preferences.js'
      );
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getClaudeAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{not json', 'utf-8');
      const before = await readFile(path, 'utf-8');

      await expect(updateClaudeAnalyticsPreferences((current) => current)).rejects.toThrow();

      const after = await readFile(path, 'utf-8');
      expect(after).toBe(before);
    });

    it('leaves no temp file behind after a successful write', async () => {
      const { updateClaudeAnalyticsPreferences, getClaudeAnalyticsPreferencesPath } = await import(
        '../claude-code-otlp.preferences.js'
      );
      await updateClaudeAnalyticsPreferences((current) => ({ ...current, enabled: false }));

      const dir = join(getClaudeAnalyticsPreferencesPath(), '..');
      const files = await readdir(dir);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('isProjectExcluded', () => {
    it('returns true for a nested subdirectory of an excluded path', async () => {
      const { isProjectExcluded } = await import('../claude-code-otlp.preferences.js');
      expect(await isProjectExcluded('/a/b/c', ['/a/b'])).toBe(true);
    });

    it('returns true when the excluded entry has a trailing slash', async () => {
      const { isProjectExcluded } = await import('../claude-code-otlp.preferences.js');
      expect(await isProjectExcluded('/a/b', ['/a/b/'])).toBe(true);
    });

    it('returns false for a sibling with a shared string prefix', async () => {
      const { isProjectExcluded } = await import('../claude-code-otlp.preferences.js');
      expect(await isProjectExcluded('/a/bc', ['/a/b'])).toBe(false);
    });

    it('returns false when cwd is undefined', async () => {
      const { isProjectExcluded } = await import('../claude-code-otlp.preferences.js');
      expect(await isProjectExcluded(undefined, ['/a'])).toBe(false);
    });

    it('returns false when excludedProjects is empty', async () => {
      const { isProjectExcluded } = await import('../claude-code-otlp.preferences.js');
      expect(await isProjectExcluded('/x', [])).toBe(false);
    });
  });
});
