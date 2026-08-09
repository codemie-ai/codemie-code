import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { logger } from '@/utils/logger.js';
import { preparePiAgentDir } from './pi.setup.js';
import { fetchAndBuildPiModels, classifyPiModel } from './pi.models.js';
import { getPiAgentDir, resolvePiSessionDir } from './pi.paths.js';
import {
  LEDGER_PATH_ENV,
  ensurePiCodeMieExtension,
  getPiRunLedgerPath,
  readPiRunLedger,
  type PiRunLedger,
} from './pi.extension.js';
import { resolve } from 'path';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { appendTranscriptMarker } from '../../core/session/session-origin-audit.js';
import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';
import { startPiIncrementalSync, stopPiIncrementalSync } from './pi.incremental-sync.js';
import { installRequiredPiPackages } from './pi.packages.js';
import { PiSessionAdapter } from './pi.session.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';

/**
 * Pi flags that select an existing session. Pi rejects `--session-id` when any of
 * them is present (`validateSessionIdFlags` in Pi's `main.ts` calls `process.exit(1)`),
 * so the injected id must be suppressed for these runs. `--fork` is deliberately
 * absent: Pi allows `--fork` together with `--session-id` and uses the id to name
 * the forked session.
 */
const PI_SESSION_SELECTION_FLAGS = ['--session', '--continue', '-c', '--resume', '-r'];

/**
 * Read the value of a `<flag> <value>` pair. Pi's parser only accepts the
 * space-separated form, so `--flag=value` is deliberately not matched, and it
 * assigns on every occurrence, so the last one wins.
 */
function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasSessionSelectionFlag(args: string[]): boolean {
  return PI_SESSION_SELECTION_FLAGS.some((flag) => args.includes(flag));
}

/**
 * Reconcile CodeMie's CLI surface with Pi's session flags before the run starts.
 *
 * Two argv-derived facts are needed later by hooks that cannot see argv:
 * `beforeRun` receives only `env`, and `enrichArgs` receives no env at all. Both
 * are published through `envOverrides`, which `BaseAgentAdapter` spreads into the
 * run-scoped `env` object that also reaches `onSessionEnd` and session discovery.
 */
export function preparePiInvocation(
  args: string[],
  envOverrides?: Record<string, string>
): { args: string[]; envOverrides: Record<string, string> } {
  // CodeMie declares `--resume <session-id>`, but Pi's `--resume`/`-r` is a boolean
  // that opens an interactive picker, which would leave the id as a bare positional
  // and send it to the model as a chat message. `--session <id>` is Pi's
  // value-taking "open this session and keep appending" flag. If the user also
  // passed `--session`, theirs wins in Pi and this pair is dropped rather than
  // rewritten, so a second `--session` cannot shadow it and the orphaned id cannot
  // leak into the conversation.
  const resumeIndex = args.indexOf('--resume');
  const hasResumeValue = resumeIndex !== -1 && resumeIndex + 1 < args.length;
  let piArgs = args;
  if (hasResumeValue) {
    piArgs = args.includes('--session')
      ? [...args.slice(0, resumeIndex), ...args.slice(resumeIndex + 2)]
      : args.map((arg, index) => (index === resumeIndex ? '--session' : arg));
  }

  const overrides: Record<string, string> = { ...envOverrides };

  // `--session-dir` is an unknown option to CodeMie's parser and reaches Pi verbatim,
  // so discovery would otherwise scan a directory Pi never writes to. Seed the raw
  // value; resolvePiSessionDir performs the tilde expansion Pi also applies.
  const sessionDir = readFlagValue(piArgs, '--session-dir');
  if (sessionDir) {
    overrides.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  }

  return { args: piArgs, envOverrides: overrides };
}

function buildPiHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'pi',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-pi',
  };
}

/**
 * Point the CodeMie session record at what the run actually produced.
 *
 * Three things are only knowable once Pi has exited, and each has a consumer that
 * silently degrades without it:
 *
 * - `correlation.agentSessionFile` — the analytics cost path resolves the native
 *   transcript through this field. Pi left it empty, so token and cost figures were
 *   never readable for a Pi session, and the report blamed a missing token reader.
 * - `correlation.agentSessionId` — the metrics aggregator prefers it when labelling
 *   the wire `session_id`, which should be Pi's id rather than CodeMie's.
 * - `workingDirectory` / `gitBranch` / `repository` — `--session <path>` runs the
 *   whole session under the transcript's cwd, which may be a different repository
 *   than the one CodeMie was launched from.
 */
