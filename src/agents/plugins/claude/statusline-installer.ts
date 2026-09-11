import { readFile, writeFile, mkdir, chmod, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDirname, resolveHomeDir } from '@/utils/paths.js';
import { priceTable } from '@/utils/pricing.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';

export const STATUSLINE_NAME = 'statusline';
export const STATUSLINE_DISPLAY_NAME = 'CodeMie Statusline';
// Describes what buildStatusLine actually renders. The budget segment and the in/out token stats
// were removed; SCRIPT_FILENAME deliberately still reads 'codemie-budget-status.js' because renaming
// it would orphan the statusLine command in every existing ~/.claude/settings.json.
export const STATUSLINE_DESCRIPTION = 'Project, branch, model, context usage, session cost & duration for Claude Code';

const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
// Must match PRICING_FILENAME in plugin/statusline.mjs — the script resolves it beside itself.
const PRICING_FILENAME = 'codemie-pricing.json';
const REFRESH_INTERVAL = 60;

export interface InstallStatuslineResult {
  scriptPath: string;
  alreadyConfigured: boolean;
}

export async function installStatusline(): Promise<InstallStatuslineResult> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin/statusline.mjs'),
    'utf-8'
  );

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeFile(scriptPath, scriptContent, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }

  // The statusline prices each session from the transcript itself, so it needs the rate card at
  // runtime. It runs standalone (`node <path>` after this process exits) and cannot import from
  // the project, so deploy the table beside it rather than duplicating rates into the script.
  //
  // Serialize priceTable(), NOT the raw pricing.json: the vendored file has no `claude-smart-router`
  // row — that rate lives in CODEMIE_PRICES and is merged in only when the table is built. Copying
  // the raw file left the statusline unable to price exactly the router sessions this feature exists
  // for, scoring them $0 and degrading the total to an estimate.
  // Best-effort: without it the statusline falls back to Claude Code's own cost figure.
  try {
    await writeFile(
      join(claudeHome, PRICING_FILENAME),
      JSON.stringify(priceTable()),
      'utf-8'
    );
  } catch (error) {
    logger.warn(
      '[Statusline] Could not deploy pricing.json; session cost will fall back to Claude Code\'s estimate',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) })
    );
  }

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
