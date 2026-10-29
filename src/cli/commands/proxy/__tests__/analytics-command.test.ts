/**
 * Tests for `codemie proxy analytics` write commands (disable/enable/exclude/include).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let projectRoot: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
  };
});

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: () => projectRoot,
}));

describe('createProxyAnalyticsCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-analytics-cmd-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'codemie-analytics-proj-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function runCommand(args: string[]): Promise<void> {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(args, { from: 'user' });
  }

  async function readPreferences(): Promise<unknown> {
    const { getClaudeAnalyticsPreferencesPath } = await import(
      '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
    );
    return JSON.parse(await readFile(getClaudeAnalyticsPreferencesPath(), 'utf-8'));
  }

  it('disable sets enabled to false', async () => {
    await runCommand(['disable']);
    expect(await readPreferences()).toMatchObject({ enabled: false });
  });

  it('enable sets enabled back to true after disable', async () => {
    await runCommand(['disable']);
    await runCommand(['enable']);
    expect(await readPreferences()).toMatchObject({ enabled: true });
  });

  it('exclude with an explicit path adds its canonical form', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    const canonical = await canonicalizePath('/work/a');
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude with no path argument excludes the resolved project root', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude']);
    const canonical = await canonicalizePath(projectRoot);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [canonical] });
  });

  it('exclude twice keeps a single entry and prints Nothing to change', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [expect.any(String)] });
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  it('include removes a previously excluded path', async () => {
    await runCommand(['exclude', '/work/a']);
    await runCommand(['include', '/work/a']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include on a path that was never excluded prints Nothing to change and leaves the file unchanged', async () => {
    await runCommand(['disable']);
    const before = await readPreferences();
    logSpy.mockClear();
    await runCommand(['include', '/work/z']);
    expect(await readPreferences()).toEqual(before);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
  });

  const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

  it.runIf(isCaseInsensitiveFs)('exclude twice with different casing keeps a single entry (CR-003)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/WORK/A']);
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
  });

  it.runIf(isCaseInsensitiveFs)('include with different casing removes a previously excluded path (CR-003)', async () => {
    await runCommand(['exclude', '/work/a']);
    await runCommand(['include', '/WORK/A']);
    expect(await readPreferences()).toMatchObject({ excludedProjects: [] });
  });

  it('include of a subdirectory still excluded via its parent names the parent instead of claiming nothing is tracked (CR-003)', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    const parent = await canonicalizePath('/work/a');
    expect(prefs.excludedProjects).toEqual([parent]);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('include of a redundant nested entry does not claim success while the parent still excludes it', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a']);
    // Excluding a path already covered by a stored parent still creates a direct entry today
    // (addProjectPath only dedupes exact matches) — this reproduces a redundant child entry.
    await runCommand(['exclude', '/work/a/nested']);
    logSpy.mockClear();
    await runCommand(['include', '/work/a/nested']);

    const parent = await canonicalizePath('/work/a');
    const nested = await canonicalizePath('/work/a/nested');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).not.toContain(nested);
    expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
  });

  it('exclude of a path already covered by a stored parent reports Nothing to change instead of adding a redundant entry', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['exclude', '/work/a/nested']);

    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toHaveLength(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change');
  });

  it('excluding a parent after a child was already excluded drops the now-redundant child entry', async () => {
    const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
    await runCommand(['exclude', '/work/a/nested']);
    await runCommand(['exclude', '/work/a']);

    const parent = await canonicalizePath('/work/a');
    const prefs = (await readPreferences()) as { excludedProjects: string[] };
    expect(prefs.excludedProjects).toEqual([parent]);
  });

  it('status prints formatted output through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['status']);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Hooks:');
    expect(output).toContain('Excluded projects:');
  });

  it('status --json prints parseable JSON through the real command wiring (CR-004)', async () => {
    await runCommand(['exclude', '/work/a']);
    logSpy.mockClear();
    await runCommand(['status', '--json']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ excludedProjects: [expect.any(String)] });
  });

  it('createProxyAnalyticsCommand registers all five subcommands (CR-004)', async () => {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    const names = createProxyAnalyticsCommand()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['disable', 'enable', 'exclude', 'include', 'status']);
  });

  it('a corrupt preferences file exits with code 1 and is left unchanged', async () => {
    const { getClaudeAnalyticsPreferencesPath } = await import(
      '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
    );
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const path = getClaudeAnalyticsPreferencesPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{not json', 'utf-8');
    const before = await readFile(path, 'utf-8');

    process.exitCode = undefined;
    await runCommand(['disable']);

    expect(process.exitCode).toBe(1);
    expect(await readFile(path, 'utf-8')).toBe(before);
    process.exitCode = undefined;
  });

  describe('connector selection', () => {
    async function readCopilotRecord(connectorId: string): Promise<unknown> {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const file = JSON.parse(await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8')) as {
        connectors: Record<string, unknown>;
      };
      return file.connectors[connectorId];
    }

    async function fileExists(path: string): Promise<boolean> {
      const { access } = await import('node:fs/promises');
      return access(path).then(
        () => true,
        () => false
      );
    }

    it('no connector flag still targets claude-code-otlp and never creates the copilot file', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      await runCommand(['disable']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
      expect(await fileExists(getCopilotAnalyticsPreferencesPath())).toBe(false);
    });

    it('--claude-code-otlp is equivalent to the default', async () => {
      await runCommand(['disable', '--claude-code-otlp']);
      expect(await readPreferences()).toMatchObject({ enabled: false });
    });

    it('registers the three connector options on every subcommand', async () => {
      const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
      for (const sub of createProxyAnalyticsCommand().commands) {
        const flags = sub.options.map((o) => o.long);
        expect(flags).toEqual(
          expect.arrayContaining(['--claude-code-otlp', '--copilot-cli-otlp', '--copilot-chat-otlp'])
        );
      }
    });

    it('rejects more than one connector flag, exits 1 and writes nothing', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { getClaudeAnalyticsPreferencesPath } = await import(
        '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
      );
      process.exitCode = undefined;
      await runCommand(['disable', '--copilot-cli-otlp', '--copilot-chat-otlp']);
      expect(process.exitCode).toBe(1);
      expect(await fileExists(getCopilotAnalyticsPreferencesPath())).toBe(false);
      expect(await fileExists(getClaudeAnalyticsPreferencesPath())).toBe(false);
      process.exitCode = undefined;
    });

    it('rejects claude-code-otlp combined with a copilot flag', async () => {
      process.exitCode = undefined;
      await runCommand(['disable', '--claude-code-otlp', '--copilot-cli-otlp']);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it('disabling one copilot connector leaves the other copilot connector and claude untouched', async () => {
      await runCommand(['disable', '--copilot-cli-otlp']);
      expect(await readCopilotRecord('copilot-cli-otlp')).toMatchObject({ enabled: false });
      expect(await readCopilotRecord('copilot-chat-otlp')).toBeUndefined();
      const { getClaudeAnalyticsPreferencesPath } = await import(
        '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js'
      );
      expect(await fileExists(getClaudeAnalyticsPreferencesPath())).toBe(false);
    });
  });

  describe.each(['copilot-cli-otlp', 'copilot-chat-otlp'] as const)('%s analytics commands', (connectorId) => {
    const flag = `--${connectorId}`;

    async function readRecord(): Promise<{ enabled: boolean; excludedProjects: string[] }> {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const file = JSON.parse(await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8')) as {
        connectors: Record<string, { enabled: boolean; excludedProjects: string[] }>;
      };
      return file.connectors[connectorId];
    }

    it('disable then enable round-trips the enabled flag', async () => {
      await runCommand(['disable', flag]);
      expect((await readRecord()).enabled).toBe(false);
      await runCommand(['enable', flag]);
      expect((await readRecord()).enabled).toBe(true);
    });

    it('disable twice prints Nothing to change the second time', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['disable', flag]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it('success message names the Copilot connector, not Claude Code', async () => {
      logSpy.mockClear();
      await runCommand(['disable', flag]);
      const output = logSpy.mock.calls.flat().join(' ');
      expect(output).toContain('copilot-analytics.json');
      expect(output).not.toContain('Claude Code');
    });

    it('exclude with an explicit path stores its canonical form', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath('/work/a')]);
    });

    it('exclude with no path excludes the resolved project root', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath(projectRoot)]);
    });

    it('exclude twice keeps a single entry and prints Nothing to change', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it('include removes a previously excluded path', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['include', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([]);
    });

    it('include on a never-excluded path prints Nothing to change', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['include', '/work/z', flag]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change.');
    });

    it.runIf(isCaseInsensitiveFs)('exclude twice with different casing keeps a single entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['exclude', '/WORK/A', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
    });

    it.runIf(isCaseInsensitiveFs)('include with different casing removes the entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['include', '/WORK/A', flag]);
      expect((await readRecord()).excludedProjects).toEqual([]);
    });

    it('include of a subdirectory still excluded via its parent names the parent', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['include', '/work/a/nested', flag]);
      const parent = await canonicalizePath('/work/a');
      expect((await readRecord()).excludedProjects).toEqual([parent]);
      expect(logSpy.mock.calls.flat().join(' ')).toContain(`still excluded via ${parent}`);
    });

    it('exclude of a path already covered by a stored parent reports Nothing to change and adds no redundant entry', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['exclude', '/work/a/nested', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(1);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('Nothing to change');
    });

    it('excluding a parent after a child drops the now-redundant child entry', async () => {
      const { canonicalizePath } = await import('@/agents/core/project-allowlist.js');
      await runCommand(['exclude', '/work/a/nested', flag]);
      await runCommand(['exclude', '/work/a', flag]);
      expect((await readRecord()).excludedProjects).toEqual([await canonicalizePath('/work/a')]);
    });

    it('a sibling that merely shares a string prefix is not treated as covered by the excluded path', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      await runCommand(['exclude', '/work/ab', flag]);
      expect((await readRecord()).excludedProjects).toHaveLength(2);
    });

    it('status prints formatted output through the real command wiring', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag]);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Collection:');
      expect(output).toContain('Excluded projects:');
      expect(output).toContain('Current directory');
    });

    it('status --json prints a single parseable JSON document for this connector', async () => {
      await runCommand(['exclude', '/work/a', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag, '--json']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed).toMatchObject({
        connector: connectorId,
        enabled: true,
        excludedProjects: [expect.any(String)],
        preferencesCorrupt: false,
        connected: false,
      });
    });

    it('status reports disabled collection and the gate reason for the current directory', async () => {
      await runCommand(['disable', flag]);
      logSpy.mockClear();
      await runCommand(['status', flag, '--json']);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.enabled).toBe(false);
      expect(parsed.current).toMatchObject({ tracked: false, reason: 'analytics-disabled' });
    });

    it('a corrupt copilot preferences file exits with code 1 and is left unchanged', async () => {
      const { getCopilotAnalyticsPreferencesPath } = await import('@/agents/core/copilot-analytics-preferences.js');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = getCopilotAnalyticsPreferencesPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{not json', 'utf-8');
      const before = await readFile(path, 'utf-8');

      process.exitCode = undefined;
      await runCommand(['disable', flag]);

      expect(process.exitCode).toBe(1);
      expect(await readFile(path, 'utf-8')).toBe(before);
      process.exitCode = undefined;
    });
  });
});
