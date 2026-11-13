/**
 * Tests for `codemie proxy analytics status`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
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

// Real by default (a path that does not exist falls back to the last two segments); a test that needs a git
// remote name overrides it.
vi.mock('@/utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/processes.js')>();
  return { ...actual, resolveRepositoryName: vi.fn(actual.resolveRepositoryName) };
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
    // Back to the real implementation for the next test
    const { resolveRepositoryName } = await import('@/utils/processes.js');
    vi.mocked(resolveRepositoryName).mockReset();
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
      const status = await collectClaudeAnalyticsStatus();
      expect(status.hooksInstalled).toBe(false);
      expect(status.scope).toBe('not-configured');
      expect(status.enabled).toBe(true);
      expect(status.excludedProjects).toEqual([]);
      expect(status).not.toHaveProperty('current');
    });

    it('reports project scope with tracked projects', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(['/work/a', '/work/b']) },
      });
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus();
      expect(status.hooksInstalled).toBe(true);
      expect(status.scope).toBe('project');
      expect(status.trackedProjects).toEqual(['/work/a', '/work/b']);
    });

    it('reports Global scope together with the excluded projects', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: '[]' },
      });
      await writePreferences(JSON.stringify({ version: 1, enabled: true, excludedProjects: ['/work/a'] }));
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus();
      expect(status.scope).toBe('user');
      expect(status.excludedProjects).toEqual(['/work/a']);
    });

    it('reports an invalid allowlist as scope "invalid" (CR-004)', async () => {
      await writeSettings({
        hooks: { SessionStart: [HOOK_ENTRY] },
        env: { CODEMIE_ANALYTICS_PROJECT_FILTER: 'not-json' },
      });
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      const status = await collectClaudeAnalyticsStatus();
      expect(status.scope).toBe('invalid');
    });

    it('reports disabled when preferences disable collection', async () => {
      await writePreferences(JSON.stringify({ version: 1, enabled: false, excludedProjects: [] }));
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      expect((await collectClaudeAnalyticsStatus()).enabled).toBe(false);
    });

    it('reports a corrupt preferences file', async () => {
      await writePreferences('{not json');
      const { collectClaudeAnalyticsStatus } = await import('../analytics-status.js');
      expect((await collectClaudeAnalyticsStatus()).preferencesCorrupt).toBe(true);
    });
  });

  describe('formatClaudeAnalyticsStatus', () => {
    const SENTENCE = 'These settings do not affect the daily analytics collector and the session sync that `codemie claude` runs itself.';
    const base: ClaudeAnalyticsStatus = {
      hooksInstalled: true,
      scope: 'user',
      trackedProjects: [],
      enabled: true,
      excludedProjects: [],
      preferencesCorrupt: false,
      preferencesPath: '/x/claude-analytics.json',
    };

    async function render(status: ClaudeAnalyticsStatus): Promise<string[]> {
      const { formatClaudeAnalyticsStatus } = await import('../analytics-status.js');
      return stripVTControlCharacters(await formatClaudeAnalyticsStatus(status)).split('\n');
    }

    it('prints the Claude section as plain rows under a bold heading, then the unaffected sentence', async () => {
      const { formatClaudeAnalyticsStatus } = await import('../analytics-status.js');

      const raw = (await formatClaudeAnalyticsStatus(base)).split('\n');

      expect(raw[0]).toBe(chalk.bold('Claude:'));
      expect(raw.at(-1)).toBe(chalk.dim(`  ${SENTENCE}`));
      expect(await render(base)).toEqual([
        'Claude:',
        '  Hooks: installed',
        '  Scope: user',
        '  Collection: enabled',
        '  Excluded: none',
        '',
        `  ${SENTENCE}`,
      ]);
    });

    it('lists tracked and excluded projects one per line, as analytics project names', async () => {
      const { resolveRepositoryName } = await import('@/utils/processes.js');
      vi.mocked(resolveRepositoryName).mockImplementation(async (path) =>
        path === '/work/a' ? 'codemie-ai/codemie-code' : path === '/work/x' ? 'codemie-ai/api-gateway' : 'unused/name'
      );

      const lines = await render({
        ...base,
        scope: 'project',
        trackedProjects: ['/work/a', '/work/b'],
        excludedProjects: ['/work/x'],
      });

      expect(lines).toEqual([
        'Claude:',
        '  Hooks: installed',
        '  Scope: project',
        '  Tracked:',
        '    codemie-ai/codemie-code',
        '    unused/name',
        '  Collection: enabled',
        '  Excluded:',
        '    codemie-ai/api-gateway',
        '',
        `  ${SENTENCE}`,
      ]);
    });

    it('names a project that no longer exists by the last two segments of its path', async () => {
      const lines = await render({
        ...base,
        scope: 'project',
        trackedProjects: ['Z:\\no-such-dir\\Repositories\\codemie'],
        excludedProjects: ['/no-such-dir/work/legacy-app'],
      });

      expect(lines).toContain('    Repositories/codemie');
      expect(lines).toContain('    work/legacy-app');
    });

    it('reads an empty Tracked list as none under project scope', async () => {
      expect(await render({ ...base, scope: 'project' })).toContain('  Tracked: none');
    });

    it('omits Tracked for scopes other than project', async () => {
      expect((await render({ ...base, trackedProjects: ['/work/a'] })).join('\n')).not.toContain('Tracked:');
    });

    it('shows disabled collection', async () => {
      expect(await render({ ...base, enabled: false })).toContain('  Collection: disabled');
    });

    it('has no Run line when nothing needs fixing and no icons', async () => {
      const out = (await render(base)).join('\n');
      expect(out).not.toContain('Run:');
      for (const glyph of ['✓', '○', '⚠', '✗']) {
        expect(out).not.toContain(glyph);
      }
    });

    it('offers connect as the single Run hint when hooks are not installed', async () => {
      const lines = await render({ ...base, hooksInstalled: false, scope: 'not-configured' });

      expect(lines.slice(0, 4)).toEqual([
        'Claude:',
        '  Hooks: not installed',
        '      Run: codemie proxy connect --claude-code-otlp',
        '  Scope: not-configured',
      ]);
      expect(lines.join('\n').match(/Run:/g)).toHaveLength(1);
    });

    it('reports a corrupt preferences file as a row with its hint, only when corrupt', async () => {
      expect((await render(base)).join('\n')).not.toContain('corrupt');

      const lines = await render({ ...base, preferencesCorrupt: true });

      expect(lines.slice(-5, -2)).toEqual([
        '  Excluded: none',
        '  Preferences file is corrupt — collection is stopped',
        '      Fix or delete /x/claude-analytics.json.',
      ]);
      expect(lines.join('\n')).not.toContain('Run:');
    });
  });

  describe('formatCopilotAnalyticsStatus', () => {
    const base: CopilotAnalyticsStatus = {
      connector: 'copilot-cli-otlp',
      connected: true,
      scope: 'user',
      trackedProjects: [],
      enabled: true,
      excludedProjects: [],
      preferencesCorrupt: false,
      preferencesPath: '/x/copilot-analytics.json',
    };

    async function render(status: CopilotAnalyticsStatus): Promise<string[]> {
      const { formatCopilotAnalyticsStatus } = await import('../analytics-status.js');
      return stripVTControlCharacters(await formatCopilotAnalyticsStatus(status)).split('\n');
    }

    it('prints the Copilot section with a Connected row and the connector-specific unaffected sentence', async () => {
      expect(await render(base)).toEqual([
        'Copilot:',
        '  Connected: yes',
        '  Scope: user',
        '  Collection: enabled',
        '  Excluded: none',
        '',
        '  These settings do not affect managed `codemie copilot-cli` launches and the daily analytics collector.',
      ]);
    });

    it('uses the Copilot Chat sentence for copilot-chat-otlp', async () => {
      const lines = await render({ ...base, connector: 'copilot-chat-otlp' });
      expect(lines[0]).toBe('Copilot:');
      expect(lines.at(-1)).toBe('  These settings do not affect the daily analytics collector.');
    });

    it('offers connect as the single Run hint when not connected', async () => {
      const lines = await render({ ...base, connected: false, scope: 'not-connected', enabled: false });

      expect(lines).toEqual([
        'Copilot:',
        '  Connected: no',
        '      Run: codemie proxy connect --copilot-cli-otlp',
        '  Scope: not-connected',
        '  Collection: disabled',
        '  Excluded: none',
        '',
        '  These settings do not affect managed `codemie copilot-cli` launches and the daily analytics collector.',
      ]);
    });

    it('lists tracked projects under project scope', async () => {
      const lines = await render({ ...base, scope: 'project', trackedProjects: ['/no-such-dir/work/a'] });

      expect(lines).toContain('  Tracked:');
      expect(lines).toContain('    work/a');
    });

    it('reports a corrupt preferences file as a row with its hint', async () => {
      const lines = await render({ ...base, preferencesCorrupt: true });

      expect(lines).toContain('  Preferences file is corrupt — collection is stopped');
      expect(lines).toContain('      Fix or delete /x/copilot-analytics.json.');
    });
  });
});
