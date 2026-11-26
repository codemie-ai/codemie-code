/**
 * The proxy diagnosis of a machine in the local mode: no sign-in, upstream or delivery section — there is no CodeMie
 * backend — and one `local` section: the analytics folder, the scheduled job and the last delivery per target. No
 * hint names `proxy connect` or `proxy disconnect`, which the local mode refuses.
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyticsFolderRoot,
  folderSessionIdOf,
  MOVING_SUFFIX,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { ConfigurationError } from '@/utils/errors.js';
import type { TargetId } from '../../analytics/sync/run-sync.js';
import { resolveSchedulerName } from '../../analytics/sync/scheduler/index.js';
import { endedWithWarning, lastRunText, parseLastRun, readMarkerState, type StatusDeps } from '../../analytics/sync/status.js';
import type { SyncSettings } from '../../analytics/sync/types.js';
import { PROXY_DOCTOR_GROUPS, type ProxyDoctorGroup } from '../../proxy/doctor/groups.js';
import type { DoctorPlan, DoctorRemedies } from '../../proxy/doctor/plan.js';
import { guarded, type Sections } from '../../proxy/doctor/sections.js';

const INSTALL_COMMAND = 'codemie analytics sync install';
const REINSTALL_HINT = `Run \`${INSTALL_COMMAND}\` again.`;
const RUN_HINT = 'Run `codemie analytics sync run` to try again.';
const MARKER_HINT = 'Remove the delivery marker (`analytics-last-sent*` in the CodeMie home); the next delivery writes it again.';

export const LOCAL_REMEDIES: DoctorRemedies = {
  connect: () => INSTALL_COMMAND,
  disconnect: () => INSTALL_COMMAND,
  connectAnalytics: INSTALL_COMMAND,
  start: 'codemie proxy start, or the next Claude Code or Copilot event starts it',
  restart: 'codemie proxy restart',
  reconnect: `run \`${INSTALL_COMMAND}\``,
  // An excluded session carries an exclusion mark and is never gathered again.
  resumeNote: () => 'A session that fired an event while collection was off stays out; sessions started from now on are gathered.',
};

const BACKEND_ONLY_IDS: readonly string[] = ['auth', 'upstream', 'delivery'];

/** Today's groups without those of the sign-in, upstream and delivery, and the `local` group after the connectors. */
const LOCAL_GROUPS: readonly ProxyDoctorGroup[] = PROXY_DOCTOR_GROUPS
  .filter((group) => !group.ids.some((id) => BACKEND_ONLY_IDS.includes(id)))
  .flatMap((group) => (group.title === 'Analytics connectors'
    ? [group, { title: 'Local analytics', ids: ['local'] as const }]
    : [group]));

/** A folder file's write time; `undefined` when it is gone since the listing. */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The analytics folder: its sessions and the newest write, or a warning when it is missing. A file gone between the
 * listing and its `stat` is not counted.
 */
async function folderRows(): Promise<Sections> {
  const root = analyticsFolderRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [{ id: 'local', status: 'warn', message: `Local analytics folder is missing (${root})`, hint: REINSTALL_HINT }];
  }
  const listed = names.filter((name) => !name.endsWith(MOVING_SUFFIX) && folderSessionIdOf(name) !== undefined);
  const times = await Promise.all(listed.map((name) => mtimeOf(join(root, name))));
  const files = listed.filter((_, index) => times[index] !== undefined);
  const sessions = new Set(files.map(folderSessionIdOf)).size;
  if (files.length === 0) return [{ id: 'local', status: 'ok', message: 'Local analytics folder: 0 sessions' }];
  const newest = times.reduce<number>((max, time) => (time !== undefined && time > max ? time : max), -Infinity);
  return [{
    id: 'local',
    status: 'ok',
    message: `Local analytics folder: ${sessions} session${sessions === 1 ? '' : 's'}, newest ${new Date(newest).toISOString()}`,
  }];
}

