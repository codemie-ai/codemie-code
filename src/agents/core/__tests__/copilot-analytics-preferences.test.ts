/**
 * Tests for the Copilot analytics preferences file (copilot-analytics.json), keyed by connector id.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

let tempDir: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
  };
});

describe('copilot-analytics-preferences', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-copilot-analytics-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readCopilotAnalyticsPreferences', () => {
    it('returns the default record when the file is absent', async () => {
      const { readCopilotAnalyticsPreferences, DEFAULT_COPILOT_ANALYTICS_RECORD } = await import(
        '../copilot-analytics-preferences.js'
      );
      expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({
        kind: 'ok',
        value: DEFAULT_COPILOT_ANALYTICS_RECORD,
      });
    });

    it('returns the default record when the connector key is absent from an existing file', async () => {
      const { readCopilotAnalyticsPreferences, updateCopilotAnalyticsPreferences, DEFAULT_COPILOT_ANALYTICS_RECORD } =
        await import('../copilot-analytics-preferences.js');
      await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, enabled: false }));
      expect(await readCopilotAnalyticsPreferences('copilot-chat-otlp')).toEqual({
        kind: 'ok',
        value: DEFAULT_COPILOT_ANALYTICS_RECORD,
      });
    });

    it.each([
      ['invalid JSON', '{not json'],
      ['array root', '[]'],
      ['connectors not an object', JSON.stringify({ version: 1, connectors: 'x' })],
      ['enabled not boolean', JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: 'no' } } })],
      [
        'excludedProjects not an array',
        JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: true, excludedProjects: 'x' } } }),
      ],
      [
        'excludedProjects with a non-absolute path',
        JSON.stringify({
          version: 1,
          connectors: { 'copilot-cli-otlp': { enabled: true, excludedProjects: ['rel/path'] } },
        }),
      ],
    ])('treats %s as corrupt', async (_label, raw) => {
      const { readCopilotAnalyticsPreferences, getCopilotAnalyticsPreferencesPath } = await import(
        '../copilot-analytics-preferences.js'
      );
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw, 'utf-8');

      expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({ kind: 'corrupt' });
    });
  });

  describe('updateCopilotAnalyticsPreferences', () => {
    it('creates the file and round-trips through read for the written connector', async () => {
      const { updateCopilotAnalyticsPreferences, readCopilotAnalyticsPreferences } = await import(
        '../copilot-analytics-preferences.js'
      );
      await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (current) => ({ ...current, enabled: false }));

      expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({
        kind: 'ok',
        value: { enabled: false, excludedProjects: [] },
      });
    });

    it('updating one connector preserves an already-written sibling connector record', async () => {
      const { updateCopilotAnalyticsPreferences, readCopilotAnalyticsPreferences } = await import(
        '../copilot-analytics-preferences.js'
      );
      await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, excludedProjects: ['/work/a'] }));
      await updateCopilotAnalyticsPreferences('copilot-chat-otlp', (c) => ({ ...c, enabled: false }));

      expect(await readCopilotAnalyticsPreferences('copilot-cli-otlp')).toEqual({
        kind: 'ok',
        value: { enabled: true, excludedProjects: ['/work/a'] },
      });
      expect(await readCopilotAnalyticsPreferences('copilot-chat-otlp')).toEqual({
        kind: 'ok',
        value: { enabled: false, excludedProjects: [] },
      });
    });

    it('throws ConfigurationError on a corrupt existing file and leaves bytes unchanged', async () => {
      const { updateCopilotAnalyticsPreferences, getCopilotAnalyticsPreferencesPath } = await import(
        '../copilot-analytics-preferences.js'
      );
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{not json', 'utf-8');
      const before = await readFile(path, 'utf-8');

      await expect(updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => c)).rejects.toThrow();

      expect(await readFile(path, 'utf-8')).toBe(before);
    });

    it('leaves no temp file behind after a successful write', async () => {
      const { updateCopilotAnalyticsPreferences, getCopilotAnalyticsPreferencesPath } = await import(
        '../copilot-analytics-preferences.js'
      );
      await updateCopilotAnalyticsPreferences('copilot-cli-otlp', (c) => ({ ...c, enabled: false }));

      const dir = join(getCopilotAnalyticsPreferencesPath(), '..');
      const files = await readdir(dir);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('isCopilotAnalyticsProjectExcluded', () => {
    it('returns true for a nested subdirectory of an excluded path', async () => {
      const { isCopilotAnalyticsProjectExcluded } = await import('../copilot-analytics-preferences.js');
      expect(await isCopilotAnalyticsProjectExcluded('/a/b/c', ['/a/b'])).toBe(true);
    });

    it('returns true when the excluded entry has a trailing slash', async () => {
      const { isCopilotAnalyticsProjectExcluded } = await import('../copilot-analytics-preferences.js');
      expect(await isCopilotAnalyticsProjectExcluded('/a/b', ['/a/b/'])).toBe(true);
    });

    it('returns false for a sibling with a shared string prefix', async () => {
      const { isCopilotAnalyticsProjectExcluded } = await import('../copilot-analytics-preferences.js');
      expect(await isCopilotAnalyticsProjectExcluded('/a/bc', ['/a/b'])).toBe(false);
    });

    it('returns false when cwd is undefined', async () => {
      const { isCopilotAnalyticsProjectExcluded } = await import('../copilot-analytics-preferences.js');
      expect(await isCopilotAnalyticsProjectExcluded(undefined, ['/a'])).toBe(false);
    });

    it('returns false when excludedProjects is empty', async () => {
      const { isCopilotAnalyticsProjectExcluded } = await import('../copilot-analytics-preferences.js');
      expect(await isCopilotAnalyticsProjectExcluded('/x', [])).toBe(false);
    });
  });
});
