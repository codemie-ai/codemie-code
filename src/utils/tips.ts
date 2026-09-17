/**
 * Feature Tips ("Did you know?") — selection, rotation and rendering logic.
 *
 * The curated catalog (Tip type and TIPS array) lives in ./tips-catalog.ts
 * and is re-exported here, so existing consumers keep importing from tips.js.
 * Tips are shown at session start and end, browseable on demand via
 * `codemie tips`, and sprinkled onto selected CLI surfaces (doctor, first-run
 * screens) via renderTip().
 *
 * This module must stay safe to import from the agent runtime, so it depends
 * only on fs/path, chalk, the logger and the paths utility — never on
 * commander or the CLI layer.
 *
 * Environment Variables:
 * - CODEMIE_TIPS=true (default): show tips at session start/end
 * - CODEMIE_TIPS=false|0|no: disable session tips (`codemie tips` still works)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { TIPS } from './tips-catalog.js';
import type { Tip } from './tips-catalog.js';

// Re-exported so existing consumers keep importing the catalog from tips.js
export { TIPS };
export type { Tip };

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
  const envValue = process.env.CODEMIE_TIPS;

  // If not set, default to true (tips enabled)
  if (envValue === undefined || envValue === null || envValue === '') {
    return true;
  }

  // Parse as boolean
  const normalized = envValue.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
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

function saveRotationState(state: TipsRotationState): void {
  const file = stateFilePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logger.debug('[tips] Failed to persist rotation state (non-fatal):', error);
  }
}
