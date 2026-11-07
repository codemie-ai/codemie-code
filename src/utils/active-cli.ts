/**
 * Active CodeMie CLI check
 *
 * After a self-update, the `codemie` that is first on PATH may belong to a different (older)
 * install than the one just updated. This module finds that first `codemie`, reads its version
 * from disk and reports whether it is older than the version just installed.
 *
 * `codemie` itself is never spawned: only PATH lookup (`which` / `where.exe`) and file reads.
 */

import { readFile, realpath } from 'fs/promises';
import { getCommandPath } from '@/utils/processes.js';
import {
  getCodemieNpmPrefix,
  getCodemieOrGlobalNpmPrefix,
  getCodemiePackageDir,
  getLegacyNpmPrefixPath,
  getNpmBinDir
} from '@/utils/npm-prefix.js';
import { compareVersions, isValidSemanticVersion } from '@/utils/version-utils.js';
import { isSamePath } from '@/utils/paths.js';
import { getPathModule, isWindows } from '@/utils/platform.js';
import { logger } from '@/utils/logger.js';

const CLI_PACKAGE_NAME = '@codemieai/code';
const LOOKUP_TIMEOUT_MS = 5000;

/** The first `codemie` on PATH, as read from disk. */
export interface ActiveCli {
  /** Path `which` / `where.exe` returned for `codemie`. */
  path: string;
  /** Version in the package.json of the install that `path` belongs to. */
  version: string;
  /** npm prefix of that install, or `null` when it cannot be derived. */
  prefix: string | null;
}

export type ActiveCliLookup =
  | { status: 'found'; active: ActiveCli }
  | { status: 'unknown'; reason: string };

export type ActiveCliVerdict =
  | { status: 'current'; active: ActiveCli }
  | { status: 'stale'; active: ActiveCli; installedVersion: string; newPrefix: string | null }
  | { status: 'unknown'; reason: string };

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

async function readManifest(manifestPath: string): Promise<PackageManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as PackageManifest) : null;
  } catch {
    return null;
  }
}

