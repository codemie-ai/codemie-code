import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '@/utils/logger.js';

export function getUserPiAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

export function getPiAgentDir(cwd: string = process.cwd()): string {
  return join(cwd, '.pi', 'codemie', 'agent');
}

export function getPiModelsPath(cwd: string = process.cwd()): string {
  return join(getPiAgentDir(cwd), 'models.json');
}

/**
 * Compute the default Pi session storage directory for a given cwd.
 *
 * Pi encodes the cwd as `--<cwd with leading slash removed and path
 * separators/colons replaced by dashes>--` under the agent dir's `sessions/`.
 */
export function getPiSessionDir(cwd: string = process.cwd()): string {
  const resolved = resolve(cwd);
  const safeName = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getPiAgentDir(cwd), 'sessions', safeName);
}

export interface PiSessionDirResolution {
  /**
   * Where Pi keeps this project's transcripts. Always an absolute path, so every caller
   * may hand it to Pi and to the filesystem without a further check.
   */
  sessionDir: string;
  /** Whether the user configured a usable directory of their own. */
  isCustom: boolean;
}

/**
 * Convert a Git Bash / MSYS / Cygwin / WSL drive path to native Windows form,
 * matching Pi's `normalizeWindowsShellPath()`.
 */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) {
    return filePath;
  }
  const suffix = match[2]?.replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
}

/**
 * Normalize a session-directory path the way Pi does, then resolve it to an
 * absolute path. Returns undefined for a configured value that has no path form.
 *
 * Every channel Pi accepts a path from runs through `normalizePath()`, which
 * rewrites Windows shell paths, expands a leading `~`, and converts `file://`
 * URLs. Node's `resolve()` does none of that, so a raw `~/pi-sessions` would
 * create a literal `~` directory and `file:///tmp/x` would become
 * `<cwd>/file:/tmp/x` — in both cases discovery would scan a directory Pi never
 * writes to, and the run's metrics would be lost without a trace.
 *
 * A `file://` URL that `fileURLToPath` rejects is the one value with no path form. Pi's
 * `normalizePath()` lets the conversion throw, so a bare `pi` aborts before writing
 * anything, whichever channel carried the value. This function cannot throw — it also runs
 * during discovery after the agent has exited, where it would take the whole metrics upload
 * with it — so it reports the absence instead; see {@link resolvePiSessionDir} for what is
 * done with it.
 */
function normalizeSessionDir(inputPath: string): string | undefined {
  const normalized = process.platform === 'win32' ? normalizeWindowsShellPath(inputPath) : inputPath;

  if (normalized === '~') {
    return homedir();
  }
  const hasTildePrefix =
    normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'));
  if (hasTildePrefix) {
    return join(homedir(), normalized.slice(2));
  }

  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return undefined;
    }
  }

  return resolve(normalized);
}

/**
 * Read `sessionDir` from a Pi `settings.json`, if the file exists and declares one.
 * Malformed JSON is ignored so a broken settings file cannot break discovery.
 */
function readSettingsSessionDir(settingsPath: string): string | undefined {
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    if (typeof settings.sessionDir === 'string' && settings.sessionDir.length > 0) {
      return settings.sessionDir;
    }
  } catch {
    // Malformed settings.json is ignored; fall back to the next source.
  }
  return undefined;
}

/**
 * The session directory the user configured, from the highest-precedence source that
 * declares one.
 *
 * Mirrors Pi's own precedence (`main.ts` session-dir resolution and `SettingsManager`,
 * which deep-merges global settings under project settings):
 * 1. `PI_CODING_AGENT_SESSION_DIR` environment variable (set by the user or by
 *    this plugin when it injects `--session-dir`).
 * 2. `sessionDir` from the project-local `<cwd>/.pi/settings.json`.
 * 3. `sessionDir` from the Pi `settings.json` located under the effective agent
 *    directory (`PI_CODING_AGENT_DIR` or the project-local default).
 */
function readConfiguredSessionDir(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.PI_CODING_AGENT_SESSION_DIR) {
    return env.PI_CODING_AGENT_SESSION_DIR;
  }
  const agentDir = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : getPiAgentDir(cwd);
  return (
    readSettingsSessionDir(join(resolve(cwd), '.pi', 'settings.json')) ??
    readSettingsSessionDir(join(agentDir, 'settings.json'))
  );
}

/**
 * Resolve the effective Pi session directory: the configured one when it has a path form,
 * the default per-cwd encoded directory from {@link getPiSessionDir} otherwise.
 *
 * Falling back is not a substitute directory handed to Pi. `isCustom` is false with it, so
 * no caller injects `PI_CODING_AGENT_SESSION_DIR`, and Pi still reads the user's own value
 * from the flag, the environment, or `settings.json` and aborts on it exactly as a bare
 * `pi` would — the wrapper neither rescues the run nor relocates the transcripts of one
 * that works.
 *
 * What the fallback does prevent is a value with no path form reaching the filesystem.
 * Every unresolvable value is a `file://` URL, and to `existsSync` those are RELATIVE
 * paths: `file://bad` is `<cwd>/file:/bad`, an ordinary directory any working tree may
 * happen to contain. Returning one would have discovery list whatever `.jsonl` files live
 * there and upload them as this session's transcripts.
 */
export function resolvePiSessionDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PiSessionDirResolution {
  const configured = readConfiguredSessionDir(cwd, env);
  if (configured) {
    const sessionDir = normalizeSessionDir(configured);
    if (sessionDir) {
      return { sessionDir, isCustom: true };
    }
    logger.debug('[pi-paths] Session directory has no path form; using the default', {
      configured,
    });
  }

  return { sessionDir: getPiSessionDir(cwd), isCustom: false };
}
