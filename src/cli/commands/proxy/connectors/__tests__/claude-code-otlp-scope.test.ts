/**
 * Claude Code's tracking scope: reading the project list and adding one project to it.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js')>()),
  getClaudeSettingsPath: () => join(tempDir, '.claude', 'settings.json'),
}));

const FILTER_ENV = 'CODEMIE_ANALYTICS_PROJECT_FILTER';

describe('claude-code-otlp scope', () => {
  let projects: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-claude-scope-'));
    vi.stubEnv('CODEMIE_HOME', join(tempDir, '.codemie'));
    projects = await Promise.all(['a', 'b', 'c'].map(async (name) => {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      return dir;
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function settings(): Promise<{ env: Record<string, string>; theme?: string }> {
    return JSON.parse(await readFile(join(tempDir, '.claude', 'settings.json'), 'utf-8'));
  }

  async function writeSettings(paths: string[]): Promise<void> {
    const { CODEMIE_ANALYTICS_PROJECT_FILTER_ENV } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js');
    expect(CODEMIE_ANALYTICS_PROJECT_FILTER_ENV).toBe(FILTER_ENV);
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    await writeFile(
      join(tempDir, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', env: { [FILTER_ENV]: JSON.stringify(paths) } }),
    );
  }

  it('reads a non-empty project list as project scope', async () => {
    await writeSettings([projects[0]]);
    const { readClaudeCodeOtlpScope } = await import('../claude-code-otlp-scope.js');

    await expect(readClaudeCodeOtlpScope()).resolves.toEqual({ scope: 'project', paths: [projects[0]] });
  });

  it('concurrent adds keep every project and the rest of the settings', async () => {
    await writeSettings([projects[0]]);
    const { addClaudeCodeOtlpProject } = await import('../claude-code-otlp-scope.js');

    await Promise.all([addClaudeCodeOtlpProject(projects[1]), addClaudeCodeOtlpProject(projects[2])]);

    const written = await settings();
    expect(JSON.parse(written.env[FILTER_ENV])).toHaveLength(3);
    expect(written.theme).toBe('dark');
  });

  it('refuses to add to a user-scope (empty) list', async () => {
    await writeSettings([]);
    const { addClaudeCodeOtlpProject } = await import('../claude-code-otlp-scope.js');

    await expect(addClaudeCodeOtlpProject(projects[1])).rejects.toThrow(/does not track a project list/);
  });
});
