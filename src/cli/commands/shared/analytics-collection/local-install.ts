/**
 * The install of the local mode: the analytics folder and the settings with `local: true` first, so a hook fired
 * during the install already collects locally; then the local proxy daemon; then the hooks of each client found on
 * this machine. Each step is undone, last first, when the install fails after it; of the analytics folder and its
 * parents, only the directories this install made are removed, each while it is still empty.
 */
import { isCopilotConnectorEnabled } from '@/agents/core/copilot-connector-scope.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import {
  analyticsFolderRoot,
  ensureAnalyticsFolder,
  removeMadeAnalyticsFolder,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { CodeMieError, ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  deleteSyncSettings,
  readSyncSettingsRaw,
  restoreSyncSettingsRaw,
  writeSyncSettings,
} from '../../analytics/sync/config-store.js';
import type { SyncSettings } from '../../analytics/sync/types.js';
import { isMemberFound, type AnalyticsMember } from '../../proxy/analytics-clients.js';
import { requestedDaemonPort } from '../../proxy/connect-orchestrator.js';
import {
  hasClaudeCodeOtlpEntries,
  hasClaudeCodeOtlpHooks,
  readClaudeCodeSignalEndpoints,
  removeClaudeCodeOtlpConfig,
  writeClaudeCodeOtlpConfig,
} from '../../proxy/connectors/claude-code-otlp.js';
import {
  hasCopilotChatOtlpHooks,
  removeCopilotChatOtlpConfig,
  writeCopilotChatOtlpConfig,
} from '../../proxy/connectors/copilot-chat-otlp.js';
import {
  hasCopilotCliOtlpHooks,
  removeCopilotCliOtlpConfig,
  writeCopilotCliOtlpConfig,
} from '../../proxy/connectors/copilot-cli-otlp.js';
import { readState, stopDaemon } from '../../proxy/daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from '../../proxy/daemon-lock.js';
import { isLiveLocal, spawnLocalDaemon } from '../../proxy/local-daemon.js';
import type { InstallPlan, InstallStep, StepOutcome } from './types.js';

const CLIENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'Copilot CLI',
  'copilot-chat': 'Copilot Chat',
};

/**
 * The reason a client's writer refused, as the install's note: the writer's own fix (`--overwrite`, `proxy start`)
 * is left out — neither applies to this install.
 */
function skipNote(error: ConfigurationError): string {
  return error.message
    .split(' — ')[0]
    .replace('Claude Code settings already contain conflicting env values for: ', 'its settings already set ')
    .replace(/ or re-run with --overwrite[^.]*\.?$/, '');
}

interface LocalClient {
  name: string;
  member: AnalyticsMember;
  /**
   * The install's question: whether CodeMie had set the client up before this install — the hooks of Claude Code, the
   * enabled scope record of a Copilot client (what its writer writes last and the gate collects by). A client step
   * undoes its write only when this answered no.
   */
  setUp(): Promise<boolean>;
  /**
   * The teardown's question: whether any of CodeMie's own entries of the client is in place now — anything its
   * `remove` would take away; `sync uninstall` runs `remove` only then.
   */
  hasEntries(): Promise<boolean>;
  write(): Promise<void>;
  remove(): Promise<void>;
}

/** The clients of the local mode, in install order: what the install writes and `sync uninstall` removes. */
export const LOCAL_CLIENTS: readonly LocalClient[] = [
  {
    name: 'claude-code',
    member: 'claudeCodeOtlp',
    setUp: hasClaudeCodeOtlpHooks,
    hasEntries: hasClaudeCodeOtlpEntries,
    async write() {
      // A per-signal endpoint of the user's would keep that signal away from the local proxy.
      const signalEndpoints = await readClaudeCodeSignalEndpoints();
      if (signalEndpoints.length > 0) throw new ConfigurationError(`its settings already set ${signalEndpoints.join(', ')}`);
      if (!(await isLiveLocal(await readState(), false))) throw new CodeMieError('The local proxy stopped during the install.');
      await writeClaudeCodeOtlpConfig({ keepProjectList: true, promptStatus: null });
    },
    remove: async () => {
      await removeClaudeCodeOtlpConfig({});
    },
  },
  {
    name: 'copilot-cli',
    member: 'copilotCliOtlp',
    setUp: () => isCopilotConnectorEnabled(COPILOT_CLI_OTLP_AGENT_NAME),
    hasEntries: hasCopilotCliOtlpHooks,
    write: async () => {
      await writeCopilotCliOtlpConfig({ keepProjectList: true });
    },
    remove: async () => {
      await removeCopilotCliOtlpConfig();
    },
  },
  {
    name: 'copilot-chat',
    member: 'copilotChatOtlp',
    setUp: () => isCopilotConnectorEnabled(COPILOT_CHAT_OTLP_AGENT_NAME),
    hasEntries: hasCopilotChatOtlpHooks,
    write: async () => {
      await writeCopilotChatOtlpConfig({ keepProjectList: true });
    },
    remove: async () => {
      await removeCopilotChatOtlpConfig();
    },
  },
];

