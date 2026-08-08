import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

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
  sessionDir: string;
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
 * absolute path.
 *
 * Every channel Pi accepts a path from runs through `normalizePath()`, which
 * rewrites Windows shell paths, expands a leading `~`, and converts `file://`
 * URLs. Node's `resolve()` does none of that, so a raw `~/pi-sessions` would
 * create a literal `~` directory and `file:///tmp/x` would become
 * `<cwd>/file:/tmp/x` — in both cases discovery would scan a directory Pi never
 * writes to, and the run's metrics would be lost without a trace.
 *
 * The transform order mirrors Pi's `normalizePath()`. A malformed `file://` URL
 * falls back to plain resolution rather than throwing.
 */
function expandTildeAndResolve(inputPath: string): string {
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
      // Not a valid file URL; fall through to plain resolution.
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
 * Resolve the effective Pi session directory.
 *
 * Mirrors Pi's own precedence (`main.ts` session-dir resolution and
 * `SettingsManager`, which deep-merges global settings under project settings):
 * 1. `PI_CODING_AGENT_SESSION_DIR` environment variable (set by the user or by
 *    this plugin when it injects `--session-dir`).
 * 2. `sessionDir` from the project-local `<cwd>/.pi/settings.json`.
 * 3. `sessionDir` from the Pi `settings.json` located under the effective agent
 *    directory (`PI_CODING_AGENT_DIR` or the project-local default).
 * 4. The default per-cwd encoded directory from `getPiSessionDir()`.
 */
export function resolvePiSessionDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PiSessionDirResolution {
  const explicitDir = env.PI_CODING_AGENT_SESSION_DIR;
  if (explicitDir) {
    return { sessionDir: expandTildeAndResolve(explicitDir), isCustom: true };
  }

  // Project settings win over global settings, matching Pi's deepMergeSettings order.
  const agentDir = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : getPiAgentDir(cwd);
  const settingsSessionDir =
    readSettingsSessionDir(join(resolve(cwd), '.pi', 'settings.json')) ??
    readSettingsSessionDir(join(agentDir, 'settings.json'));

  if (settingsSessionDir) {
    return { sessionDir: expandTildeAndResolve(settingsSessionDir), isCustom: true };
  }

  return { sessionDir: getPiSessionDir(cwd), isCustom: false };
}
