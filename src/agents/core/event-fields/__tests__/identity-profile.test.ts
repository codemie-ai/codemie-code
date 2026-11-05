import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'profile-cwd-'));
  vi.stubEnv('CODEMIE_HOME', home);
  for (const key of ['CODEMIE_PROJECT', 'CODEMIE_PROFILE_CONFIG', 'CODEMIE_PROFILE_NAME', 'CLAUDE_PROJECT_DIR', 'CODEMIE_LAUNCH_MODE']) vi.stubEnv(key, '');
  vi.resetModules();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('resolves the real cwd with the frozen native profile after a global switch, but still detects a local project change', async () => {
  const profile = (project: string) => ({
    provider: 'ai-run-sso', baseUrl: 'https://api.example.com', model: 'model',
    codeMieUrl: 'https://api.example.com', codeMieProject: project,
  });
  const global = (activeProfile: string) => JSON.stringify({
    version: 2, activeProfile, profiles: { original: profile('proj-a'), other: profile('proj-b') },
  });
  await writeFile(join(home, 'codemie-cli.config.json'), global('original'));
  const cwd = join(home, 'repo');
  await mkdir(join(cwd, '.codemie'), { recursive: true });
  await writeFile(join(cwd, '.codemie', 'codemie-cli.config.json'), '{}');
  const { resolveProjectAtCwd, loadHookConfig } = await import('../identity-fields.js');
  expect((await loadHookConfig(cwd))?.config.name).toBe('original');
  expect(await resolveProjectAtCwd(cwd, 'original')).toBe('proj-a');
  await writeFile(join(home, 'codemie-cli.config.json'), global('other'));
  expect(await resolveProjectAtCwd(cwd)).toBe('proj-b');
  expect(await resolveProjectAtCwd(cwd, 'original')).toBe('proj-a');
  const moved = join(home, 'other-repo');
  await mkdir(join(moved, '.codemie'), { recursive: true });
  await writeFile(join(moved, '.codemie', 'codemie-cli.config.json'), JSON.stringify({
    version: 2, activeProfile: 'original', profiles: { original: profile('proj-c') },
    workspace: { codeMieUrl: 'https://api.example.com', codeMieProject: 'proj-c' },
  }));
  expect(await resolveProjectAtCwd(moved, 'original')).toBe('proj-c');
  expect(await resolveProjectAtCwd(cwd, 'deleted-profile')).toBe('');
});