/** A Node system error of the filesystem (`EACCES`, `EPERM`, `EBUSY`, `EROFS`, …): its `code`, else null. */
function systemErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, errno, syscall } = error as { code?: unknown; errno?: unknown; syscall?: unknown };
  return typeof code === 'string' && typeof errno === 'number' && typeof syscall === 'string' ? code : null;
}

/**
 * A client's step: `absent` when the client is not on this machine; `skipped`, with no write attempted, when asking
 * for the client's entries before the write throws a `ConfigurationError` (a file that cannot be read or does not
 * parse). When the writer throws, its remover takes back what this write left: only when none of CodeMie's own
 * entries of the client was in place before the write and some is in place after it (a failed removal is logged and
 * changes neither the outcome nor the error); then the write's error decides: a `ConfigurationError` is `skipped`
 * with the writer's reason, a Node system error (a numeric `errno` and a string `syscall` beside its `code`) is
 * `skipped` with `its files could not be written (<code>)`, and any other error fails the install. The undo removes
 * the client's entries only when CodeMie had not set the client up before this step.
 */
function clientStep(spec: LocalClient): InstallStep {
  let added = false;
  return {
    name: spec.name,
    async apply(): Promise<StepOutcome> {
      if (!(await isMemberFound(spec.member, { insiders: false }))) return { name: spec.name, state: 'absent' };
      const before = await spec.setUp();
      let entriesBefore: boolean;
      try {
        entriesBefore = await spec.hasEntries();
      } catch (error) {
        if (error instanceof ConfigurationError) return { name: spec.name, state: 'skipped', note: skipNote(error) };
        throw error;
      }
      try {
        await spec.write();
      } catch (error) {
        if (!entriesBefore) {
          await (async () => {
            if (await spec.hasEntries()) await spec.remove();
          })().catch((removal: unknown) =>
            logger.debug(
              '[local-install] client removal after a failed write failed',
              ...sanitizeLogArgs({ client: spec.name, err: removal instanceof Error ? removal.message : String(removal) })
            )
          );
        }
        if (error instanceof ConfigurationError) return { name: spec.name, state: 'skipped', note: skipNote(error) };
        const code = systemErrorCode(error);
        if (code !== null) return { name: spec.name, state: 'skipped', note: `its files could not be written (${code})` };
        throw error;
      }
      added = !before;
      return { name: spec.name, state: 'done' };
    },
    async undo(): Promise<void> {
      if (added) await spec.remove();
    },
  };
}

/** What the settings step and the daemon step of one install share. */
interface InstallState {
  /** The settings file as it was before the install, `null` when there was none. */
  snapshot: string | null;
  /** The install started the local daemon. */
  started: boolean;
  /**
   * Whether a live local daemon ran before the settings step wrote anything: one a hook starts inside the install's
   * window, once `local: true` is written, is the install's to stop on undo.
   */
  liveBefore: boolean;
  madeFolder?: string;
}

async function restoreSettings(state: InstallState): Promise<void> {
  if (state.snapshot === null) await deleteSyncSettings();
  else await restoreSyncSettingsRaw(state.snapshot);
}

