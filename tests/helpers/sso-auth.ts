import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripNodeModulesBin } from './test-env.js';

const SSO_PROFILE_NAME = 'sso-autotest';

function getCodemieConfigDir(): string {
  return join(homedir(), '.codemie');
}

function buildSsoProfile(): Record<string, unknown> {
  const ciCodemieUrl = (process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');
  return {
    name: SSO_PROFILE_NAME,
    provider: 'ai-run-sso',
    authMethod: 'sso',
    codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
    baseUrl: `${ciCodemieUrl}/code-assistant-api`,
    apiKey: 'sso-authenticated',
    model: process.env.CODEMIE_MODEL ?? 'claude-sonnet-4-6',
    timeout: 300,
    debug: false,
  };
}

/**
 * Write a fresh SSO profile config to the given codemieHome directory.
 * Mirrors writeJwtProfile but for SSO auth — writes an sso-autotest profile
 * so subprocesses can authenticate via the OS keychain using codeMieUrl.
 */
export function writeSsoProfile(codemieHome: string): void {
  const config = {
    version: 2,
    activeProfile: SSO_PROFILE_NAME,
    profiles: { [SSO_PROFILE_NAME]: buildSsoProfile() },
  };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Strip CODEMIE_* vars from the process environment for SSO subprocess spawns.
 * Uses a denylist (vs jwtCleanEnv's allowlist) to preserve HOME, proxy settings,
 * and other vars that the OS keychain and network calls depend on.
 *
 * Also strips node_modules/.bin entries from PATH so locally-installed package
 * shims (e.g. @codemieai/codemie-opencode's `codemie` bin) don't shadow the
 * globally npm-linked `codemie` binary that provides the `hook` subcommand.
 */
export function ssoCleanEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CODEMIE_') && !key.startsWith('CI_CODEMIE_')),
  ) as NodeJS.ProcessEnv;
  if (env.PATH) env.PATH = stripNodeModulesBin(env.PATH);
  return env;
}

/**
 * Upsert the sso-autotest profile into ~/.codemie/codemie-cli.config.json and
 * set it as the active profile. All existing profiles are preserved.
 *
 * Returns the previous activeProfile value for later restoration via
 * teardownSsoAutotestProfile().
 */
export function setupSsoAutotestProfile(): string | undefined {
  const configDir = getCodemieConfigDir();
  const configFilePath = join(configDir, 'codemie-cli.config.json');

  let originalActiveProfile: string | undefined;
  if (existsSync(configFilePath)) {
    try {
      const existing = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
      originalActiveProfile = existing.activeProfile as string | undefined;
    } catch { /* ignore parse errors */ }
  }

  mkdirSync(configDir, { recursive: true });

  let config: Record<string, unknown> = { version: 2, activeProfile: SSO_PROFILE_NAME, profiles: {} };
  if (existsSync(configFilePath)) {
    try { config = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>; } catch { /* use defaults */ }
  }
  (config.profiles as Record<string, unknown>)[SSO_PROFILE_NAME] = buildSsoProfile();
  config.activeProfile = SSO_PROFILE_NAME;
  writeFileSync(configFilePath, JSON.stringify(config, null, 2));

  return originalActiveProfile;
}

/**
 * Restore the ~/.codemie active profile to the value saved by
 * setupSsoAutotestProfile(). No-op if originalActiveProfile is undefined.
 */
export function teardownSsoAutotestProfile(originalActiveProfile: string | undefined): void {
  const configFilePath = join(getCodemieConfigDir(), 'codemie-cli.config.json');
  if (originalActiveProfile !== undefined && existsSync(configFilePath)) {
    try {
      const config = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
      config.activeProfile = originalActiveProfile;
      writeFileSync(configFilePath, JSON.stringify(config, null, 2));
    } catch { /* ignore restore errors */ }
  }
}

/**
 * Copy SSO credential files from ~/.codemie/credentials/ into testHome/credentials/.
 *
 * The encryption key is machine-specific (hostname+platform+arch), not path-specific,
 * so the copied files are decryptable by any subprocess running on the same machine.
 * Call this after writeSsoProfile() so the subprocess finds credentials at the
 * CODEMIE_HOME-relative path it derives from CREDENTIALS_DIR at startup.
 */
export function copySsoCredentials(testHome: string): void {
  const realCredsDir = join(getCodemieConfigDir(), 'credentials');
  if (!existsSync(realCredsDir)) return;
  const testCredsDir = join(testHome, 'credentials');
  mkdirSync(testCredsDir, { recursive: true });
  for (const file of readdirSync(realCredsDir)) {
    copyFileSync(join(realCredsDir, file), join(testCredsDir, file));
  }
}