async function correlateRunToSession(sessionId: string, ledger: PiRunLedger): Promise<void> {
  if (!ledger.primaryTranscript) return;

  try {
    const { SessionStore } = await import('../../core/session/SessionStore.js');
    const store = new SessionStore();
    const session = await store.loadSession(sessionId);
    if (!session) {
      logger.debug(`[pi] No session record for ${sessionId}; skipping correlation`);
      return;
    }

    session.correlation = {
      ...session.correlation,
      status: 'matched',
      agentSessionFile: ledger.primaryTranscript,
      ...(ledger.piSessionId && { agentSessionId: ledger.piSessionId }),
      detectedAt: Date.now(),
    };

    if (ledger.cwd && resolve(ledger.cwd) !== resolve(session.workingDirectory)) {
      logger.debug(`[pi] Session ran under ${ledger.cwd}, not ${session.workingDirectory}`);
      session.workingDirectory = ledger.cwd;
      const [branch, repository] = await Promise.all([
        detectGitBranch(ledger.cwd),
        detectGitRemoteRepo(ledger.cwd),
      ]);
      if (branch) session.gitBranch = branch;
      if (repository) session.repository = repository;
    }

    await store.saveSession(session);

    // Ownership sidecars, so analytics can tell a CodeMie-managed transcript from a
    // bare `pi` one.
    for (const transcript of ledger.transcripts) {
      appendTranscriptMarker(transcript, sessionId, 'pi');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[pi] Correlating the run to its session record failed (non-blocking): ${msg}`);
  }
}

export const PiPluginMetadata: AgentMetadata = {
  name: 'pi',
  displayName: 'Pi',
  description: 'Pi - open-source coding agent harness',
  npmPackage: '@earendil-works/pi-coding-agent',
  cliCommand: process.env.CODEMIE_PI_BIN || 'pi',

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  dataPaths: {
    home: '.pi',
  },

  /**
   * Pi names its resource directories differently from the scanner's defaults, so the
   * lifecycle metric counted zero of everything until this mapping existed:
   *
   * - `prompts/` holds Pi's prompt templates, its slash-command equivalent. Flat `.md`
   *   files, which is what the `commands` counter looks for.
   * - `extensions/` holds Pi's in-process hooks as `.ts`/`.js` files, which is what the
   *   `hooks` counter looks for.
   * - `skills/` is a directory per skill with a `SKILL.md` entry, matching the default.
   * - Pi has no agents or rules concept. The empty arrays are deliberate: they hold
   *   those categories at zero rather than scanning a directory Pi never reads.
   *
   * `global` is the user's own Pi home rather than the agent dir CodeMie redirects Pi
   * to (`<cwd>/.pi/codemie/agent`). That dir is a copy of this one plus CodeMie's own
   * metrics extension, so counting it would report our plumbing as a user-authored hook.
   */
  extensionsConfig: {
    project: '.pi',
    global: '~/.pi/agent',
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: [],
      commands: ['prompts'],
      skills: ['skills'],
      hooks: ['extensions'],
      rules: [],
    },
  },

  /**
   * MCP is not part of Pi core — Pi ships without it deliberately ("It intentionally
   * does not include built-in MCP", Pi's `docs/usage.md`). It arrives through the
   * `pi-mcp-adapter` package, which CodeMie installs for every managed Pi
   * (`REQUIRED_PI_PACKAGES` in `pi.packages.ts`), so under CodeMie the adapter is
   * effectively core and its servers are worth counting.
   *
   * The adapter merges six files, lowest precedence first: `~/.config/mcp/mcp.json`,
   * `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `<agentDir>/mcp.json`,
   * `<cwd>/.mcp.json`, `<cwd>/.pi/mcp.json`. Three scopes cannot hold six files, so the
   * two project files map directly and the four global ones become ordered candidates —
   * and note `readMCPFromSource` takes the first candidate that *parses*, it never
   * merges.
   *
   * `user` names the redirected agent dir, and deliberately **not** the user's own
   * `~/.pi/agent/mcp.json`. `beforeRun` always sets `PI_CODING_AGENT_DIR` to
   * `<cwd>/.pi/codemie/agent` and the adapter resolves `<agentDir>/mcp.json` through that
   * variable, so under CodeMie the home file is never one of the adapter's six sources.
   * Listing it would report servers this Pi does not load: `preparePiAgentDir` copies once
   * and returns early forever after, so a project whose copy predates the user's MCP setup
   * never acquires an `mcp.json` — a permanent state, not a first-run one — while the home
   * file keeps growing, because a bare `pi` writes precisely there. Worse, because
   * `readMCPFromSource` returns on the first candidate that *parses*, that phantom would
   * also hide `~/.agents/*` and `~/.config/mcp`, which the adapter genuinely does merge.
   * (This is the opposite call from `extensionsConfig.global` above, which avoids the copy
   * because CodeMie injects its own extension into it. Nothing injects MCP servers, so
   * here the copy is simply the truth.)
   *
   * The invariant that buys: every server reported is one this run actually loads.
   *
   * Knowingly an approximation otherwise:
   * - Under-counts the first run in a project, which reports zero user servers because the
   *   copy is made in `beforeRun`, after `onSessionStart` has already sent the metric.
   *   Self-healing from the second run on.
   * - Over-counts a server named in two scopes. The adapter merges those into one live
   *   server; `totalServers` sums the scopes, while `serverNames` stays deduplicated.
   * - Under-counts every global file after the first that parses, the legacy
   *   `mcp-servers` alias key, and any config written as true JSONC — the adapter strips
   *   comments before parsing, `readJsonFile` does not.
   * - Under-counts host-config imports (`hostConfigDiscovery: "on"`, or a per-file
   *   `"imports"` array), which pull servers from Claude/Codex/Cursor/VS Code files.
   *   Following a key into other files with other key names is beyond `navigateJsonPath`.
   *   Both mechanisms are opt-in and default off.
   *
   * Every one of those failures is silent: a wrong path and a genuinely MCP-less machine
   * are indistinguishable in the summary.
   */
  mcpConfig: {
    local: {
      path: '.pi/mcp.json',
      jsonPath: 'mcpServers',
    },
    project: {
      path: '.mcp.json',
      jsonPath: 'mcpServers',
    },
    user: {
      path: [
        '.pi/codemie/agent/mcp.json',
        '~/.agents/mcp/mcp.json',
        '~/.agents/mcp.json',
        '~/.config/mcp/mcp.json',
      ],
      jsonPath: 'mcpServers',
    },
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-pi',
  },

  /**
   * `--task` must become `-p`, not a bare positional. Pi treats a positional as an
   * opening prompt for an *interactive* session, so the TUI takes over the terminal
   * and the run never exits — while `-p` is Pi's "process the prompt and exit" mode
   * and consumes the argument that follows it as the prompt.
   */
  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      const cwd = process.cwd();
      await preparePiAgentDir(cwd);
      await fetchAndBuildPiModels(env, cwd);
      env.PI_CODING_AGENT_DIR = getPiAgentDir(cwd);

      // Have Pi report which transcripts this run writes, instead of inferring them
      // from the session directory after the fact. `preparePiAgentDir` skips the copy
      // when the agent dir already exists, so this runs unconditionally to pick up
      // asset changes after an upgrade.
      const extension = await ensurePiCodeMieExtension(cwd, env);
      if (extension.installed && env.CODEMIE_SESSION_ID) {
        const ledgerPath = getPiRunLedgerPath(env.CODEMIE_SESSION_ID);
        env[LEDGER_PATH_ENV] = ledgerPath;
        process.env[LEDGER_PATH_ENV] = ledgerPath;
      }

      // Honor session-directory overrides early so both Pi and discovery agree.
      const { sessionDir, isCustom } = resolvePiSessionDir(cwd, env);
      if (isCustom) {
        env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
        process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      }

      logger.debug('[pi] Configured PI_CODING_AGENT_DIR', { path: env.PI_CODING_AGENT_DIR });
      return env;
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const model = process.env.CODEMIE_MODEL;
      if (!model) {
        throw new Error('No model configured for codemie-pi. Run codemie setup to select a model.');
      }

      const classification = classifyPiModel(model);
      const providerId = classification.provider;

      // `--task` is not handled here: `flagMappings` rewrites it to Pi's `-p`, which
      // BaseAgentAdapter applies after this hook. Consuming it here would leave a bare
      // positional, and Pi treats a bare positional as an interactive opening prompt.
      const result = ['--provider', providerId, '--model', model, ...args];

      // Share CodeMie's session id with Pi so discovery can exact-match the
      // transcript. Pi exits with code 1 if this is combined with a flag that
      // already selects a session, so those runs correlate by run window instead.
      const sessionId = process.env.CODEMIE_SESSION_ID;
      if (sessionId && !result.includes('--session-id') && !hasSessionSelectionFlag(result)) {
        result.push('--session-id', sessionId);
      } else if (sessionId) {
        logger.debug('[pi] Skipping --session-id injection: argv already selects a session');
      }

      // Forward the effective session directory. beforeRun resolved it onto the run
      // env, which BaseAgentAdapter has already merged into process.env. A
      // user-supplied --session-dir is in argv already and takes precedence.
      if (!result.includes('--session-dir') && process.env.PI_CODING_AGENT_SESSION_DIR) {
        result.push('--session-dir', process.env.PI_CODING_AGENT_SESSION_DIR);
      }

      return result;
    },

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionStart',
            session_id: sessionId,
            transcript_path: '',
            permission_mode: 'default',
            cwd: process.cwd(),
            source: 'startup',
          },
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionStart hook failed (non-blocking): ${msg}`);
      }

      // A run killed with SIGKILL, or whose terminal was closed, never reaches onSessionEnd and
      // leaves its record `active` forever with no terminal metric. Recover those on the next
      // start. Fire-and-forget: a stranded earlier session must not delay this one.
      void reconcileStaleSessions('pi', env, buildPiHookConfig).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[pi] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });

      // Flush metrics during the run, so a hard kill loses at most one interval instead of the
      // whole session. Ledger-driven: it processes exactly the transcripts the extension
      // recorded, never a directory scan.
      startPiIncrementalSync({
        sessionId,
        metadata: PiPluginMetadata,
        buildContext: () => ({
          sessionId,
          apiBaseUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: 'codemie-pi',
          version: env.CODEMIE_CLI_VERSION ?? '',
          dryRun: false,
        }),
        ssoUrl: env.CODEMIE_URL,
        syncApiUrl: env.CODEMIE_SYNC_API_URL ?? env.CODEMIE_BASE_URL,
        cliVersion: env.CODEMIE_CLI_VERSION,
      });
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[pi] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      // Stop the mid-run flush FIRST, and wait for any tick already running: it appends to the
      // same metrics JSONL this final flush is about to, and two writers that both read the
      // existing record ids before either appends would upload every delta twice.
      await stopPiIncrementalSync(sessionId);

      // The extension recorded which transcripts this run wrote, from inside Pi.
      // Nothing else is claimed: a transcript absent from the ledger belongs to
      // another process, and uploading it would leak that session's prompts.
      const ledger = await readPiRunLedger(sessionId);

      // Slash commands never reach the transcript — Pi expands prompt templates into plain user
      // text before persisting — so the ledger is their only record. Hand them to the adapter the
      // hook pipeline will reach through the registry.
      try {
        const { AgentRegistry } = await import('../../registry.js');
        const adapter = AgentRegistry.getAgent('pi')?.getSessionAdapter?.();
        if (adapter instanceof PiSessionAdapter) {
          adapter.setLedgerInvocations({
            commandInvocations: ledger.commandInvocations,
            skillCommandInvocations: ledger.skillCommandInvocations,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[pi] Could not attach ledger invocations (non-blocking): ${msg}`);
      }
      if (!ledger.loaded) {
        logger.warn(
          '[pi] The CodeMie run ledger is missing, so this run\'s transcripts cannot be '
          + 'identified. Reporting session lifecycle only — no tool metrics for this session.'
        );
      } else if (ledger.transcripts.length === 0) {
        logger.debug('[pi] Run produced no transcript (session ended before its first reply)');
      }

      await correlateRunToSession(sessionId, ledger);

      const reason = env.CODEMIE_EXIT_SIGNAL
        ? `signal(${env.CODEMIE_EXIT_SIGNAL})`
        : exitCode === 0
          ? 'exit'
          : `exit(${exitCode})`;

      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            // Pi's own session id, so the backend joins on the agent's identity.
            session_id: ledger.piSessionId ?? sessionId,
            transcript_path: ledger.transcripts[0] ?? '',
            transcript_paths: ledger.transcripts.length > 0 ? ledger.transcripts : undefined,
            permission_mode: 'default',
            // `--session <path>` runs the whole session under the transcript's cwd.
            cwd: ledger.cwd ?? process.cwd(),
            reason,
          },
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionEnd hook failed (non-blocking): ${msg}`);
      }
    },
  },
};

export class PiPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(PiPluginMetadata);
    this.sessionAdapter = new PiSessionAdapter(PiPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * Translate CodeMie's session flags to Pi's and publish the argv-derived facts
   * that `beforeRun` and `enrichArgs` need but cannot read from argv themselves.
   */
  async run(
    args: string[],
    envOverrides?: Record<string, string>,
    runOptions?: { dryRun?: boolean },
  ): Promise<void> {
    const prepared = preparePiInvocation(args, envOverrides);
    return super.run(prepared.args, prepared.envOverrides, runOptions);
  }

  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
}
