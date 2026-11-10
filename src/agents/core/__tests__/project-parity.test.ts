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
import { findNearestConfigDir, resolveProjectAtCwd, resolveSessionProject } from '../event-fields/identity-fields.js';
import { ClaudeCodeOtlpPlugin } from '../../plugins/claude-code-otlp/claude-code-otlp.plugin.js';
import { CopilotCliOtlpPlugin } from '../../plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.js';

// The real pin dir is resolved at import time under ~/.codemie; keep its first-write-wins semantics in memory.
const pins = vi.hoisted(() => new Map<string, string>());
vi.mock('../session-project-pin.js', () => ({
  readPinnedProjectName: async (id: string) => pins.get(id),
  pinProjectName: async (id: string, project: string) => (project ? (pins.get(id) ?? pins.set(id, project).get(id)!) : project),
}));

vi.mock('../copilot-analytics-gate.js', () => ({ evaluateCopilotAnalyticsGate: async () => ({ tracked: true }) }));

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

function adapter(run: AgentAdapter['run'], name = 'claude'): AgentAdapter {
  return {
    name, displayName: 'Claude Code', description: 'parity test adapter',
    metadata: { name: 'claude', displayName: 'Claude Code', description: 'parity test adapter', npmPackage: null, cliCommand: 'claude', envMapping: {}, supportedProviders: [] },
    install: async () => {}, uninstall: async () => {}, isInstalled: async () => true,
    run, getVersion: async () => null, getMetricsConfig: () => undefined,
  };
}

/** The project a managed launch hands the agent: its exported value, else the shell value it inherits. */
async function managedProject(cwd: string, options: Record<string, unknown> = {}, agent = 'claude'): Promise<string> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const run = vi.fn().mockResolvedValue(undefined);
  const cli = new AgentCLI(adapter(run, agent)) as unknown as { handleRun: (a: string[], o: Record<string, unknown>) => Promise<void> };
  await cli.handleRun([], { task: 'x', ...options });
  const env = run.mock.calls[0][1] as Record<string, string>;
  return env.CODEMIE_PROJECT ?? process.env.CODEMIE_PROJECT ?? '';
}

