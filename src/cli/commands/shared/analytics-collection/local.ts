/**
 * The collection of a machine in the local mode: no CodeMie backend; hooks spool through the local proxy daemon,
 * which moves every finished session into `~/.codemie/analytics/sessions`, and the daily sync delivers the OTLP file
 * of that folder.
 */
import { rm } from 'node:fs/promises';
import { ConfigurationError } from '@/utils/errors.js';
import { excludedSessionsRoot } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-exclusion-mark.js';
import { resolveMarkers } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder.js';
import { localSpoolRoot } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { loadSyncSettings } from '../../analytics/sync/config-store.js';
import { OtlpFolderSource } from '../../analytics/sync/otlp-file-builder.js';
import { includeExternalFor } from '../../analytics/sync/policy.js';
import { createRealStatusDeps } from '../../analytics/sync/status.js';
import type { SyncSettings } from '../../analytics/sync/types.js';
import { DEFAULT_DAEMON_PORT } from '../../proxy/connect-orchestrator.js';
import { isDaemonAlive, readState, stopDaemon, type DaemonState } from '../../proxy/daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from '../../proxy/daemon-lock.js';
import { ensureLocalOtlpProxy, restartLocalDaemon, startLocalDaemon } from '../../proxy/local-daemon.js';
import { parsePortOption } from '../../proxy/start.js';
import { localDoctorPlan } from './local-doctor.js';
import { LOCAL_CLIENTS, LOCAL_MODE_TEXT, localInstallPlan } from './local-install.js';
import { LocalPolicy } from './local-policy.js';
import type { AnalyticsCollection } from './types.js';

const STATUS_LINES = [`Mode: ${LOCAL_MODE_TEXT}`];

function refusal(): ConfigurationError {
  return new ConfigurationError(
    'This machine runs the local analytics mode of `codemie analytics sync`. Run `codemie analytics sync uninstall` first.'
  );
}

/** The sync settings, read again: whether the local mode is still installed. */
async function installed(): Promise<boolean> {
  return (await loadSyncSettings())?.local === true;
}

function printRunning(state: DaemonState): void {
  console.log(`The local analytics proxy is running on ${state.url}.`);
}

/**
 * The teardown of `sync uninstall`: the hooks of each client CodeMie has wired first — a client whose hooks are not
 * CodeMie's is not touched; then, in one hold of the daemon lock, the local daemon stopped, half-done moves undone,
 * the local spool and the exclusion marks removed, and the uninstall's own removal last, so no hook sees a stopped
 * daemon while `local` is still set. The analytics folder stays.
 */
async function teardown(removeInstall: () => Promise<void>): Promise<void> {
  for (const client of LOCAL_CLIENTS) {
    if (await client.hasEntries()) await client.remove();
  }
  await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
    const state = await readState();
    if (state?.mode === 'local' && (await isDaemonAlive(state))) await stopDaemon();
    await resolveMarkers();
    await rm(localSpoolRoot(), { recursive: true, force: true });
    await rm(excludedSessionsRoot(), { recursive: true, force: true });
    await removeInstall();
  });
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
    exportSource: () => new OtlpFolderSource(),
    install: localInstallPlan,
    teardown,
    statusLines: () => STATUS_LINES,
    doctor: localDoctorPlan(createRealStatusDeps(() => STATUS_LINES)),
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
