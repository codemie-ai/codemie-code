/**
 * npm Prefix Utilities
 *
 * Resolves the npm prefix CodeMie runs from and detects the per-user prefix override that
 * older CodeMie installers wrote to `.npmrc`.
 */

import path from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { getDirname, isSamePath } from '@/utils/paths.js';
import { getPathModule, isWindows } from '@/utils/platform.js';
import { exec } from '@/utils/exec.js';

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

/**
 * Get the npm prefix the running CodeMie package was installed into, derived from its
 * location: `<prefix>\node_modules\@codemieai\code` on win32,
 * `<prefix>/lib/node_modules/@codemieai/code` on POSIX.
 *
 * @param packageDir - Package root to inspect; defaults to the running package's own root.
 * @param platform - Platform whose path rules and layout to use; defaults to `process.platform`.
 * @returns The prefix, or `null` when `packageDir` does not match the layout (dev checkout,
 *   `npm link`) or, on win32, when `<prefix>\codemie.cmd` is missing (project-local dependency,
 *   npx cache).
 */
export function getCodemieNpmPrefix(
  packageDir: string = findPackageRoot(getDirname(import.meta.url)),
  platform: NodeJS.Platform = process.platform
): string | null {
  const p = getPathModule(platform);
  const windows = isWindows(platform);
  const layout = windows ? WIN32_LAYOUT : POSIX_LAYOUT;

  const parts = p.resolve(packageDir).split(p.sep);
  if (parts.length <= layout.length) {
    return null;
  }

  const tail = parts.slice(-layout.length);
  const matchesLayout = tail.every((part, i) =>
    windows ? part.toLowerCase() === layout[i].toLowerCase() : part === layout[i]
  );
  if (!matchesLayout) {
    return null;
  }

  const prefix = parts.slice(0, -layout.length).join(p.sep) || p.sep;
  if (windows && !existsSync(p.join(prefix, 'codemie.cmd'))) {
    return null;
  }

  return prefix;
}

/**
 * Path of the per-user npm prefix that older CodeMie installers wrote to `.npmrc`.
 *
 * @param platform - Platform to resolve the path for; defaults to `process.platform`.
 */
export function getLegacyNpmPrefixPath(platform: NodeJS.Platform = process.platform): string {
  if (isWindows(platform)) {
    return path.join(process.env.LOCALAPPDATA ?? '', 'CodeMie', 'npm-prefix');
  }
  return path.join(homedir(), '.codemie', 'npm-prefix');
}

async function readNpmValue(args: string[]): Promise<string | null> {
  try {
    const result = await exec('npm', args, { shell: isWindows() });
    if (result.code !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

let globalNpmPrefix: Promise<string | null> | undefined;

function getGlobalNpmPrefix(): Promise<string | null> {
  globalNpmPrefix ??= readNpmValue(['prefix', '-g']);
  return globalNpmPrefix;
}

/**
 * Extract the last `prefix=` value from `.npmrc` content, with surrounding quotes removed.
 */
export function parseNpmrcPrefix(content: string): string | null {
  let prefix: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*prefix\s*=\s*(.*?)\s*$/.exec(line);
    if (match) {
      prefix = match[1].replace(/^"(.*)"$/, '$1') || null;
    }
  }
  return prefix;
}

/**
 * Read the `prefix` set in the user-level `.npmrc` (the file `npm config get userconfig` points to).
 *
 * Unlike `npm config get prefix`, this ignores `NPM_CONFIG_PREFIX` and global/project config.
 *
 * @returns The prefix, or `null` when it is not set or the file cannot be read.
 */
export async function getUserNpmrcPrefix(): Promise<string | null> {
  const userConfigPath = await readNpmValue(['config', 'get', 'userconfig']);
  if (!userConfigPath) {
    return null;
  }

  try {
    return parseNpmrcPrefix(await readFile(userConfigPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The prefix of the running CodeMie copy, or npm's global prefix when it cannot be derived.
 */
export async function getCodemieOrGlobalNpmPrefix(): Promise<string | null> {
  return getCodemieNpmPrefix() ?? getGlobalNpmPrefix();
}

/**
 * `--prefix` args that keep an npm global install/uninstall/list next to the running CodeMie copy.
 *
 * @returns `[]` when CodeMie runs from npm's global prefix, from a dev checkout, or when either
 *   prefix cannot be resolved; otherwise `['--prefix', <CodeMie prefix>]`.
 */
export async function getNpmPrefixArgs(): Promise<string[]> {
  const codemiePrefix = getCodemieNpmPrefix();
  if (!codemiePrefix) {
    return [];
  }

  const globalPrefix = await getGlobalNpmPrefix();
  if (!globalPrefix || isSamePath(codemiePrefix, globalPrefix)) {
    return [];
  }

  return ['--prefix', codemiePrefix];
}
