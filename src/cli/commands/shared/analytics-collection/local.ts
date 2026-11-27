/**
 * The collection of a machine in the local mode: no CodeMie backend; hooks spool through the local proxy daemon,
 * which moves every finished session into `~/.codemie/analytics/sessions`, and the daily sync delivers the OTLP files
 * of that folder beside the JSON report every machine delivers.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { excludedSessionsRoot } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-exclusion-mark.js';
import { resolveMarkers } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder.js';
import { localSpoolRoot } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { loadSyncSettings } from '../../analytics/sync/config-store.js';
import { OtlpFolderSource } from '../../analytics/sync/otlp-file-builder.js';
import { includeExternalFor } from '../../analytics/sync/policy.js';
import { ReportSource } from '../../analytics/sync/report-builder.js';
import { createRealStatusDeps } from '../../analytics/sync/status.js';
import { errorMessage } from '../../analytics/sync/redact.js';
import type { ExportSource, SyncFiles, SyncReport, SyncSettings } from '../../analytics/sync/types.js';
import { DEFAULT_DAEMON_PORT } from '../../proxy/connect-orchestrator.js';
import { isDaemonAlive, readState, stopDaemon, type DaemonState } from '../../proxy/daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from '../../proxy/daemon-lock.js';
import { ensureLocalOtlpProxy, restartLocalDaemon, startLocalDaemon } from '../../proxy/local-daemon.js';
import { parsePortOption } from '../../proxy/start.js';
import { localDoctorPlan } from './local-doctor.js';
import { LOCAL_CLIENTS, localInstallPlan, localModeText } from './local-install.js';
import { LocalPolicy } from './local-policy.js';
import type { AnalyticsCollection } from './types.js';

/** The status lines, built when printed: the folder's path follows `CODEMIE_HOME`. */
const statusLines = (): string[] => [`Mode: ${localModeText()}`];

function refusal(): ConfigurationError {
  return new ConfigurationError(
    'This machine runs the local analytics mode of `codemie analytics sync`. Run `codemie analytics sync uninstall` first.'
  );
}

/** The sync settings, read again: whether the local mode is still installed. */
async function installed(): Promise<boolean> {
  return (await loadSyncSettings())?.local === true;
}

/**
 * Whether this machine holds a trace the local mode alone makes: a daemon state that says `local` (its daemon alive or
 * not), the local spool, or the exclusion marks. The analytics folder is none: it stays after an uninstall.
 */
export async function hasLocalModeTrace(): Promise<boolean> {
  return (await readState())?.mode === 'local' || existsSync(localSpoolRoot()) || existsSync(excludedSessionsRoot());
}

function printRunning(state: DaemonState): void {
  console.log(`The local analytics proxy is running on ${state.url}.`);
}

/**
 * The teardown of `sync uninstall`: each client holding any of CodeMie's own entries is cleared first — a client with
 * none of them is not touched; then, in one hold of the daemon lock, the local daemon stopped, half-done moves undone,
 * the local spool removed, the uninstall's own removal, so no hook sees a stopped daemon while `local` is still set,
 * and the exclusion marks last, so a failed step before them leaves no excluded session to be gathered again. A
 * failure to remove the marks is logged: by then the job and the settings are gone. The analytics folder stays.
 * Answers whether it took anything away: a client's entries, a live local daemon, the local spool or the marks.
 */
async function teardown(removeInstall: () => Promise<void>): Promise<boolean> {
  let tookAway = false;
  for (const client of LOCAL_CLIENTS) {
    if (await client.hasEntries()) {
      await client.remove();
      tookAway = true;
    }
  }
  await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
    const state = await readState();
    if (state?.mode === 'local' && (await isDaemonAlive(state))) {
      await stopDaemon();
      tookAway = true;
    }
    await resolveMarkers();
    if (existsSync(localSpoolRoot())) tookAway = true;
    await rm(localSpoolRoot(), { recursive: true, force: true });
    await removeInstall();
    if (existsSync(excludedSessionsRoot())) tookAway = true;
    await rm(excludedSessionsRoot(), { recursive: true, force: true }).catch((error: unknown) =>
      logger.warn(
        '[local] exclusion marks not removed',
        ...sanitizeLogArgs({ path: excludedSessionsRoot(), err: error instanceof Error ? error.message : String(error) })
      )
    );
  });
  return tookAway;
}

