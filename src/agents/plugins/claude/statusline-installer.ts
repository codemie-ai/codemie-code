import { readFile, writeFile, mkdir, chmod, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDirname, resolveHomeDir } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';

export const STATUSLINE_NAME = 'statusline';
export const STATUSLINE_DISPLAY_NAME = 'CodeMie Statusline';
// Describes what buildStatusLine actually renders. The budget segment was removed; SCRIPT_FILENAME
// deliberately still reads 'codemie-budget-status.js' because renaming it would orphan the
// statusLine command in every existing ~/.claude/settings.json.
export const STATUSLINE_DESCRIPTION = 'Project, branch, model, context usage, session cost & duration for Claude Code';

const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
// scripts/bundle-statusline.mjs's esbuild `outfile` — a single self-contained ESM artifact with
// zero sibling dependencies (statusline.ts's own project imports are resolved and inlined at
// build time). Keep this in sync with that script's `outfile` basename.
const BUNDLE_FILENAME = 'statusline.bundle.mjs';
// Claude Code re-runs the statusLine command on its own event triggers (a new assistant message,
// /compact, etc. — see https://code.claude.com/docs/en/statusline#how-status-lines-work);
// `refreshInterval` is only the fallback timer for when those events "go quiet" (e.g. an idle
// session). This used to sit at 60s to match the (since-removed) budget segment's HTTP cache TTL
// (see CACHE_TTL_MS in plugin/statusline.ts) — re-running any faster than that would have just
// repeated the same cached network figure. Every remaining segment (routed-model widget, cost,
// context bar) is now a cheap local file read, so a stale event trigger (observed: the "routed to"
// arrow not appearing until the next prompt is sent) sits invisible for up to a full minute with no
// good reason. A short interval makes it self-correct almost immediately instead.
const REFRESH_INTERVAL = 3;

export interface InstallStatuslineResult {
  scriptPath: string;
  alreadyConfigured: boolean;
}

// scripts/bundle-statusline.mjs (esbuild) bundles statusline.ts's project imports into this
// single self-contained file at build time — no sibling files to deploy alongside it, the rate
// card included. A missing bundle means the statusline can't run at all, so callers that need it
// let this throw.
function readPackagedBundle(): Promise<string> {
  return readFile(join(getDirname(import.meta.url), 'plugin', BUNDLE_FILENAME), 'utf-8');
}

async function writeScript(scriptPath: string, content: string): Promise<void> {
  await writeFile(scriptPath, content, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }
}

/**
 * Brings an already-installed statusline script up to date with the bundle shipped in this CLI
 * version. The deployed script is a copy, so a CLI upgrade (new rate card, pricing fix) leaves it
 * frozen until the user reinstalls — this closes that gap. Compares content rather than a version
 * string, so it also catches a rebuilt dev bundle. Only rewrites the script: an absent statusline
 * stays absent (installing is the user's choice) and settings.json is never touched.
 * Best-effort: never throws, since it runs on the launch path.
 */
export async function refreshStatuslineIfStale(): Promise<boolean> {
  try {
    const scriptPath = join(resolveHomeDir('.claude'), SCRIPT_FILENAME);
    if (!existsSync(scriptPath)) {
      return false;
    }
    const packaged = await readPackagedBundle();
    if ((await readFile(scriptPath, 'utf-8')) === packaged) {
      return false;
    }
    await writeScript(scriptPath, packaged);
    logger.debug('[Statusline] Refreshed deployed script to match the installed CLI version');
    return true;
  } catch (error) {
    logger.debug(
      '[Statusline] Could not refresh deployed script',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) })
    );
    return false;
  }
}

export async function installStatusline(): Promise<InstallStatuslineResult> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  const scriptContent = await readPackagedBundle();

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeScript(scriptPath, scriptContent);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json, aborting to avoid data loss',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  const alreadyConfigured = Boolean(settings.statusLine);

  settings.statusLine = {
    type: 'command',
    command: `node "${scriptPath}"`,
    refreshInterval: REFRESH_INTERVAL,
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  logger.debug('[Statusline] Installed', ...sanitizeLogArgs({ scriptPath }));
  return { scriptPath, alreadyConfigured };
}

export async function uninstallStatusline(): Promise<void> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const legacyScriptPath = join(claudeHome, LEGACY_SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  if (existsSync(scriptPath)) {
    await rm(scriptPath);
  }
  // Clean up the orphaned artifact from the old, now-removed --status flag mechanism,
  // in case it was ever written by a version prior to this consolidation.
  if (existsSync(legacyScriptPath)) {
    await rm(legacyScriptPath);
  }

  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (settings.statusLine) {
        delete settings.statusLine;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json during uninstall',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  logger.debug('[Statusline] Uninstalled');
}

export function isStatuslineInstalled(): boolean {
  return existsSync(join(homedir(), '.claude', SCRIPT_FILENAME));
}
