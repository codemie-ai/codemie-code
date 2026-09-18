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

/**
 * Default CodeMie instance used by agent tests when nothing else supplies one.
 */
export const DEFAULT_CODEMIE_TEST_URL = 'https://codemie.lab.epam.com';

/**
 * Default model used by generated test profiles when nothing else supplies one.
 */
export const DEFAULT_CODEMIE_TEST_MODEL = 'claude-sonnet-4-6';

/**
 * Read a string test value with file-first priority, empty-safe coalescing and
 * optional alias fallbacks.
 *
 * Empty or whitespace-only values are treated as ABSENT — this is the whole
 * point of the helper. CodeMie exports its full CODEMIE_* block into the shell
 * of every agent session it launches, and some providers deliberately blank
 * individual vars (anthropic-subscription.template.ts sets CODEMIE_MODEL = ''
 * so the Claude CLI falls back to its own defaults). Running the suite from
 * inside such a session inherits CODEMIE_MODEL='', and plain `??` coalescing
 * lets that empty string beat the intended default — the generated profile is
 * then written with no model and every agent test fails with
 * "Configuration incomplete / Missing: model".
 *
 * Priority: .env.test.local value > process.env (name, then each alias) > defaultValue.
 */
export function getTestEnvValue(name: string, defaultValue = '', aliases: string[] = []): string {
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const keys = [name, ...aliases];
  if (_dotEnvExists) {
    for (const key of keys) {
      const fromFile = clean(_fileEnv[key]);
      if (fromFile !== undefined) return fromFile;
    }
  }
  for (const key of keys) {
    const fromEnv = clean(process.env[key]);
    if (fromEnv !== undefined) return fromEnv;
  }
  return defaultValue;
}

/**
 * Resolve the CodeMie instance URL for agent tests, without a trailing slash.
 *
 * Falls back to CODEMIE_URL — which is always present when the suite is run
 * from a shell that CodeMie itself launched — before the hardcoded default, so
 * a developer needs no .env.test.local to point the tests at their instance.
 */
export function getCodemieTestUrl(): string {
  return getTestEnvValue('CI_CODEMIE_URL', DEFAULT_CODEMIE_TEST_URL, ['CODEMIE_URL']).replace(/\/$/, '');
}

/**
 * Resolve the model written into generated test profiles.
 *
 * CODEMIE_MODEL stays honoured as an explicit override, but only when it holds
 * a real value — an inherited empty string falls through to the default.
 */
export function getCodemieTestModel(): string {
  return getTestEnvValue('CI_CODEMIE_MODEL', DEFAULT_CODEMIE_TEST_MODEL, ['CODEMIE_MODEL']);
}
