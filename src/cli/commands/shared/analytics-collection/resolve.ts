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
import { loadSyncSettings, readSyncSettingsRaw } from '../../analytics/sync/config-store.js';
import type { SyncSettings } from '../../analytics/sync/types.js';
import { isDaemonAlive, readState } from '../../proxy/daemon-manager.js';
import { backendCollection } from './backend.js';
import type { AnalyticsCollection } from './types.js';

/** The local collection, loaded only on a machine that runs it. */
async function local(settings: SyncSettings | null): Promise<AnalyticsCollection> {
  return (await import('./local.js')).localCollection(settings);
}

/**
 * The local collection for the install of a machine not local yet: the sync settings file absent, or loaded with no
 * `local: true` — its plan stands down when no client could be set up. A file that exists and does not load, or that
 * cannot be read, keeps the failing plan: the machine may be local, and the failure restores the file as it was. The
 * read's error is not lost: the plan's settings step reads the file again and fails the install with it.
 */
async function localForInstall(previous: SyncSettings | null): Promise<AnalyticsCollection> {
  const collection = await local(previous);
  if (previous === null && (await readSyncSettingsRaw().catch(() => undefined)) !== null) return collection;
  return { ...collection, install: (await import('./local-install.js')).standingDownLocalInstallPlan };
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
  } catch {
    throw new SyncConfigError(`The CodeMie CLI config at ${path} is not valid JSON.`);
  }
}

/**
 * What puts this machine on the backend side of the border: a profile in the global CLI config (a legacy
 * single-provider config counts), else a live proxy daemon whose state holds an upstream; `null` for neither. Throws a
 * `SyncConfigError` when the global CLI config exists and cannot be read or does not parse.
 */
async function backendBorder(): Promise<{ profiles: string } | { proxyUrl: string } | null> {
  await assertGlobalConfigParses();
  const profiles = Object.keys((await ConfigLoader.loadMultiProviderConfig()).profiles);
  if (profiles.length > 0) return { profiles: profiles.join(', ') };
  const state = await readState();
  if (state?.targetUrl && (await isDaemonAlive(state))) return { proxyUrl: state.url };
  return null;
}

/**
 * The collection `sync install` installs, given the settings already installed (`null` for none or unreadable). In
 * order: the global CLI config must parse; then a profile in it, then a live proxy daemon with an upstream, each ends
 * the install's choice — on a machine whose settings hold `local: true` with a `SyncConfigError` that names how to
 * clear it or leave the local mode, on any other with the backend collection and the note that says why the local
 * mode stays off; then settings with `local: true` keep the local collection; else the local one for an install.
 */
export async function resolveInstallCollection(
  previous: SyncSettings | null
): Promise<{ collection: AnalyticsCollection; note?: string }> {
  const border = await backendBorder();
  const isLocal = previous?.local === true;
  if (border !== null && 'profiles' in border) {
    const names = border.profiles;
    if (isLocal) {
      throw new SyncConfigError(
        `This machine runs the local analytics mode and has a CodeMie CLI profile (${names}). Delete the profile, ` +
          'or run `codemie analytics sync uninstall` to leave the local mode.'
      );
    }
    return {
      collection: backendCollection(),
      note:
        `Local analytics mode not turned on: this machine has a CodeMie CLI profile (${names}). To turn it on, delete ` +
        'the profile and run this command again.',
    };
  }
  if (border !== null) {
    if (isLocal) {
      throw new SyncConfigError(
        `This machine runs the local analytics mode and a CodeMie proxy is running on it (${border.proxyUrl}), started from ` +
          "a project's own CodeMie config. Delete that project's profile (run `codemie profile delete` in the project) " +
          'and stop the proxy (`codemie proxy stop`), or run `codemie analytics sync uninstall` to leave the local mode.'
      );
    }
    return {
      collection: backendCollection(),
      note:
        `Local analytics mode not turned on: a CodeMie proxy is running on this machine (${border.proxyUrl}), started from a ` +
        "project's own CodeMie config. To turn it on, delete that project's profile (run `codemie profile delete` in " +
        'the project), stop the proxy (`codemie proxy stop`) and run this command again.',
    };
  }
  if (isLocal) return { collection: await local(previous) };
  return { collection: await localForInstall(previous) };
}

/**
 * The collection `sync uninstall` tears down. In order: sync settings that do not load — the backend collection, and
 * the uninstall stops on the file itself; settings with `local: true` — the local collection; a global CLI config that
 * cannot be read or does not parse — the backend collection; a profile, or a live proxy daemon with an upstream — the
 * backend collection; a trace of the local mode's own (a daemon state that says `local`, the local spool, the
 * exclusion marks) — the local collection, whatever the settings hold; else the backend collection.
 */
export async function resolveUninstallCollection(): Promise<AnalyticsCollection> {
  let settings: SyncSettings | null;
  try {
    settings = await loadSyncSettings();
  } catch (error) {
    logger.debug('[analytics-collection] sync settings not loaded; the backend collection runs', error);
    return backendCollection();
  }
  if (settings?.local === true) return local(settings);
  let border: Awaited<ReturnType<typeof backendBorder>>;
  try {
    border = await backendBorder();
  } catch (error) {
    if (!(error instanceof SyncConfigError)) throw error;
    logger.debug('[analytics-collection] the CLI config not read; the backend collection runs', error);
    return backendCollection();
  }
  if (border !== null) return backendCollection();
  const { hasLocalModeTrace } = await import('./local.js');
  return (await hasLocalModeTrace()) ? local(settings) : backendCollection();
}
