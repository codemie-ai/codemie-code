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
// Describes what buildStatusLine actually renders. The budget segment was removed; SCRIPT_FILENAME
// deliberately still reads 'codemie-budget-status.js' because renaming it would orphan the
// statusLine command in every existing ~/.claude/settings.json.
export const STATUSLINE_DESCRIPTION = 'Project, branch, model, context usage, session cost & duration for Claude Code';

const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
// Must match PRICING_FILENAME in plugin/statusline.ts — the script resolves it beside itself.
const PRICING_FILENAME = 'codemie-pricing.json';
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

export async function installStatusline(): Promise<InstallStatuslineResult> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  // scripts/bundle-statusline.mjs (esbuild) bundles statusline.ts's project imports into this
  // single self-contained file at build time — no sibling files to deploy alongside it. Unlike
  // codemie-pricing.json below, a missing bundle means the statusline can't run at all, so this
  // is intentionally not wrapped in a best-effort try/catch — let it throw.
  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin', BUNDLE_FILENAME),
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
