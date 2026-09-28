/**
 * npm Prefix Utilities
 *
 * Derives the npm global prefix implied by CodeMie's own running install
 * location, so self-update installs, uninstalls and version checks target
 * the running copy instead of npm's own global prefix.
 */

import path from 'path';
import { existsSync } from 'fs';
import os, { homedir } from 'os';
import { getDirname } from '@/utils/paths.js';
import { exec } from '@/utils/exec.js';

export const CODEMIE_PACKAGE = '@codemieai/code';

const WIN32_LAYOUT = ['node_modules', '@codemieai', 'code'];
const POSIX_LAYOUT = ['lib', 'node_modules', '@codemieai', 'code'];

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

function defaultPackageDir(): string {
  return findPackageRoot(getDirname(import.meta.url));
}

/**
 * Derive the npm global prefix implied by `packageDir`'s install layout:
 * `<prefix>\node_modules\@codemieai\code` on win32, `<prefix>/lib/node_modules/@codemieai/code`
 * on POSIX. Returns `null` when `packageDir` does not match that layout (dev checkout, `npm link`).
 *
 * @param packageDir - Package root to inspect; defaults to the running package's own root.
 * @param platform - Platform whose path rules and layout to use; defaults to `process.platform`.
 */
export function deriveSelfPrefix(
  packageDir: string = defaultPackageDir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const layout = platform === 'win32' ? WIN32_LAYOUT : POSIX_LAYOUT;

  const resolved = p.resolve(packageDir);
  const parts = resolved.split(p.sep);
  if (parts.length <= layout.length) {
    return null;
  }

  const tail = parts.slice(-layout.length);
  const matchesLayout =
    platform === 'win32'
      ? tail.every((part, i) => part.toLowerCase() === layout[i].toLowerCase())
      : tail.every((part, i) => part === layout[i]);
  if (!matchesLayout) {
    return null;
  }

  const prefixParts = parts.slice(0, -layout.length);
  return prefixParts.join(p.sep) || p.sep;
}

/**
 * Path of the legacy per-user npm prefix override that older CodeMie installers wrote.
 *
 * @param platform - Platform to resolve the path for; defaults to `process.platform`.
 */
export function getLegacyPrefixPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? '', 'CodeMie', 'npm-prefix');
  }
  return path.join(homedir(), '.codemie', 'npm-prefix');
}

/**
 * Compare two filesystem paths for equality, ignoring a trailing separator and,
 * on win32 only, letter case.
 *
 * @param platform - Platform whose path rules to use; defaults to `process.platform`.
 */
export function isSamePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;

  const normalize = (input: string): string => {
    const resolved = p.resolve(input);
    const trimmed =
      resolved.length > p.sep.length && resolved.endsWith(p.sep)
        ? resolved.slice(0, -p.sep.length)
        : resolved;
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };

  return normalize(a) === normalize(b);
}

/**
 * Read npm's user-level global prefix via `npm config get prefix --location user`.
 *
 * @returns The trimmed prefix, or `null` on a nonzero exit code, empty output, or exec failure.
 */
export async function getUserNpmPrefix(): Promise<string | null> {
  try {
    const result = await exec('npm', ['config', 'get', 'prefix', '--location', 'user'], {
      shell: os.platform() === 'win32'
    });
    if (result.code !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

let cachedGlobalPrefix: Promise<string | null> | undefined;

async function getGlobalNpmPrefix(): Promise<string | null> {
  if (!cachedGlobalPrefix) {
    cachedGlobalPrefix = (async () => {
      const result = await exec('npm', ['prefix', '-g'], { shell: os.platform() === 'win32' });
      if (result.code !== 0) {
        return null;
      }
      return result.stdout.trim() || null;
    })();
  }
  return cachedGlobalPrefix;
}

/**
 * `--prefix` argv to append to an npm install/uninstall/view invocation for `packageName`,
 * so it targets the running CodeMie copy instead of npm's own global prefix.
 *
 * Returns `[]` for every package other than `@codemieai/code`, when the running copy is not
 * at the fixed install layout, when the derived prefix already matches npm's global prefix
 * (`npm prefix -g`, memoized across calls), or on any lookup failure.
 */
export async function getSelfPrefixArgs(packageName: string): Promise<string[]> {
  if (packageName !== CODEMIE_PACKAGE) {
    return [];
  }

  try {
    const derived = deriveSelfPrefix();
    if (!derived) {
      return [];
    }

    const globalPrefix = await getGlobalNpmPrefix();
    if (!globalPrefix || isSamePath(derived, globalPrefix)) {
      return [];
    }

    return ['--prefix', derived];
  } catch {
    return [];
  }
}
