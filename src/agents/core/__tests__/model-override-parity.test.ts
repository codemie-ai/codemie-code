/**
 * A CODEMIE_MODEL override must read the same in the launch banner and in `codemie profile status`.
 * Real config files and real ConfigLoader; only the agent process (adapter.run), provider setup and
 * the cwd are stubbed. Launch side: the CODEMIE_MODEL_SOURCE, CODEMIE_MODEL_ENV_ORIGIN and
 * CODEMIE_PROFILE_MODEL the launcher hands the agent, and the banner text built from them.
 * Status side: the Model row text of `codemie profile status` (loadStatusConfig()).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import '../../../providers/index.js';
import { ConfigLoader } from '../../../utils/config.js';
import { createProfileCommand, loadStatusConfig } from '../../../cli/commands/profile/index.js';
import {
  describeModel,
  MODEL_ENV_ORIGIN_ENV,
  parseModelEnvOrigin,
  PROFILE_MODEL_ENV,
  recordSavedModelPick,
  resetModelOriginRecords,
} from '../../../utils/model-origin.js';

vi.mock('../copilot-analytics-gate.js', () => ({ evaluateCopilotAnalyticsGate: async () => ({ tracked: true }) }));

const PROFILE_MODEL = 'claude-sonnet-5';
const ENV_MODEL = 'claude-opus-4-8[1m]';

let tmp: string;
let repo: string;

function adapter(run: AgentAdapter['run']): AgentAdapter {
  return {
    name: 'claude', displayName: 'Claude Code', description: 'model override test adapter',
    metadata: { name: 'claude', displayName: 'Claude Code', description: 'model override test adapter', npmPackage: null, cliCommand: 'claude', envMapping: {}, supportedProviders: [] },
    install: async () => {}, uninstall: async () => {}, isInstalled: async () => true,
    run, getVersion: async () => null, getMetricsConfig: () => undefined,
  };
}

/** The env a managed launch from `cwd` hands the agent. */
async function launch(cwd: string, options: Record<string, unknown> = {}): Promise<Record<string, string>> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const run = vi.fn().mockResolvedValue(undefined);
  const cli = new AgentCLI(adapter(run)) as unknown as { handleRun: (a: string[], o: Record<string, unknown>) => Promise<void> };
  await cli.handleRun([], { task: 'x', ...options });
  return run.mock.calls[0][1] as Record<string, string>;
}

/** The banner's model text for a launch env. */
function bannerModel(env: Record<string, string>): string {
  return describeModel(env.CODEMIE_MODEL || 'unknown', parseModelEnvOrigin(env[MODEL_ENV_ORIGIN_ENV]), env[PROFILE_MODEL_ENV] || undefined);
}

