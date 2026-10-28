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
});