/**
 * The files of a local machine's run: the OTLP files of the analytics folder first, the JSON report last, both built
 * for the run's input; `null` when neither has anything. A build that throws holds the other's files back only when
 * those are none:
 * - the folder throws, a report is built — the report alone, with a warning that names the failure and keeps the
 *   run's marker; no report — the folder's error is the run's;
 * - the report throws, the folder built some file — the folder's files alone, the folder's `warning` and then the
 *   same kind of warning; the folder built nothing, or threw too — the report's error is the run's;
 * - neither throws — the folder's files and the report.
 * Every answer carries the folder's `warning` and `leftOut`; with nothing to deliver and either of them set the answer
 * is an empty list that carries them, not `null`. The one run where they are not seen: the folder built no file and
 * the report throws — the report's error is the run's.
 */
export class LocalExportSource implements ExportSource {
  constructor(
    private readonly folder: ExportSource = new OtlpFolderSource(),
    private readonly report: ExportSource = new ReportSource()
  ) {}

  async build(input: Parameters<ExportSource['build']>[0]): Promise<SyncFiles | null> {
    let folderFiles: SyncFiles = [];
    let folderError: unknown;
    try {
      folderFiles = (await this.folder.build(input)) ?? [];
    } catch (err) {
      folderError = err;
    }
    const leftOut = folderFiles.leftOut === undefined ? {} : { leftOut: folderFiles.leftOut };
    const folderWarning = folderFiles.warning === undefined ? {} : { warning: folderFiles.warning };
    let reportFiles: SyncReport[] = [];
    try {
      reportFiles = (await this.report.build(input)) ?? [];
    } catch (err) {
      if (folderError !== undefined || folderFiles.length === 0) throw err;
      const reportWarning = `JSON report not built, the marker stays and the next run tries it again: ${errorMessage(err)}`;
      return Object.assign([...folderFiles], {
        warning: [folderFiles.warning, reportWarning].filter((part) => part !== undefined).join('; '),
        ...leftOut,
      });
    }
    if (folderError !== undefined) {
      if (reportFiles.length === 0) throw folderError;
      return Object.assign([...reportFiles], {
        warning: `OTLP files not built, the marker stays and the next run tries them again: ${errorMessage(folderError)}`,
      });
    }
    const files = [...folderFiles, ...reportFiles];
    if (files.length === 0 && folderFiles.leftOut === undefined && folderFiles.warning === undefined) return null;
    return Object.assign(files, folderWarning, leftOut);
  }
}

/**
 * The local collection. `settings` are the installed sync settings; `null` only for `sync install` on a machine with
 * none yet, whose collection is used for its install plan alone.
 */
export function localCollection(settings: SyncSettings | null): AnalyticsCollection {
  return {
    hookPolicy: () => {
      if (settings === null) throw new ConfigurationError('Local analytics collection is not installed.');
      return new LocalPolicy(includeExternalFor(settings.includeExternal, process.platform));
    },
    launcher: (agentName, event) => ensureLocalOtlpProxy(installed, agentName, event),
    exportSource: () => new LocalExportSource(),
    install: localInstallPlan,
    teardown,
    statusLines,
    doctor: localDoctorPlan(createRealStatusDeps(statusLines)),
    guardProxyCommand: () => {
      throw refusal();
    },
    daemon: {
      async start(opts) {
        if (opts.profile !== undefined) throw refusal();
        const port = opts.port ? parsePortOption(opts.port, DEFAULT_DAEMON_PORT) : undefined;
        printRunning(await startLocalDaemon(installed, port));
      },
      async restart(opts) {
        if (opts.profile !== undefined) throw refusal();
        printRunning(await restartLocalDaemon(installed));
      },
    },
  };
}