async function lookupCommandPath(): Promise<string | null | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([getCommandPath('codemie'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Walk up from `startDir` to the first `package.json` and return its directory and manifest. */
async function findFirstManifest(
  startDir: string,
  platform: NodeJS.Platform
): Promise<{ dir: string; manifest: PackageManifest } | null> {
  const p = getPathModule(platform);
  let dir = startDir;
  for (;;) {
    const manifest = await readManifest(p.join(dir, 'package.json'));
    if (manifest) {
      return { dir, manifest };
    }
    const parent = p.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function resolvePackage(
  hit: string,
  platform: NodeJS.Platform
): Promise<{ dir: string; manifest: PackageManifest } | string> {
  const p = getPathModule(platform);

  if (isWindows(platform)) {
    // npm's win32 shims (`codemie`, `codemie.cmd`) sit in the prefix and point into node_modules.
    const prefixDir = p.dirname(hit);
    const shim = await readFile(hit, 'utf8');
    if (!/@codemieai[\\/]code/.test(shim)) {
      return 'first codemie on PATH is not an npm install of @codemieai/code';
    }
    const dir = getCodemiePackageDir(prefixDir, platform);
    const manifest = await readManifest(p.join(dir, 'package.json'));
    return manifest ? { dir, manifest } : 'package.json of the first codemie on PATH is unreadable';
  }

  const real = await realpath(hit);
  const found = await findFirstManifest(p.dirname(real), platform);
  return found ?? 'no package.json found above the first codemie on PATH';
}

/**
 * Find the first `codemie` on PATH and read its version from disk.
 *
 * Never throws: every failure is reported as `unknown` with a reason.
 */
export async function findActiveCli(
  platform: NodeJS.Platform = process.platform
): Promise<ActiveCliLookup> {
  try {
    const hit = await lookupCommandPath();
    if (hit === 'timeout') {
      return { status: 'unknown', reason: 'PATH lookup for codemie timed out' };
    }
    if (!hit) {
      return { status: 'unknown', reason: 'codemie not found on PATH' };
    }

    const resolved = await resolvePackage(hit, platform);
    if (typeof resolved === 'string') {
      return { status: 'unknown', reason: resolved };
    }

    const { dir, manifest } = resolved;
    if (manifest.name !== CLI_PACKAGE_NAME) {
      return { status: 'unknown', reason: 'first codemie on PATH belongs to a different package' };
    }
    if (typeof manifest.version !== 'string') {
      return { status: 'unknown', reason: 'first codemie on PATH has no readable version' };
    }

    return {
      status: 'found',
      active: {
        path: hit,
        version: manifest.version,
        prefix: getCodemieNpmPrefix(dir, platform)
      }
    };
  } catch (error) {
    return {
      status: 'unknown',
      reason: `could not inspect first codemie on PATH: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Compare the first `codemie` on PATH with the version that was just installed.
 *
 * Never throws. A prerelease or malformed version on either side is `unknown`.
 *
 * @param installedVersion - Version `npm install -g` just put on disk.
 * @param opts.withHint - Resolve the prefix of the new install for the fix hint (spawns `npm`
 *   when CodeMie's own prefix cannot be derived), only needed when the warning is printed.
 */
export async function verifyActiveCli(
  installedVersion: string,
  opts: { withHint?: boolean } = {}
): Promise<ActiveCliVerdict> {
  const unknown = (reason: string): ActiveCliVerdict => {
    logger.debug(`Active codemie check skipped: ${reason}`);
    return { status: 'unknown', reason };
  };

  try {
    if (!isValidSemanticVersion(installedVersion)) {
      return unknown(`installed version "${installedVersion}" is not a plain semantic version`);
    }

    const lookup = await findActiveCli();
    if (lookup.status === 'unknown') {
      return unknown(lookup.reason);
    }

    const { active } = lookup;
    if (!isValidSemanticVersion(active.version)) {
      return unknown(`active version "${active.version}" is not a plain semantic version`);
    }

    if (compareVersions(active.version, installedVersion) >= 0) {
      return { status: 'current', active };
    }

    let newPrefix: string | null = null;
    if (opts.withHint) {
      try {
        newPrefix = await getCodemieOrGlobalNpmPrefix();
      } catch (error) {
        logger.debug('Could not resolve npm prefix of the new install:', error);
      }
    }

    return { status: 'stale', active, installedVersion, newPrefix };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Plain-text warning lines for a stale active install. Lines indented by four spaces are
 * commands; callers may style them differently.
 */
export function formatStaleWarning(
  verdict: Extract<ActiveCliVerdict, { status: 'stale' }>,
  platform: NodeJS.Platform = process.platform
): string[] {
  const { active, installedVersion, newPrefix } = verdict;
  const p = getPathModule(platform);
  const activeDir = p.dirname(active.path);

  const lines: string[] = [
    `⚠ The codemie on your PATH is older than the version just installed.`,
    `  Active:    ${active.path} (version ${active.version})`,
    `  Installed: ${installedVersion}`,
    ``,
    `  To use the new version:`
  ];

  if (newPrefix) {
    lines.push(`  - Put "${getNpmBinDir(newPrefix, platform)}" ahead of "${activeDir}" on your PATH`);
  } else {
    lines.push(`  - Put the bin directory of the new install ahead of "${activeDir}" on your PATH`);
  }

  if (active.prefix) {
    if (isSamePath(active.prefix, getLegacyNpmPrefixPath(platform), platform)) {
      lines.push(`  - Or rerun the CodeMie installer, or run \`codemie doctor\``);
    } else {
      lines.push(`  - Or remove the old install:`);
      lines.push(`    npm uninstall -g ${CLI_PACKAGE_NAME} --prefix "${active.prefix}"`);
    }
  }

  lines.push(`  Then open a new terminal.`);
  return lines;
}