function settingsStep(settings: SyncSettings, state: InstallState): InstallStep {
  return {
    name: 'settings',
    async apply() {
      state.liveBefore = await isLiveLocal(await readState(), true);
      state.snapshot = await readSyncSettingsRaw();
      // An install leaves an empty folder, not a missing one: the doctor warns of a missing folder. Made before the
      // settings: a step that throws is not undone, so a folder that cannot be made must leave nothing written, and a
      // settings write that fails takes back the directories this step made, and fails with its own error.
      state.madeFolder = await ensureAnalyticsFolder();
      try {
        await writeSyncSettings({ ...settings, local: true });
      } catch (error) {
        await removeMadeAnalyticsFolder(state.madeFolder).catch((removal: unknown) =>
          logger.debug(
            '[local-install] analytics folder removal failed',
            ...sanitizeLogArgs({ err: removal instanceof Error ? removal.message : String(removal) })
          )
        );
        throw error;
      }
      return { name: 'settings', state: 'done' };
    },
    async undo() {
      await restoreSettings(state);
      await removeMadeAnalyticsFolder(state.madeFolder);
    },
  };
}

function daemonStep(state: InstallState): InstallStep {
  return {
    name: 'daemon',
    apply: () =>
      withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async (): Promise<StepOutcome> => {
        if (!(await isLiveLocal(await readState(), false))) {
          await spawnLocalDaemon(await requestedDaemonPort());
          state.started = true;
        }
        return { name: 'daemon', state: 'done' };
      }),
    // The settings go back first, so no hook starts the local daemon again once it is stopped. The daemon is stopped
    // when this install started it or when none was live before the settings step.
    undo: () =>
      withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
        try {
          await restoreSettings(state);
        } finally {
          if (state.started || !state.liveBefore) await stopDaemon();
        }
      }),
  };
}

function steps(settings: SyncSettings): InstallStep[] {
  const state: InstallState = { snapshot: null, started: false, liveBefore: false };
  return [settingsStep(settings, state), daemonStep(state), ...LOCAL_CLIENTS.map(clientStep)];
}

/** The local mode named in the install summary and in `sync status`, each under its own label; the folder's real path. */
export function localModeText(): string {
  return `local — delivers the OTLP files of ${analyticsFolderRoot()} beside the JSON report`;
}

/** The `Skipped:` and `Not installed:` lines of the client steps. */
function clientLines(clients: StepOutcome[]): string[] {
  const label = (outcome: StepOutcome): string => CLIENT_LABELS[outcome.name];
  const lines = clients
    .filter((outcome) => outcome.state === 'skipped')
    .map((skipped) => `  Skipped:          ${label(skipped)} — ${skipped.note}`);
  const absent = clients.filter((outcome) => outcome.state === 'absent').map(label);
  if (absent.length > 0) lines.push(`  Not installed:    ${absent.join(', ')}`);
  return lines;
}

/**
 * The local plan's conclusion for an install where no client could be set up — `noClient` — and the summary of one
 * where some client was.
 */
function concludeWith(
  noClient: (clients: StepOutcome[]) => ReturnType<InstallPlan['conclude']>
): InstallPlan['conclude'] {
  return (outcomes) => {
    const clients = outcomes.filter((outcome) => outcome.name in CLIENT_LABELS);
    if (!clients.some((outcome) => outcome.state === 'done')) return noClient(clients);
    const written = clients.filter((outcome) => outcome.state === 'done').map((outcome) => CLIENT_LABELS[outcome.name]);
    return {
      summary: [`  Mode:             ${localModeText()}`, `  Clients set up:   ${written.join(', ')}`, ...clientLines(clients)],
    };
  };
}

/** The local plan of a machine that may be local already: an install where no client could be set up fails. */
export const localInstallPlan: InstallPlan = {
  steps,
  settingsExtras: (job) => ({ local: true, localJob: { node: job.node, entry: job.entry } }),
  conclude: concludeWith(() => ({ summary: [], failure: 'No supported client could be set up (Claude Code, Copilot CLI, Copilot Chat).' })),
};

/**
 * The local plan of a machine that is not local yet: an install where no client could be set up stands down and goes
 * on without the local mode, delivering the JSON report.
 */
export const standingDownLocalInstallPlan: InstallPlan = {
  ...localInstallPlan,
  conclude: concludeWith((clients) => ({
    standDown: { undoFailed: 'The local mode was not turned on, and a step of the attempt could not be undone.' },
    summary: [
      '  Local mode:       not turned on — no supported client could be set up (Claude Code, Copilot CLI, Copilot Chat); the JSON report is delivered',
      ...clientLines(clients),
    ],
  })),
};
