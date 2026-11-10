import { join } from 'path';
import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { logger } from '@/utils/logger.js';
import { exec } from '@/utils/exec.js';
import { ConfigurationError } from '@/utils/errors.js';
import { buildPiModelsConfig, classifyPiModel } from '../pi/pi.models.js';
import { LEDGER_PATH_ENV, getPiRunLedgerPath } from '../pi/pi.extension.js';
import { PiSessionAdapter } from '../pi/pi.session.js';
import { endPiFamilySession, startPiFamilySession, type PiFamilyIdentity } from '../pi/pi.plugin.js';
import {
  OMP_LEDGER_EXTENSION_ENV,
  OMP_PROVIDERS_CONFIG_ENV,
  OMP_PROVIDERS_EXTENSION_ENV,
  ensureOmpLedgerExtension,
  ensureOmpProvidersExtension,
  removeOmpProvidersConfig,
  writeOmpProvidersConfig,
} from './omp.extension.js';

// Recommended oh-my-pi version, installed by `codemie install omp --supported`; a mismatch only
// produces a non-blocking notice. **UPDATE THIS WHEN BUMPING OMP VERSION**
const OMP_SUPPORTED_VERSION = '18.18.6';

const OMP_CLIENT_TYPE = 'codemie-omp';

const OMP_IDENTITY: PiFamilyIdentity = { agentName: 'omp', clientType: OMP_CLIENT_TYPE };

/**
 * Reconcile CodeMie's CLI surface with omp's session flags.
 *
 * CodeMie declares `--resume <session-id>`, but omp's `-r, --resume[=<id|path>]` takes its value
 * only in the `=` form — a space-separated id would be read as the prompt, and a bare `--resume`
 * opens an interactive picker. A user-supplied `--resume=<id>` is already in omp's form and is
 * left alone, as is a `--resume` followed by another flag (the picker).
 */
export function prepareOmpInvocation(args: string[]): string[] {
  const resumeIndex = args.indexOf('--resume');
  const value = resumeIndex === -1 ? undefined : args[resumeIndex + 1];
  if (value === undefined || value.startsWith('-')) return args;
  return [...args.slice(0, resumeIndex), `--resume=${value}`, ...args.slice(resumeIndex + 2)];
}

export const OmpPluginMetadata: AgentMetadata = {
  name: 'omp',
  displayName: 'Oh My Pi',
  description: 'Oh My Pi (omp) - batteries-included fork of the Pi coding agent',
  npmPackage: '@oh-my-pi/pi-coding-agent',
  supportedVersion: OMP_SUPPORTED_VERSION,
  cliCommand: process.env.CODEMIE_OMP_BIN || 'omp',

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  dataPaths: {
    home: '.omp',
  },

  /**
   * omp reads skills from `<agentDir>/skills` and extensions from `<agentDir>/extensions`
   * (`~/.omp/agent`, or `<cwd>/.omp` per project). The other categories are held at zero rather
   * than scanning directories whose omp meaning is not verified.
   */
  extensionsConfig: {
    project: '.omp',
    global: '~/.omp/agent',
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: [],
      commands: [],
      skills: ['skills'],
      hooks: ['extensions'],
      rules: [],
    },
  },

  /** omp keeps MCP servers in `mcp.json` (`mcpServers`), per project and under its agent dir. */
  mcpConfig: {
    local: {
      path: '.omp/mcp.json',
      jsonPath: 'mcpServers',
    },
    user: {
      path: '~/.omp/agent/mcp.json',
      jsonPath: 'mcpServers',
    },
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm', 'ollama'],

  ssoConfig: {
    enabled: true,
    clientType: OMP_CLIENT_TYPE,
  },

  /** `--task` becomes omp's `-p, --print` (process the prompt and exit) rather than an interactive opening prompt. */
  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      const sessionId = env.CODEMIE_SESSION_ID;

      // Have omp report which transcripts this run writes (the run ledger, shared with Pi).
      const ledger = await ensureOmpLedgerExtension(env);
      if (ledger.installed && ledger.path && sessionId) {
        const ledgerPath = getPiRunLedgerPath(sessionId);
        env[LEDGER_PATH_ENV] = ledgerPath;
        process.env[LEDGER_PATH_ENV] = ledgerPath;
        const entry = join(ledger.path, 'index.js');
        env[OMP_LEDGER_EXTENSION_ENV] = entry;
        process.env[OMP_LEDGER_EXTENSION_ENV] = entry;
      }

      // Route omp's model traffic through CodeMie: a run-scoped extension registers the providers.
      const providers = await ensureOmpProvidersExtension();
      if (!providers.installed || !providers.path) {
        throw new ConfigurationError(
          `Could not install the CodeMie providers extension for codemie-omp (${providers.reason ?? 'unknown'}). `
          + 'Reinstall @codemieai/code, or run codemie doctor.'
        );
      }
      const configPath = await writeOmpProvidersConfig(
        sessionId ?? `run-${process.pid}`,
        await buildPiModelsConfig(env)
      );
      const providersEntry = join(providers.path, 'index.js');
      for (const target of [env, process.env]) {
        target[OMP_PROVIDERS_CONFIG_ENV] = configPath;
        target[OMP_PROVIDERS_EXTENSION_ENV] = providersEntry;
      }

      logger.debug('[omp] Prepared CodeMie extensions', { ledger: ledger.installed, providers: providersEntry });
      return env;
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const model = process.env.CODEMIE_MODEL;
      if (!model) {
        throw new ConfigurationError('No model configured for codemie-omp. Run codemie setup to select a model.');
      }

      // Ollama models are served by the `ollama` provider the providers extension registers;
      // classifyPiModel only knows the CodeMie backends and would misroute them to `codemie-proxy`.
      const providerId = process.env.CODEMIE_PROVIDER === 'ollama'
        ? 'ollama'
        : classifyPiModel(model).provider;

      const extensions = [OMP_LEDGER_EXTENSION_ENV, OMP_PROVIDERS_EXTENSION_ENV]
        .map((name) => process.env[name])
        .filter((path): path is string => Boolean(path))
        .flatMap((path) => ['-e', path]);

      // `--task` is rewritten to `-p` by `flagMappings`, after this hook. omp has no
      // `--session-id`: the run ledger, not an injected id, ties transcripts to the run.
      return [...extensions, '--model', `${providerId}/${model}`, ...args];
    },

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      await startPiFamilySession(sessionId, env, OmpPluginMetadata, OMP_IDENTITY);
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      try {
        await endPiFamilySession(exitCode, env, OMP_IDENTITY);
      } finally {
        await removeOmpProvidersConfig(env[OMP_PROVIDERS_CONFIG_ENV]);
      }
    },
  },
};

export class OmpPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(OmpPluginMetadata);
    this.sessionAdapter = new PiSessionAdapter(OmpPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /** `omp --version` prints `omp/<semver>`; the compatibility check needs the bare version. */
  async getVersion(): Promise<string | null> {
    try {
      const result = await exec(this.metadata.cliCommand ?? 'omp', ['--version']);
      return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async run(
    args: string[],
    envOverrides?: Record<string, string>,
    runOptions?: { dryRun?: boolean },
  ): Promise<void> {
    try {
      return await super.run(prepareOmpInvocation(args), envOverrides, runOptions);
    } finally {
      // The providers file carries the run's key. onSessionEnd removes it after a real run, but
      // --dry-run and an abort between beforeRun and the spawn (e.g. no model) never reach it.
      await removeOmpProvidersConfig(process.env[OMP_PROVIDERS_CONFIG_ENV]);
    }
  }
}
