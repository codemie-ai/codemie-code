/**
 * Test environment flag helpers.
 *
 * Reads boolean mode flags with file-first priority: when .env.test.local
 * exists the file value always wins, preventing stale shell exports from
 * overriding local test configuration. When the file is absent (CI pipeline),
 * falls back to process.env where the CI sets flags as real environment variables.
 */

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

function parseDotEnvFile(filePath: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(filePath, 'utf-8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.replace(/^export\s+/, '').match(/^([^=]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map(m => [m[1].trim(), m[2].trim().replace(/^(["'])(.*)\1$/, '$2')]),
    );
  } catch { return {}; }
}

const DOT_ENV_PATH = resolve(process.cwd(), '.env.test.local');
const _dotEnvExists = existsSync(DOT_ENV_PATH);
const _fileEnv = _dotEnvExists ? parseDotEnvFile(DOT_ENV_PATH) : {};

/**
 * Read a boolean test flag with file-first priority.
 *
 * When .env.test.local exists: returns whether the flag is set to 'true' in
 * the file, regardless of shell environment. Commenting out the line or setting
 * it to 'false' in the file is always sufficient to disable the flag locally.
 *
 * When .env.test.local is absent (CI): reads from process.env, where the CI
 * pipeline sets flags as real environment variables.
 */
export function getTestEnvFlag(name: string): boolean {
  return _dotEnvExists
    ? _fileEnv[name] === 'true'
    : process.env[name] === 'true';
}

/**
 * Read a boolean test flag with file-first priority and an explicit default.
 *
 * Useful for flags that should be ON unless explicitly disabled — e.g.
 * CI_IS_LOCAL_RUN defaults to true so SSO mode runs locally with no config,
 * and only setting CI_IS_LOCAL_RUN=false in .env.test.local (or as a CI env var)
 * switches to JWT mode.
 *
 * Priority: file value (if key present) > env var (if no file) > defaultValue.
 */
export function getTestEnvFlagOrDefault(name: string, defaultValue: boolean): boolean {
  if (_dotEnvExists) {
    if (name in _fileEnv) return _fileEnv[name] === 'true';
    return defaultValue;
  }
  const envVal = process.env[name];
  if (envVal !== undefined) return envVal === 'true';
  return defaultValue;
}

/**
 * Strip node_modules/.bin entries from a PATH string so locally-installed
 * package shims don't shadow globally-linked binaries in spawned subprocesses.
 */
export function stripNodeModulesBin(envPath: string): string {
  return envPath
    .split(delimiter)
    .filter(dir => !dir.replace(/\\/g, '/').includes('node_modules/.bin'))
    .join(delimiter);
}