describe('CODEMIE_MODEL override at launch', () => {
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBefore = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CODEMIE_')) delete process.env[key];
    }
    delete process.env.CLAUDE_PROJECT_DIR;
    resetModelOriginRecords();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codemie-model-override-'));
    repo = path.join(tmp, 'repo');
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
    await fs.mkdir(path.join(repo, '.codemie'), { recursive: true });
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    vi.stubEnv('CODEMIE_HOME', path.join(tmp, 'home'));
    vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
    await fs.writeFile(
      path.join(tmp, 'home', 'codemie-cli.config.json'),
      JSON.stringify({
        version: 2,
        activeProfile: 'p',
        profiles: {
          p: {
            provider: 'ai-run-sso', authMethod: 'sso', model: PROFILE_MODEL,
            baseUrl: 'https://g.example.com/code-assistant-api', codeMieProject: 'p-project',
          },
        },
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    resetModelOriginRecords();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('marks a shell override with the profile model it replaced', async () => {
    process.env.CODEMIE_MODEL = ENV_MODEL;
    const status = await loadStatusConfig(repo);
    const env = await launch(repo);

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'env', CODEMIE_MODEL_ENV_ORIGIN: 'shell', CODEMIE_PROFILE_MODEL: PROFILE_MODEL });
    expect(bannerModel(env)).toBe(`${ENV_MODEL} (CODEMIE_MODEL from shell env overrides profile: ${PROFILE_MODEL})`);
    expect(status.modelText).toBe(bannerModel(env));
  });

  it('marks a .env override', async () => {
    await fs.writeFile(path.join(repo, '.env'), `CODEMIE_MODEL=${ENV_MODEL}\n`);
    const status = await loadStatusConfig(repo);
    const env = await launch(repo);

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'env', CODEMIE_MODEL_ENV_ORIGIN: 'dotenv', CODEMIE_PROFILE_MODEL: PROFILE_MODEL });
    expect(bannerModel(env)).toBe(`${ENV_MODEL} (CODEMIE_MODEL from .env overrides profile: ${PROFILE_MODEL})`);
    expect(status.modelText).toBe(bannerModel(env));
  });

  it.each([
    ['not set', undefined],
    ['empty', ''],
  ])('reports the profile model when CODEMIE_MODEL is %s', async (_name, value) => {
    if (value !== undefined) process.env.CODEMIE_MODEL = value;
    const status = await loadStatusConfig(repo);
    const env = await launch(repo);

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'default', CODEMIE_MODEL_ENV_ORIGIN: '', CODEMIE_PROFILE_MODEL: '' });
    expect(bannerModel(env)).toBe(PROFILE_MODEL);
    expect(status.modelText).toBe(PROFILE_MODEL);
  });

  it('status from a repo subfolder reads the same .codemie as the launcher', async () => {
    const sub = path.join(repo, 'sub');
    await fs.mkdir(sub, { recursive: true });
    const globalPath = path.join(tmp, 'home', 'codemie-cli.config.json');
    const config = JSON.parse(await fs.readFile(globalPath, 'utf-8'));
    config.activeProfile = 'x';
    config.profiles.x = { ...config.profiles.p, model: 'x-model', codeMieProject: 'x-project' };
    await fs.writeFile(globalPath, JSON.stringify(config));
    await fs.writeFile(path.join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'p', profiles: {} }));
    process.env.CODEMIE_MODEL = ENV_MODEL;

    const status = await loadStatusConfig(sub);
    const env = await launch(sub);

    expect(status.configDir).toBe(repo);
    expect(status.config.name).toBe('p');
    expect(status.modelText).toBe(`${ENV_MODEL} (CODEMIE_MODEL from shell env overrides profile: ${PROFILE_MODEL})`);
    expect(status.modelText).toBe(bannerModel(env));
  });

  describe('the profile status command from a repo subfolder', () => {
    let sub: string;

    /** Console output of `codemie profile <args>` run from `cwd`, ANSI-free. */
    async function runProfile(cwd: string, args: string[]): Promise<string[]> {
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await createProfileCommand().parseAsync(args, { from: 'user' });
      // eslint-disable-next-line no-control-regex
      return log.mock.calls.map((call) => call.join(' ')).join('\n').replace(/\u001b\[[0-9;]*m/g, '').split('\n');
    }

    beforeEach(async () => {
      sub = path.join(repo, 'sub');
      await fs.mkdir(sub, { recursive: true });
      const globalPath = path.join(tmp, 'home', 'codemie-cli.config.json');
      const config = JSON.parse(await fs.readFile(globalPath, 'utf-8'));
      config.activeProfile = 'x';
      config.profiles.x = { ...config.profiles.p, model: 'x-model', codeMieProject: 'x-project' };
      await fs.writeFile(globalPath, JSON.stringify(config));
      await fs.writeFile(path.join(repo, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'p', profiles: {} }));
    });

    it('status shows a shell override and the nearest .codemie profile', async () => {
      process.env.CODEMIE_MODEL = ENV_MODEL;
      const lines = await runProfile(sub, ['status']);

      expect(lines.find((line) => line.includes('Model'))).toContain(
        `${ENV_MODEL} (CODEMIE_MODEL from shell env overrides profile: ${PROFILE_MODEL})`
      );
      expect(lines.join('\n')).toContain('p-project');
      expect(lines.join('\n')).not.toContain('x-project');
    });

    it('status shows a .env override read from the cwd', async () => {
      await fs.writeFile(path.join(sub, '.env'), `CODEMIE_MODEL=${ENV_MODEL}\n`);
      const lines = await runProfile(sub, ['status']);

      expect(lines.find((line) => line.includes('Model'))).toContain(
        `${ENV_MODEL} (CODEMIE_MODEL from .env overrides profile: ${PROFILE_MODEL})`
      );
      expect(lines.join('\n')).not.toContain('x-project');
    });

    it('status --show-sources labels the cwd .env model and reads the nearest .codemie', async () => {
      await fs.writeFile(path.join(sub, '.env'), `CODEMIE_MODEL=${ENV_MODEL}\n`);
      const lines = await runProfile(sub, ['status', '--show-sources']);

      expect(lines).toContainEqual(expect.stringContaining(`model: ${ENV_MODEL} (.env)`));
      expect(lines.find((line) => line.includes('codeMieProject:'))).toContain('p-project');
      expect(lines.join('\n')).not.toContain('x-project');
    });

    it('the profile list marks the nearest .codemie active profile, as the launcher uses it', async () => {
      const lines = await runProfile(sub, []);
      const active = lines.filter((line) => line.includes('(Active)'));

      expect(active).toHaveLength(1);
      expect(active[0]).toMatch(/│\s*p\s*\(Active\)/);
      expect(lines.join('\n')).toContain('Showing profiles from both local');
    });
  });

  it('counts an env model equal to the profile model as env, without a marker', async () => {
    process.env.CODEMIE_MODEL = PROFILE_MODEL;
    const env = await launch(repo);

    expect(env.CODEMIE_MODEL_SOURCE).toBe('env');
    expect(bannerModel(env)).toBe(PROFILE_MODEL);
  });

  it('ignores CODEMIE_MODEL when --profile is given', async () => {
    process.env.CODEMIE_MODEL = ENV_MODEL;
    const env = await launch(repo, { profile: 'p' });

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'default', CODEMIE_MODEL_ENV_ORIGIN: '', CODEMIE_PROFILE_MODEL: '' });
    expect(bannerModel(env)).toBe(PROFILE_MODEL);
  });

  it('shows no marker for --model', async () => {
    process.env.CODEMIE_MODEL = ENV_MODEL;
    const env = await launch(repo, { model: 'gpt-5' });

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'cli', CODEMIE_MODEL_ENV_ORIGIN: '', CODEMIE_PROFILE_MODEL: '' });
    expect(bannerModel(env)).toBe('gpt-5');
  });

  it('marks a codemie-copilot saved pick without naming CODEMIE_MODEL', async () => {
    process.env.CODEMIE_MODEL = ENV_MODEL;
    recordSavedModelPick(ENV_MODEL);
    const env = await launch(repo);

    expect(env).toMatchObject({ CODEMIE_MODEL_SOURCE: 'env', CODEMIE_MODEL_ENV_ORIGIN: 'saved', CODEMIE_PROFILE_MODEL: PROFILE_MODEL });
    expect(bannerModel(env)).toBe(`${ENV_MODEL} (your saved codemie-copilot --model pick, overrides profile: ${PROFILE_MODEL})`);
  });

  it('leaves both variables empty when the provider blanks CODEMIE_MODEL', async () => {
    process.env.CODEMIE_MODEL = ENV_MODEL;
    const exportProviderEnvVars = ConfigLoader.exportProviderEnvVars.bind(ConfigLoader);
    vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockImplementation((config) => ({
      ...exportProviderEnvVars(config),
      CODEMIE_MODEL: '',
    }));
    const env = await launch(repo);

    expect(env).toMatchObject({ CODEMIE_MODEL_ENV_ORIGIN: '', CODEMIE_PROFILE_MODEL: '' });
    expect(bannerModel(env)).toBe('unknown');
  });
});