/** The scheduled job of the saved name, and the Node and CLI its command was frozen with. */
async function jobRows(settings: SyncSettings, status: StatusDeps): Promise<Sections> {
  const name = resolveSchedulerName(settings, process.platform);
  const rows: Sections = (await status.schedulerFor(name).query()) === 'enabled'
    ? [{ id: 'local', status: 'ok', message: `Scheduled job ${name}: enabled` }]
    : [{ id: 'local', status: 'error', message: `Scheduled job ${name}: not registered or disabled`, hint: REINSTALL_HINT }];
  for (const path of [settings.localJob?.node, settings.localJob?.entry]) {
    if (path !== undefined && !existsSync(path)) {
      rows.push({
        id: 'local',
        status: 'error',
        message: `The scheduled job points at a missing Node or CLI (${path})`,
        hint: REINSTALL_HINT,
      });
    }
  }
  return rows;
}

function targetsOf(settings: SyncSettings): TargetId[] {
  return [
    ...(settings.webhookUrl !== undefined ? ['webhook' as const] : []),
    ...(settings.git !== undefined ? ['git' as const] : []),
  ];
}

/**
 * Per target: the last run from the run log, a warning when it failed or delivered with a warning, and the last
 * successful delivery from its marker; a marker that cannot be read warns on its own target's row and leaves every
 * other row. A target nothing was delivered to yet is no problem: a fresh install has none.
 */
async function deliveryRows(settings: SyncSettings, status: StatusDeps): Promise<Sections> {
  const log = await status.readLog();
  const now = status.now();
  const rows: Sections = [];
  for (const target of targetsOf(settings)) {
    const lastRun = log === null ? null : parseLastRun(log, target);
    const lastRunMessage = `Last run (${target}): ${lastRunText(lastRun)}`;
    if (lastRun !== null && (lastRun.outcome.startsWith('fail') || endedWithWarning(lastRun.outcome))) {
      rows.push({ id: 'local', status: 'warn', message: lastRunMessage, hint: RUN_HINT });
    } else {
      rows.push({ id: 'local', status: 'info', message: lastRunMessage });
    }
    const marker = await readMarkerState(status, target, now);
    if (marker.kind === 'none') {
      rows.push({ id: 'local', status: 'info', message: `Nothing delivered yet to ${target}` });
    } else if (marker.kind === 'unreadable') {
      rows.push({ id: 'local', status: 'warn', message: `Last delivery to ${target}: unknown (${marker.reason})`, hint: MARKER_HINT });
    } else {
      rows.push({ id: 'local', status: 'ok', message: `Last delivery to ${target}: ${marker.at.toISOString()}` });
    }
  }
  return rows;
}

async function installedSettings(status: StatusDeps): Promise<SyncSettings> {
  const settings = await status.loadSettings();
  if (settings === null) throw new ConfigurationError('analytics sync is not installed');
  return settings;
}

/** The folder and job rows, the ones `proxy analytics status` shows as its delivery health. */
async function folderAndJobRows(status: StatusDeps): Promise<Sections> {
  return [...(await folderRows()), ...(await jobRows(await installedSettings(status), status))];
}

/** The local mode's `DoctorPlan`; `status` gives the settings, the scheduler, the run log and the markers. */
export function localDoctorPlan(status: StatusDeps): DoctorPlan {
  return {
    remedies: LOCAL_REMEDIES,
    authSections: async () => [],
    deliverySections: async () => [],
    extraSections: () =>
      guarded('local', 'Local analytics', async () => [
        ...(await folderAndJobRows(status)),
        ...(await deliveryRows(await installedSettings(status), status)),
      ]),
    groups: LOCAL_GROUPS,
    daemonLabel: () => 'local analytics mode',
    nextSteps: () => ['codemie proxy start', 'codemie analytics sync status', 'codemie proxy doctor'],
    authProbe: () => false,
    statusLines: () => [],
    deliveryHealth: async ({ json }) => {
      const rows = await guarded('local', 'Local analytics', () => folderAndJobRows(status));
      const plain = rows.map(({ status: rowStatus, message, hint }) => ({ status: rowStatus, message, ...(hint !== undefined && { hint }) }));
      return {
        ...(json && { json: plain }),
        lines: plain.map((row) => (row.hint ? `${row.message} — ${row.hint}` : row.message)),
      };
    },
  };
}
