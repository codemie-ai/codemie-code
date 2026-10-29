/**
 * Tests for `codemie proxy analytics status`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let tempDir: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    resolveHomeDir: (relativePath = '') => join(tempDir, relativePath),
    getCodemiePath: (...paths: string[]) => join(tempDir, '.codemie', ...paths),
  };
});

async function writeSettings(content: Record<string, unknown>): Promise<void> {
  const path = join(tempDir, '.claude', 'settings.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content), 'utf-8');
}

async function writePreferences(raw: string): Promise<void> {
  const { getClaudeAnalyticsPreferencesPath } = await import(
    '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
  );
  const path = getClaudeAnalyticsPreferencesPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw, 'utf-8');
}

const HOOK_ENTRY = { matcher: '', hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] };

describe('analytics-status', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-analytics-status-'));
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('hasClaudeCodeOtlpHooks', () => {
    it('is false with no settings file', async () => {
      const { hasClaudeCodeOtlpHooks } = await import('../connectors/claude-code-otlp.js');
      expect(await hasClaudeCodeOtlpHooks()).toBe(false);
    });

    it('is true once the settings file has the codemie hook command', async () => {
      await writeSettings({ hooks: { SessionStart: [HOOK_ENTRY] } });
      const { hasClaudeCodeOtlpHooks } = await import('../connectors/claude-code-otlp.js');
      expect(await hasClaudeCodeOtlpHooks()).toBe(true);
    });
  });

  describe('collectClaudeAnalyticsStatus', () => {
    it('reports not-configured with no settings and no preferences', async () => {
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.hooksInstalled).toBe(false);
      expect(status.scope).toBe('not-configured');
      expect(status.enabled).toBe(true);
      expect(status.excludedProjects).toEqual([]);
    });

    it('reports project scope with tracked projects', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(['/work/a', '/work/b']) },
      });
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.hooksInstalled).toBe(true);
      expect(status.scope).toBe('project');
      expect(status.trackedProjects).toEqual(['/work/a', '/work/b']);
    });

    it('reports an excluded project under Global scope as not tracked (CR-004: also asserts scope)', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: '[]' },
      });
      await writePreferences(JSON.stringify({ version: 1, enabled: true, excludedProjects: ['/work/a'] }));
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.scope).toBe('user');
      expect(status.current.tracked).toBe(false);
      expect(status.current.reason).toBe('project-excluded');
    });

    it('reports an invalid allowlist as scope "invalid" (CR-004)', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: 'not-json' },
      });
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.scope).toBe('invalid');
    });

    it('reports disabled when preferences disable collection', async () => {
      await writePreferences(JSON.stringify({ version: 1, enabled: false, excludedProjects: [] }));
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.enabled).toBe(false);
      expect(status.current.tracked).toBe(false);
      expect(status.current.reason).toBe('disabled');
    });

    it('reports a corrupt preferences file', async () => {
      await writePreferences('{not json');
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.preferencesCorrupt).toBe(true);
      expect(status.current.reason).toBe('preferences-corrupt');
    });
  });

  describe('formatClaudeAnalyticsStatus', () => {
    it('includes the corrupt-config hint only when corrupt', async () => {
      const { formatClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const base = {
        hooksInstalled: true,
        scope: 'not-configured' as const,
        trackedProjects: [],
        enabled: true,
        excludedProjects: [],
        preferencesCorrupt: false,
        preferencesPath: '/x/claude-analytics.json',
        current: { path: '/work/a', tracked: true, reason: 'tracked' as const },
      };
      expect(formatClaudeAnalyticsStatus(base)).not.toContain('corrupt');
      expect(formatClaudeAnalyticsStatus({ ...base, preferencesCorrupt: true })).toContain('corrupt');
    });

    it('includes the connect hint only when hooks are not installed', async () => {
      const { formatClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const base = {
        hooksInstalled: false,
        scope: 'not-configured' as const,
        trackedProjects: [],
        enabled: true,
        excludedProjects: [],
        preferencesCorrupt: false,
        preferencesPath: '/x/claude-analytics.json',
        current: { path: '/work/a', tracked: true, reason: 'tracked' as const },
      };
      expect(formatClaudeAnalyticsStatus(base)).toContain('codemie proxy connect');
      expect(formatClaudeAnalyticsStatus({ ...base, hooksInstalled: true })).not.toContain('codemie proxy connect');
    });
  });
});
