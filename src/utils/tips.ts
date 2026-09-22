/**
 * Feature Tips ("Did you know?") — selection, rotation and rendering logic.
 *
 * The curated catalog lives in src/utils/tips.json (pure data — edit tips
 * there); this module loads it once at startup and exposes it as TIPS.
 * Tips are shown at session start and end, browseable on demand via
 * `codemie tips`, and sprinkled onto selected CLI surfaces (doctor, first-run
 * screens) via renderTip().
 *
 * Catalog maintenance workflow (edit src/utils/tips.json):
 * - Add a tip: append one `{ "id", "category", "message", "command"? }` object
 *   to the array. Use a fresh kebab-case id — ids are never reused, because
 *   the rotation state (~/.codemie/.tips-state.json) remembers them.
 * - Retire a command: delete its tip in the same PR. If the tip is missed,
 *   `codemie tips` validates `command` references against the live CLI command
 *   tree and silently drops (plus debug-logs) tips pointing at retired
 *   commands — session rendering never validates and never breaks.
 * - Reword a tip: edit `message` in place and keep `id` stable so the rotation
 *   history stays meaningful.
 *
 * This module must stay safe to import from the agent runtime, so it depends
 * only on fs/path, chalk, the logger and the paths utility — never on
 * commander or the CLI layer.
 *
 * Environment Variables:
 * - CODEMIE_TIPS=true (default): show tips at session start/end
 * - CODEMIE_TIPS=false|0|no: disable session tips (`codemie tips` still works)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { parseBooleanEnv } from './env.js';

/**
 * A single feature tip.
 */
