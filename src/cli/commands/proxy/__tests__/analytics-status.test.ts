/**
 * Tests for `codemie proxy analytics status`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ClaudeAnalyticsStatus, CopilotAnalyticsStatus } from '../analytics-status.js';

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

    it('reports a directory as NOT tracked (hooks-not-installed) when the gate would track it but no hooks are installed (CR-006)', async () => {
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus('/work/a');
      expect(status.hooksInstalled).toBe(false);
      expect(status.current).toEqual({ path: '/work/a', tracked: false, reason: 'hooks-not-installed' });
    });

    it('keeps the more specific gate reason when hooks are missing AND collection is disabled', async () => {
      await writePreferences(JSON.stringify({ version: 1, enabled: false, excludedProjects: [] }));
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      expect((await collectClaudeAnalyticsStatus('/work/a')).current.reason).toBe('disabled');
    });

    it('reports tracked once the hooks are installed', async () => {
      await writeSettings({ hooks: { SessionStart: [HOOK_ENTRY] } });
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      expect((await collectClaudeAnalyticsStatus('/work/a')).current.tracked).toBe(true);
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
    const SENTENCE = 'These settings do not affect the daily analytics collector and the session sync that `codemie claude` runs itself.';
    const base = {
      hooksInstalled: true,
      scope: 'user' as const,
      trackedProjects: [] as string[],
      enabled: true,
      excludedProjects: [] as string[],
      preferencesCorrupt: false,
      preferencesPath: '/x/claude-analytics.json',
      current: { path: '/work/a', tracked: true, reason: 'tracked' as const } as ClaudeAnalyticsStatus['current'],
    };

    async function render(status: ClaudeAnalyticsStatus): Promise<string> {
      const { formatClaudeAnalyticsStatus } = await import('../analytics-status.js');
      return stripVTControlCharacters(formatClaudeAnalyticsStatus(status));
    }

    it('prints a headline, aligned 2-space detail lines and a plain unaffected sentence', async () => {
      expect(await render(base)).toBe(
        [
          'Hooks: installed',
          '  Scope:      user',
          '  Collection: enabled',
          '  Excluded:   (none)',
          '  Current:    /work/a: tracked',
          SENTENCE,
        ].join('\n')
      );
    });

    it('lists tracked projects under Scope: project and aligns continuation lines', async () => {
      const out = await render({
        ...base,
        scope: 'project',
        trackedProjects: ['/work/a', '/work/b'],
        excludedProjects: ['/work/x', '/work/y'],
      });
      expect(out).toContain(
        ['  Scope:      project', '  Tracked:    /work/a', '              /work/b', '  Collection: enabled'].join('\n')
      );
      expect(out).toContain(['  Excluded:   /work/x', '              /work/y'].join('\n'));
    });

    it('omits Tracked for scopes other than project', async () => {
      expect(await render({ ...base, trackedProjects: ['/work/a'] })).not.toContain('Tracked:');
    });

    it('shows disabled collection', async () => {
      expect(await render({ ...base, enabled: false })).toContain('  Collection: disabled');
    });

    it('has no Run line when nothing needs fixing and never a Hint line', async () => {
      const out = await render(base);
      expect(out).not.toContain('Run:');
      expect(out).not.toContain('Hint:');
    });

    it('prints the unaffected sentence with no label and no indentation', async () => {
      const sentence = (await render(base)).split('\n').at(-1) as string;
      expect(sentence).toBe(SENTENCE);
      expect(sentence).not.toMatch(/^\s/);
      expect(sentence).not.toContain('Not affected');
    });

    it('offers connect as the single Run line when hooks are not installed', async () => {
      const out = await render({
        ...base,
        hooksInstalled: false,
        scope: 'not-configured',
        current: { path: '/work/a', tracked: false, reason: 'hooks-not-installed' },
      });
      expect(out.split('\n')[0]).toBe('Hooks: not installed');
      expect(out.match(/Run:/g)).toHaveLength(1);
      expect(out).toContain('  Run: codemie proxy connect --claude-code-otlp');
      expect(out).toContain('not tracked (hooks-not-installed)');
      expect(out).not.toContain('Hint:');
    });

    it('puts the single advice command on the Run line when the directory is not tracked', async () => {
      const out = await render({
        ...base,
        excludedProjects: ['/work/a'],
        current: { path: '/work/a', tracked: false, reason: 'project-excluded' },
      });
      expect(out).toContain('  Current:    /work/a: not tracked (project-excluded)');
      expect(out.match(/Run:/g)).toHaveLength(1);
      expect(out).toContain('  Run: codemie proxy analytics include /work/a');
      expect(out).not.toContain('Hint:');
    });

    it('prefers connect over the advice command when both apply', async () => {
      const out = await render({
        ...base,
        hooksInstalled: false,
        scope: 'not-configured',
        enabled: false,
        current: { path: '/work/a', tracked: false, reason: 'disabled' },
      });
      expect(out.match(/Run:/g)).toHaveLength(1);
      expect(out).toContain('  Run: codemie proxy connect --claude-code-otlp');
    });

    it('puts prose advice into the not-tracked reason instead of a Run line', async () => {
      const out = await render({
        ...base,
        scope: 'project',
        trackedProjects: ['/work/other'],
        current: { path: '/work/a', tracked: false, reason: 'not-in-allowlist' },
      });
      expect(out).toContain(
        'not tracked (not-in-allowlist: run this inside that project: codemie proxy connect --claude-code-otlp --scope project)'
      );
      expect(out).not.toContain('Run:');
      expect(out).not.toContain('Hint:');
    });

    it('reports a corrupt preferences file on one line without a Run line, only when corrupt', async () => {
      expect(await render(base)).not.toContain('corrupt');
      const out = await render({
        ...base,
        preferencesCorrupt: true,
        current: { path: '/work/a', tracked: false, reason: 'preferences-corrupt' },
      });
      expect(out).toContain('  Preferences file is corrupt — collection is stopped. Fix or delete /x/claude-analytics.json.');
      expect(out).not.toContain('Run:');
      expect(out).not.toContain('Hint:');
    });
  });

  describe('formatCopilotAnalyticsStatus', () => {
    const base = {
      connector: 'copilot-cli-otlp',
      connected: true,
      scope: 'user' as const,
      trackedProjects: [] as string[],
      enabled: true,
      excludedProjects: [] as string[],
      preferencesCorrupt: false,
      preferencesPath: '/x/copilot-analytics.json',
      current: { path: '/work/a', tracked: true, reason: 'tracked' as const } as CopilotAnalyticsStatus['current'],
    };

    async function render(status: CopilotAnalyticsStatus): Promise<string> {
      const { formatCopilotAnalyticsStatus } = await import('../analytics-status.js');
      return stripVTControlCharacters(formatCopilotAnalyticsStatus(status));
    }

    it('prints a Connected headline, aligned details and the connector-specific unaffected sentence', async () => {
      expect(await render(base)).toBe(
        [
          'Connected: yes',
          '  Scope:      user',
          '  Collection: enabled',
          '  Excluded:   (none)',
          '  Current:    /work/a: tracked',
          'These settings do not affect managed `codemie copilot-cli` launches and the daily analytics collector.',
        ].join('\n')
      );
    });

    it('uses the Copilot Chat sentence for copilot-chat-otlp', async () => {
      const out = await render({ ...base, connector: 'copilot-chat-otlp' });
      expect(out.split('\n').at(-1)).toBe('These settings do not affect the daily analytics collector.');
    });

    it('offers connect as the single Run line when not connected', async () => {
      const out = await render({
        ...base,
        connected: false,
        scope: 'not-connected',
        current: { path: '/work/a', tracked: false, reason: 'scope-disabled' },
      });
      expect(out.split('\n')[0]).toBe('Connected: no');
      expect(out.match(/Run:/g)).toHaveLength(1);
      expect(out).toContain('  Run: codemie proxy connect --copilot-cli-otlp');
      expect(out).not.toContain('Hint:');
    });

    it('puts the include command on the Run line and prose advice into the reason', async () => {
      const excluded = await render({
        ...base,
        current: { path: '/work/a', tracked: false, reason: 'project-excluded' },
      });
      expect(excluded).toContain('  Run: codemie proxy analytics include /work/a --copilot-cli-otlp');

      const outside = await render({
        ...base,
        scope: 'project',
        trackedProjects: ['/work/other'],
        current: { path: '/work/a', tracked: false, reason: 'scope-untracked' },
      });
      expect(outside).toContain(
        'not tracked (scope-untracked: run this inside that project: codemie proxy connect --copilot-cli-otlp --scope project)'
      );
      expect(outside).not.toContain('Run:');
    });

    it('reports a corrupt preferences file as a plain line', async () => {
      const out = await render({
        ...base,
        preferencesCorrupt: true,
        current: { path: '/work/a', tracked: false, reason: 'preferences-corrupt' },
      });
      expect(out).toContain('  Preferences file is corrupt — collection is stopped. Fix or delete /x/copilot-analytics.json.');
      expect(out).not.toContain('Run:');
    });
  });
});
