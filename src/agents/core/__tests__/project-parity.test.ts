/**
 * EPMCDME-16908: managed `codemie-claude` and native Claude Code with CodeMie hooks must select the
 * same CodeMie project from the repo root and from a subfolder. Real config files and real resolvers;
 * only the agent process (adapter.run), provider auth and the cwd are stubbed.
 * Managed consumer: the CODEMIE_PROJECT the launcher gives the agent (session/headers source).
 * Native consumer: resolveSessionProject(), which stamps the session record and events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import '../../../providers/index.js';
import { resolveSessionProject } from '../event-fields/identity-fields.js';

// The real pin dir is resolved at import time under ~/.codemie; keep its first-write-wins semantics in memory.
const pins = vi.hoisted(() => new Map<string, string>());
vi.mock('../session-project-pin.js', () => ({
  readPinnedProjectName: async (id: string) => pins.get(id),
  pinProjectName: async (id: string, project: string) => (project ? (pins.get(id) ?? pins.set(id, project).get(id)!) : project),
}));

let tmp: string;
let repo: string;
let sub: string;

const sso = (project?: string | null) => ({
  provider: 'ai-run-sso', authMethod: 'sso', model: 'm', baseUrl: 'https://g.example.com/code-assistant-api',
  ...(project === undefined ? {} : { codeMieProject: project }),
});

async function writeGlobal(profiles: Record<string, unknown>, activeProfile: string, workspace?: unknown): Promise<void> {
  await fs.writeFile(
    path.join(tmp, 'home', 'codemie-cli.config.json'),
    JSON.stringify({ version: 2, activeProfile, profiles, ...(workspace ? { workspace } : {}) })
  );
}

async function writeLocal(config: unknown): Promise<void> {
  await fs.writeFile(path.join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify(config));
}

function adapter(run: AgentAdapter['run']): AgentAdapter {
  return {
    name: 'claude', displayName: 'Claude Code', description: 'parity test adapter',
    metadata: { name: 'claude', displayName: 'Claude Code', description: 'parity test adapter', npmPackage: null, cliCommand: 'claude', envMapping: {}, supportedProviders: [] },
    install: async () => {}, uninstall: async () => {}, isInstalled: async () => true,
    run, getVersion: async () => null, getMetricsConfig: () => undefined,
  };
}

/** The project a managed launch hands the agent: its exported value, else the shell value it inherits. */
async function managedProject(cwd: string, options: Record<string, unknown> = {}): Promise<string> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const run = vi.fn().mockResolvedValue(undefined);
  const cli = new AgentCLI(adapter(run)) as unknown as { handleRun: (a: string[], o: Record<string, unknown>) => Promise<void> };
  await cli.handleRun([], { task: 'x', ...options });
  const env = run.mock.calls[0][1] as Record<string, string>;
  return env.CODEMIE_PROJECT ?? process.env.CODEMIE_PROJECT ?? '';
}

/** The project a native hook stamps for a session whose Claude Code was started in `cwd`. */
async function nativeProject(cwd: string): Promise<string> {
  vi.stubEnv('CLAUDE_PROJECT_DIR', cwd);
  return resolveSessionProject(cwd, 'native-session');
}

describe('managed and native Claude pick the same CodeMie project (EPMCDME-16908)', () => {
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBefore = { ...process.env };
    pins.clear();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codemie-parity-'));
    repo = path.join(tmp, 'repo');
    sub = path.join(repo, 'sub');
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
    await fs.mkdir(path.join(repo, '.codemie'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    vi.stubEnv('CODEMIE_HOME', path.join(tmp, 'home'));
    vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
    for (const key of ['CODEMIE_SESSION_ID', 'CODEMIE_PROJECT', 'CODEMIE_PROFILE_NAME', 'CODEMIE_PROJECT_BINDING', 'CLAUDE_PROJECT_DIR']) {
      vi.stubEnv(key, '');
      delete process.env[key];
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe('local activeProfile pointing to a global profile', () => {
    beforeEach(async () => {
      await writeGlobal({ g: sso('g-project'), x: sso('x-project') }, 'x');
      await writeLocal({ version: 2, activeProfile: 'g', profiles: {} });
    });

    it.each([['repo root', () => repo], ['subfolder', () => sub]])('from the %s', async (_name, dir) => {
      expect(await managedProject(dir())).toBe('g-project');
      expect(await nativeProject(dir())).toBe('g-project');
    });

    it('explicit --profile still wins over the local activeProfile', async () => {
      expect(await managedProject(sub, { profile: 'x' })).toBe('x-project');
    });

    it('a shell CODEMIE_PROJECT does not override the configured project in either mode (repo root, isolates the shell policy)', async () => {
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await managedProject(repo)).toBe('g-project');
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await nativeProject(repo)).toBe('g-project');
    });
  });

  describe('repo-owned profile with a workspace project', () => {
    beforeEach(async () => {
      await writeGlobal({ x: sso('x-project') }, 'x');
      await writeLocal({
        version: 2, activeProfile: 'team',
        profiles: { team: { name: 'team', ...sso() } },
        workspace: { codeMieProject: 'repo-project', codeMieUrl: 'https://g.example.com' },
      });
    });

    it.each([['repo root', () => repo], ['subfolder', () => sub]])('from the %s', async (_name, dir) => {
      expect(await managedProject(dir())).toBe('repo-project');
      expect(await nativeProject(dir())).toBe('repo-project');
    });
  });

  describe('local config without profile data', () => {
    it('uses the global active profile project in both modes', async () => {
      await writeGlobal({ x: sso('x-project') }, 'x');
      await writeLocal({ version: 2, activeProfile: 'x', profiles: {} });
      expect(await managedProject(sub)).toBe('x-project');
      expect(await nativeProject(sub)).toBe('x-project');
    });
  });

  describe('profile without a project', () => {
    it('a shell CODEMIE_PROJECT is the fallback in both modes', async () => {
      await writeGlobal({ l: { provider: 'litellm', model: 'm', baseUrl: 'https://l.example.com', apiKey: 'k' } }, 'l');
      await writeLocal({ version: 2, activeProfile: 'l', profiles: {} });
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await managedProject(sub)).toBe('shell-project');
      expect(await nativeProject(sub)).toBe('shell-project');
    });

    it('a profile that is off CodeMie never inherits a shell project in either mode', async () => {
      await writeGlobal({ off: sso(null) }, 'off');
      await writeLocal({ version: 2, activeProfile: 'off', profiles: {} });
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await managedProject(sub)).toBe('');
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await nativeProject(sub)).toBe('');
    });
  });
});
