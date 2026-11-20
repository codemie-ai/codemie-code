/**
 * Copilot usage from RUNNING WSL distros.
 *
 * Windows-only by nature: on macOS and Linux there is no `wsl.exe`, discovery returns no
 * distros, and the scan is a no-op that costs one failed lookup.
 *
 * Deliberate constraints carried over from the Python original:
 *   - A distro that is not running is never touched. Enumerating stopped distros over the 9P
 *     filesystem would start them as a side effect of running a report.
 *   - Every home is read in isolation; a denied or failing home is counted and skipped.
 *   - No home path, user name or hash ever reaches the health record — only counts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import { scanSessionEvents } from './events-reader.js';
import { scanSessionStore } from './store-reader.js';
import { emptyHealth, type CopilotScanResult, type CopilotUsageRow } from './types.js';

/** UNC roots exposing a distro's filesystem, newest naming first. */
const UNC_ROOTS = ['\\\\wsl.localhost', '\\\\wsl$'] as const;

/** Per-user home directories inside a distro. */
const HOME_PARENTS = ['home', 'root'] as const;

/** Copilot's home directory name inside a distro. */
const COPILOT_DIRNAME = '.copilot';

/** Seconds before a `wsl.exe` call is abandoned; a hung 9P mount must not hang a report. */
const WSL_TIMEOUT_MS = 10_000;

/** Distro names that are infrastructure, not user environments. */
const EXCLUDED_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/**
 * Names of the currently RUNNING distros.
 *
 * `wsl --list --running --quiet` writes UTF-16LE, so the output is decoded explicitly rather
 * than trusted to be UTF-8 (a UTF-8 read yields names interleaved with NUL bytes).
 */
export async function runningDistros(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const result = await exec('wsl.exe', ['--list', '--running', '--quiet'], { timeout: WSL_TIMEOUT_MS });
    if (result.code !== 0) {
      return [];
    }
    return Buffer.from(result.stdout, 'binary')
      .toString('utf-8')
      .split(/\r?\n/)
      // Strip NULs from a UTF-16LE payload that survived the pipe as single bytes.
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((name) => name.length > 0 && !EXCLUDED_DISTROS.has(name.toLowerCase()));
  } catch (error) {
    logger.debug('[copilot-local] wsl discovery failed:', error);
    return [];
  }
}

/** The UNC root that actually opens for `distro`, or undefined when none does. */
function distroRoot(distro: string): string | undefined {
  for (const root of UNC_ROOTS) {
    const path = join(root, distro);
    try {
      if (existsSync(path)) {
        return path;
      }
    } catch {
      // An unreachable UNC root throws rather than returning false; try the next spelling.
    }
  }
  return undefined;
}

/** Every `<home>/.copilot` directory inside a distro. */
function copilotHomes(distroRootPath: string): string[] {
  const homes: string[] = [];
  for (const parent of HOME_PARENTS) {
    const base = join(distroRootPath, parent);
    if (parent === 'root') {
      // /root is mode 700 on a standard distro and simply does not open over 9P; an
      // unreadable path here is expected, not an error.
      const direct = join(base, COPILOT_DIRNAME);
      try {
        if (existsSync(direct)) {
          homes.push(direct);
        }
      } catch {
        // Not readable; skip.
      }
      continue;
    }
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const home = join(base, entry.name, COPILOT_DIRNAME);
        if (existsSync(home)) {
          homes.push(home);
        }
      }
    } catch {
      // No /home in this distro, or it is not readable.
    }
  }
  return homes;
}

export interface WslScanOptions {
  maxAgeDays?: number;
}

/**
 * Scan every Copilot home in every running WSL distro.
 *
 * Each home goes through the same store and events readers as a native home, with the distro
 * name attached so its rows carry a `(WSL:<distro>)` surface.
 */
export async function scanWslHomes(opts: WslScanOptions = {}): Promise<CopilotScanResult> {
  const health = emptyHealth('copilot-cli-wsl');
  const rows: CopilotUsageRow[] = [];
  const coveredSessionIds = new Set<string>();

  const distros = await runningDistros();
  if (distros.length === 0) {
    return { rows, health, coveredSessionIds };
  }

  for (const distro of distros) {
    const root = distroRoot(distro);
    if (!root) {
      health.errors += 1;
      health.notes.push('a running distro exposed no readable UNC root');
      continue;
    }
    for (const home of copilotHomes(root)) {
      health.filesSeen += 1;
      try {
        const store = await scanSessionStore({ home, maxAgeDays: opts.maxAgeDays, wslDistro: distro });
        rows.push(...store.rows);
        health.rowsRead += store.health.rowsRead;
        health.rowsSkipped += store.health.rowsSkipped;
        health.errors += store.health.errors;

        const events = await scanSessionEvents({
          home,
          maxAgeDays: opts.maxAgeDays,
          wslDistro: distro,
          excludeSessionIds: store.coveredSessionIds,
        });
        rows.push(...events.rows);
        health.rowsRead += events.health.rowsRead;
        health.rowsSkipped += events.health.rowsSkipped;
        health.errors += events.health.errors;

        for (const id of [...store.coveredSessionIds, ...events.coveredSessionIds]) {
          coveredSessionIds.add(id);
        }
      } catch (error) {
        // One failing home never stops the others; the path is deliberately not logged.
        health.errors += 1;
        logger.debug('[copilot-local] wsl home scan failed:', error);
      }
    }
  }

  return { rows, health, coveredSessionIds };
}