export interface Tip {
  /** Stable unique id, kebab-case, e.g. 'cmd-skill'. Never reused. */
  id: string;
  /** Short category for grouping in `codemie tips`, e.g. 'Commands'. */
  category: string;
  /** Full sentence shown to the user. May embed the command inline. */
  message: string;
  /**
   * Optional top-level command name used for validation and display,
   * e.g. 'skill' or 'proxy'. When the referenced command is retired,
   * `codemie tips` drops/flags this tip automatically.
   */
  command?: string;
  /** Concrete invocation variations taught by this tip. */
  commands?: string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * Load the tip catalog from src/utils/tips.json at the package root (resolved
 * relative to this module, so it works from src/utils in dev and dist/utils in
 * the installed package, where the JSON ships via the package.json files list).
 *
 * Best-effort: any failure — missing file, malformed JSON, wrong shape — is
 * debug-logged and yields an empty catalog. Tips must never break a session.
 */
function loadTipsCatalog(): Tip[] {
  try {
    // Resolve via import.meta.url, not paths.js: tests legitimately mock
    // ./paths.js without declaring every export, and this module is loaded
    // eagerly through BaseAgentAdapter — a mocked-out helper must never break
    // module evaluation. Resolves identically from src/utils (dev) and
    // dist/utils (built/installed package, where tips.json ships in src/utils).
    const catalogPath = fileURLToPath(new URL('../../src/utils/tips.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) {
      logger.debug('[tips] tips.json is not an array — using empty catalog', { catalogPath });
      return [];
    }

    const tips = parsed
      .filter((entry): entry is Tip =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Tip).id === 'string' &&
        typeof (entry as Tip).category === 'string' &&
        typeof (entry as Tip).message === 'string'
      )
      .map(entry => {
        // Tolerate a malformed optional `commands` field by dropping just it
        if (entry.commands !== undefined && !isStringArray(entry.commands)) {
          logger.debug(`[tips] tips.json: ignoring malformed 'commands' on tip '${entry.id}'`);
          return { ...entry, commands: undefined };
        }
        return entry;
      });
    if (tips.length !== parsed.length) {
      logger.debug(`[tips] tips.json: dropped ${parsed.length - tips.length} malformed entrie(s)`, { catalogPath });
    }
    return tips;
  } catch (error) {
    logger.debug('[tips] Failed to load tips.json — using empty catalog:', error);
    return [];
  }
}

/**
 * Curated tip catalog, loaded eagerly from src/utils/tips.json. Every
 * `command` value references a top-level command registered in
 * src/cli/index.ts; `codemie tips` re-validates these at runtime.
 */
export const TIPS: readonly Tip[] = loadTipsCatalog();

/**
 * Rotation state persisted at ~/.codemie/.tips-state.json so consecutive
 * sessions cycle through the catalog instead of repeating the same tips.
 */
interface TipsRotationState {
  shownTipIds: string[];
}

const stateFilePath = (): string => getCodemiePath('.tips-state.json');

/**
 * Check if session tips are enabled (default: true).
 * Reads the CODEMIE_TIPS environment variable.
 *
 * @returns true unless CODEMIE_TIPS is set to a falsy value ('false', '0', 'no')
 */
export function isTipsEnabled(): boolean {
  return parseBooleanEnv(process.env.CODEMIE_TIPS, true);
}

/**
 * Return the full tip catalog (used by `codemie tips`).
 */
export function listTips(): readonly Tip[] {
  return TIPS;
}

/**
 * Pick the tip to show at a session lifecycle point.
 *
 * Randomly selects a tip that has not been shown yet (per the rotation state
 * file), records the pick, and resets the shown list once every tip has been
 * shown. Both contexts share one catalog and one rotation for now; the context
 * is recorded in the debug log so future per-context catalogs can reuse it.
 *
 * Best-effort: unreadable/corrupt state is treated as empty, write failures
 * are swallowed — a tip must never block or break a session.
 *
 * @param context - Where the tip is rendered ('start' or 'end' of session)
 * @returns A tip, or null when tips are disabled or the catalog is empty
 */
export function getSessionTip(context: 'start' | 'end'): Tip | null {
  if (!isTipsEnabled() || TIPS.length === 0) {
    return null;
  }

  const state = loadRotationState();

  // Prune ids of retired tips so the rotation can still complete and reset.
  const catalogIds = new Set(TIPS.map(tip => tip.id));
  state.shownTipIds = state.shownTipIds.filter(id => catalogIds.has(id));

  let candidates = TIPS.filter(tip => !state.shownTipIds.includes(tip.id));
  if (candidates.length === 0) {
    // Full rotation complete — start a fresh cycle.
    state.shownTipIds = [];
    candidates = [...TIPS];
  }

  const tip = candidates[Math.floor(Math.random() * candidates.length)];
  state.shownTipIds.push(tip.id);
  saveRotationState(state);

  logger.debug('[tips] Selected session tip', { context, id: tip.id });
  return tip;
}

/**
 * Format a tip for terminal display: a gold ✨ prefix followed by the message
 * in the same warm gold, bold. Yellow is the CLI's established accent color
 * (matches the Kimi-style prompt echo) — deliberately no background bars or
 * badge, just plain foreground styling.
 * Shared by session lifecycle rendering (BaseAgentAdapter), renderTip(), and
 * `codemie tips --random` so tips look identical everywhere.
 */
export function formatTipLine(tip: Tip): string {
  return chalk.bold.yellow(`✨ ${tip.message}`);
}

/**
 * Print a single random tip to the console for CLI surfaces (doctor,
 * first-run and post-setup screens, ...). Unlike getSessionTip(), this does
 * not read or update the rotation state — rotation stays exclusive to session
 * start/end.
 *
 * Best-effort: never throws, and is a no-op when tips are disabled.
 *
 * @param options.category - Restrict the pick to one category; falls back to
 *   the full catalog when the category has no tips
 */
export function renderTip(options?: { category?: string }): void {
  try {
    if (!isTipsEnabled() || TIPS.length === 0) {
      return;
    }

    let pool: readonly Tip[] = TIPS;
    if (options?.category) {
      const filtered = TIPS.filter(tip => tip.category === options.category);
      if (filtered.length > 0) {
        pool = filtered;
      }
    }

    const tip = pool[Math.floor(Math.random() * pool.length)];
    console.log();
    console.log(formatTipLine(tip));
  } catch (error) {
    logger.debug('[tips] renderTip failed (non-fatal):', error);
  }
}

function loadRotationState(): TipsRotationState {
  const file = stateFilePath();
  try {
    const content = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { shownTipIds?: unknown }).shownTipIds)
    ) {
      const shownTipIds = (parsed as { shownTipIds: unknown[] }).shownTipIds
        .filter((id): id is string => typeof id === 'string');
      return { shownTipIds };
    }
    return { shownTipIds: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.debug('[tips] Rotation state unreadable — treating as empty', { file });
    }
    return { shownTipIds: [] };
  }
}

/**
 * Persist rotation state. The write goes through a same-directory temp file
 * plus rename, so a concurrent reader never sees a truncated file (rename is
 * atomic on POSIX and Windows for same-dir renames). Read-modify-write races
 * between concurrent sessions remain theoretically possible — accepted as
 * low-harm (worst case: a tip repeats); deliberately no locking.
 */
function saveRotationState(state: TipsRotationState): void {
  const file = stateFilePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmpFile, file);
  } catch (error) {
    logger.debug('[tips] Failed to persist rotation state (non-fatal):', error);
  }
}
