/**
 * The resolvers of the collection mode: the only places that decide which `AnalyticsCollection` a process runs.
 * A machine is in the local mode when its sync settings hold `local: true`; `sync install` turns it on for a machine
 * whose global CLI config holds no profile and where no CodeMie proxy runs against a backend.
 */
import { readFile } from 'node:fs/promises';
import { ConfigLoader } from '@/utils/config.js';
import { SyncConfigError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { loadSyncSettings } from '../../analytics/sync/config-store.js';
import type { SyncSettings } from '../../analytics/sync/types.js';
import { isDaemonAlive, readState } from '../../proxy/daemon-manager.js';
import { backendCollection } from './backend.js';
import type { AnalyticsCollection } from './types.js';

/** The local collection, loaded only on a machine that runs it. */
async function local(settings: SyncSettings | null): Promise<AnalyticsCollection> {
  return (await import('./local.js')).localCollection(settings);
}

/**
 * The collection of this machine, for every command and hook but `sync install`: the local one when the sync settings
 * hold `local: true`, else the backend one — settings that do not load included. Reads no credentials and no daemon
 * state.
 */
export async function resolveCollection(): Promise<AnalyticsCollection> {
  let settings: SyncSettings | null;
  try {
    settings = await loadSyncSettings();
  } catch (error) {
    logger.debug('[analytics-collection] sync settings not loaded; the backend collection runs', error);
    return backendCollection();
  }
  return settings?.local === true ? local(settings) : backendCollection();
}

/** Throws when the global CLI config exists and does not parse: such a file is not "no profile". */
async function assertGlobalConfigParses(): Promise<void> {
  const path = getCodemiePath('codemie-cli.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SyncConfigError(`The CodeMie CLI config at ${path} cannot be read: ${(error as Error).message}`);
  }
  try {
    JSON.parse(raw);
  } catch (error) {
    throw new SyncConfigError(`The CodeMie CLI config at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * The collection `sync install` installs, given the settings already installed (`null` for none or unreadable): local
 * when they hold `local: true`, or when the global CLI config holds no profile and no live proxy daemon runs with an
 * upstream; else the backend one, with the note that says why the local mode stays off.
 */
export async function resolveInstallCollection(
  previous: SyncSettings | null
): Promise<{ collection: AnalyticsCollection; note?: string }> {
  if (previous?.local === true) return { collection: await local(previous) };
  await assertGlobalConfigParses();
  const profiles = Object.keys((await ConfigLoader.loadMultiProviderConfig()).profiles);
  if (profiles.length > 0) {
    return {
      collection: backendCollection(),
      note: `Local analytics mode not turned on: this machine has a CodeMie CLI profile (${profiles.join(', ')}).`,
    };
  }
  const state = await readState();
  if (state?.targetUrl && (await isDaemonAlive(state))) {
    return {
      collection: backendCollection(),
      note: `Local analytics mode not turned on: a CodeMie proxy is running on this machine (${state.url}).`,
    };
  }
  return { collection: await local(previous) };
}
