/**
 * Materializes the CodeMie extensions a managed oh-my-pi run loads, and the per-run provider
 * list one of them reads.
 *
 * Unlike Pi, `codemie omp` never redirects omp's agent directory or writes into `~/.omp`: the
 * user's omp config, sessions and extensions stay untouched. Everything CodeMie adds lives under
 * the CodeMie home and reaches omp through explicit `-e <file>` flags.
 */

import { chmod, mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { logger } from '@/utils/logger.js';
import { getCodemiePath, getDirname } from '@/utils/paths.js';
import {
  DISABLE_ENV,
  getLedgerExtensionSourceDir,
  installCodeMieExtension,
  type PiExtensionStatus,
} from '../pi/pi.extension.js';
import type { PiModelsConfig } from '../pi/pi.models.js';

/** Absolute path of the run-ledger extension entry, set when it was installed for this run. */
export const OMP_LEDGER_EXTENSION_ENV = 'CODEMIE_OMP_LEDGER_EXTENSION';
/** Absolute path of the providers extension entry, set when it was installed for this run. */
export const OMP_PROVIDERS_EXTENSION_ENV = 'CODEMIE_OMP_PROVIDERS_EXTENSION';
/** Absolute path of the JSON file the providers extension reads. */
export const OMP_PROVIDERS_CONFIG_ENV = 'CODEMIE_OMP_PROVIDERS';

const LEDGER_DIR_NAME = 'codemie-metrics';
const PROVIDERS_DIR_NAME = 'codemie-providers';

/** `~/.codemie/omp/extensions` — where the CodeMie-owned omp extensions are materialized. */
export function getOmpExtensionsDir(): string {
  return getCodemiePath('omp', 'extensions');
}

/** `~/.codemie/omp/providers/<sessionId>.json` — this run's provider/model list. */
export function getOmpProvidersConfigPath(sessionId: string): string {
  return getCodemiePath('omp', 'providers', `${sessionId}.json`);
}

/** Install the run-ledger extension (shared with Pi) outside omp's own directories. */
export function ensureOmpLedgerExtension(env: NodeJS.ProcessEnv): Promise<PiExtensionStatus> {
  return installCodeMieExtension(
    join(getOmpExtensionsDir(), LEDGER_DIR_NAME),
    getLedgerExtensionSourceDir(),
    env[DISABLE_ENV] === '1'
  );
}

/** Install the providers extension that registers this run's models with omp. */
export function ensureOmpProvidersExtension(): Promise<PiExtensionStatus> {
  return installCodeMieExtension(
    join(getOmpExtensionsDir(), PROVIDERS_DIR_NAME),
    join(getDirname(import.meta.url), 'extension')
  );
}

/**
 * Write the provider list for this run. The file carries the run's base URL and key, so it is
 * owner-readable only and removed again by {@link removeOmpProvidersConfig} when the run ends.
 */
export async function writeOmpProvidersConfig(
  sessionId: string,
  config: PiModelsConfig
): Promise<string> {
  const path = getOmpProvidersConfigPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config), { encoding: 'utf-8', mode: 0o600 });
  // `mode` only applies on creation; a file left by an earlier run of the same session keeps its own.
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

/** Best-effort removal of this run's provider list. */
export async function removeOmpProvidersConfig(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await rm(path, { force: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[omp] Could not remove ${path}: ${message}`);
  }
}