/** The project a native hook stamps for a session whose Claude Code was started in `cwd`. */
async function nativeProject(cwd: string): Promise<string> {
  vi.stubEnv('CLAUDE_PROJECT_DIR', cwd);
  return resolveSessionProject(cwd, 'native-session', { configuredWins: true });
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
    for (const key of [
      'CODEMIE_SESSION_ID', 'CODEMIE_PROJECT', 'CODEMIE_PROFILE_NAME', 'CODEMIE_PROJECT_BINDING', 'CLAUDE_PROJECT_DIR',
      'CODEMIE_PROVIDER', 'CODEMIE_BASE_URL', 'CODEMIE_API_KEY', 'CODEMIE_MODEL', 'CODEMIE_TIMEOUT', 'CODEMIE_URL', 'CODEMIE_AUTH_METHOD',
      'CODEMIE_INTEGRATION_ID', 'CODEMIE_INTEGRATION_ALIAS',
    ]) {
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
  describe('sibling behavior stays unchanged', () => {
    beforeEach(async () => {
      await writeGlobal({ g: { ...sso('g-project'), model: 'gpt-5' }, x: { ...sso('x-project'), model: 'gpt-5' } }, 'x');
      await writeLocal({ version: 2, activeProfile: 'g', profiles: {} });
    });

    it.each([
      ['claude', 'claude-sonnet-4'], ['claude-acp', 'claude-sonnet-4'], ['codex', 'gpt-5'], ['gemini', 'gemini-2.5-pro'], ['copilot-cli', 'gpt-5'],
    ])('the %s managed launcher also reads the repo .codemie from a subfolder', async (agent, model) => {
      await writeGlobal({ g: { ...sso('g-project'), model }, x: { ...sso('x-project'), model } }, 'x');
      expect(await managedProject(sub, {}, agent)).toBe('g-project');
      expect(await managedProject(repo, {}, agent)).toBe('g-project');
    });

    it('a hook without the Claude policy keeps "shell CODEMIE_PROJECT wins" (other OTLP adapters, proxy analytics)', async () => {
      vi.stubEnv('CLAUDE_PROJECT_DIR', sub);
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await resolveSessionProject(sub, 'sibling-session')).toBe('shell-project');
      expect(await resolveProjectAtCwd(sub)).toBe('shell-project');
    });

    it('a native Copilot hook (no CLAUDE_PROJECT_DIR) finds the repo config from a subfolder, like managed Copilot', async () => {
      const copilot = { configuredWins: true, walkFromCwd: true };
      expect(await resolveSessionProject(sub, 'cp-1', copilot)).toBe('g-project');
      expect(await resolveProjectAtCwd(sub, undefined, copilot)).toBe('g-project');
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await resolveSessionProject(sub, 'cp-2', copilot)).toBe('g-project');
    });

    it('without the policy the hook resolution is the plain one (other OTLP adapters, proxy analytics)', async () => {
      expect(await resolveSessionProject(sub, 'plain-1')).toBe('x-project');
    });

    it('only the Claude hook adapter opts into configured-wins', () => {
      const flag = (o: object) => (o as { configuredProjectWins: boolean }).configuredProjectWins;
      expect(flag(new ClaudeCodeOtlpPlugin())).toBe(true);
      expect(flag(new CopilotCliOtlpPlugin())).toBe(true);
    });

    it('a managed Claude session keeps its exported project even with the Claude policy', async () => {
      vi.stubEnv('CODEMIE_SESSION_ID', 'managed-1');
      vi.stubEnv('CODEMIE_PROJECT', 'exported-project');
      expect(await nativeProject(sub)).toBe('exported-project');
    });
  });

  describe('native Copilot CLI hook event (real plugin, real config)', () => {
    async function forwardedProject(cwd: string): Promise<unknown> {
      const sent: Record<string, unknown>[] = [];
      const deps = { ensureOtlpProxy: async () => {}, forwardOtlpEventsToSpool: async (events: Record<string, unknown>[]) => { sent.push(...events); return true; } };
      const raw = JSON.stringify({ sessionId: 'cp-sid', cwd, timestamp: 1700000000000, codemieEventName: 'sessionStart' });
      await new CopilotCliOtlpPlugin().processOtlpEvent(raw, deps as never);
      return sent[0]?.codemie_project_name;
    }

    it('from a subfolder stamps the repo config project, not a shell value, and not the global profile', async () => {
      await writeGlobal({ g: sso('g-project'), x: sso('x-project') }, 'x');
      await writeLocal({ version: 2, activeProfile: 'g', profiles: {} });
      vi.stubEnv('CODEMIE_PROJECT', 'shell-project');
      expect(await forwardedProject(sub)).toBe('g-project');
    });

    it('reads .env from the hook cwd, not from the config dir it walked to', async () => {
      await writeGlobal({ l: { provider: 'litellm', model: 'm', baseUrl: 'https://l.example.com', apiKey: 'k' } }, 'l');
      await writeLocal({ version: 2, activeProfile: 'l', profiles: {} });
      await fs.writeFile(path.join(sub, '.env'), 'CODEMIE_PROJECT=cwd-env-project'+String.fromCharCode(10));
      await fs.writeFile(path.join(repo, '.env'), 'CODEMIE_PROJECT=parent-env-project'+String.fromCharCode(10));
      expect(await forwardedProject(sub)).toBe('cwd-env-project');
    });
  });

  describe('Copilot folder-change recheck reads .env like the stamp does', () => {
    it('resolveProjectAtCwd takes the hook cwd .env, not the walked-to config dir .env', async () => {
      await writeGlobal({ l: { provider: 'litellm', model: 'm', baseUrl: 'https://l.example.com', apiKey: 'k' } }, 'l');
      await writeLocal({ version: 2, activeProfile: 'l', profiles: {} });
      await fs.writeFile(path.join(sub, '.env'), 'CODEMIE_PROJECT=cwd-env-project' + String.fromCharCode(10));
      await fs.writeFile(path.join(repo, '.env'), 'CODEMIE_PROJECT=parent-env-project' + String.fromCharCode(10));
      expect(await resolveProjectAtCwd(sub, undefined, { configuredWins: true, walkFromCwd: true })).toBe('cwd-env-project');
    });
  });

  describe('global config file is not a local override', () => {
    it('a workspace below the dir that holds the global .codemie is skipped on the way up', async () => {
      const ws = path.join(tmp, 'ws');
      const proj = path.join(ws, 'proj', 'sub');
      await fs.mkdir(proj, { recursive: true });
      await fs.mkdir(path.join(ws, '.codemie'), { recursive: true });
      vi.stubEnv('CODEMIE_HOME', path.join(ws, '.codemie'));
      await fs.writeFile(
        path.join(ws, '.codemie', 'codemie-cli.config.json'),
        JSON.stringify({ version: 2, activeProfile: 'x', profiles: { x: sso('x-project') } })
      );
      // A genuine local config further up (the real ancestors of the temp dir may hold one too) is found past the global file.
      await fs.mkdir(path.join(tmp, '.codemie'), { recursive: true });
      await fs.writeFile(path.join(tmp, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'x', profiles: {} }));
      expect(await findNearestConfigDir(proj)).toBe(tmp);
      expect(await managedProject(proj)).toBe('x-project');
      // The workspace root itself is the start dir: ordinary behavior, unchanged.
      expect(await findNearestConfigDir(ws)).toBe(ws);
    });
  });

  describe('.env stays in the launch cwd', () => {
    it('reads sub/.env, not the parent .env, while config comes from the repo .codemie', async () => {
      await writeGlobal({ g: sso('g-project') }, 'g');
      await writeLocal({ version: 2, activeProfile: 'g', profiles: {} });
      await fs.writeFile(path.join(sub, '.env'), 'CODEMIE_TIMEOUT=111\n');
      await fs.writeFile(path.join(repo, '.env'), 'CODEMIE_TIMEOUT=222\n');
      vi.spyOn(process, 'cwd').mockReturnValue(sub);
      const run = vi.fn().mockResolvedValue(undefined);
      const cli = new AgentCLI(adapter(run)) as unknown as { handleRun: (a: string[], o: Record<string, unknown>) => Promise<void> };
      await cli.handleRun([], { task: 'x' });
      expect((run.mock.calls[0][1] as Record<string, string>).CODEMIE_PROJECT).toBe('g-project');
      expect(process.env.CODEMIE_TIMEOUT).toBe('111');
    });
  });
});
