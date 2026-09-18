/**
 * What's New — release notes from CHANGELOG.md
 *
 * CHANGELOG.md (Keep a Changelog format) is the curated source of truth for
 * release notes. It ships inside the npm package and is consumed by:
 * - `codemie whatsnew` — browse notes for the current, one, or all versions
 * - the once-per-upgrade startup notice in bin/codemie.js, which shows the
 *   current version's notes once and records a `.last-seen-version` marker
 *   under the CodeMie home directory
 *
 * This module must stay safe to import from the bin entry point, so its
 * dependencies are limited to fs/path/chalk plus the logger, paths, and tips
 * utilities — never commander or the CLI layer.
 *
 * Environment Variables:
 * - CODEMIE_TIPS=false|0|no: also suppresses the upgrade notice. The "reduce
 *   chatter" switch is shared with feature tips on purpose — see tips.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { logger } from './logger.js';
import { getCodemiePath, getDirname } from './paths.js';
import { isTipsEnabled } from './tips.js';

/**
 * One `### Section` block inside a release entry.
 */
export interface ReleaseSection {
  title: string;
  items: string[];
}

/**
 * One `## [version]` release entry from the changelog.
 */
export interface ReleaseEntry {
  version: string;
  date?: string;
  sections: ReleaseSection[];
}

/**
 * Tolerant Keep-a-Changelog parser. Recognizes `## [x.y.z] - date` headings,
 * `### Section` subheadings, and `- item` bullets; everything else is skipped.
 */
export function parseChangelog(content: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  let currentEntry: ReleaseEntry | null = null;
  let currentSection: ReleaseSection | null = null;

  for (const line of content.split(/\r?\n/)) {
    const versionMatch = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+?))?\s*$/);
    if (versionMatch) {
      currentEntry = {
        version: versionMatch[1].trim(),
        date: versionMatch[2]?.trim(),
        sections: []
      };
      entries.push(currentEntry);
      currentSection = null;
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    const sectionMatch = line.match(/^###\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentSection = { title: sectionMatch[1].trim(), items: [] };
      currentEntry.sections.push(currentSection);
      continue;
    }

    const itemMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1].trim());
    }
  }

  return entries;
}

/**
 * Locate CHANGELOG.md at the package root. Works both from src/utils (dev
 * repo) and dist/utils (built/installed package) — the root is two levels up
 * in both layouts.
 *
 * @returns Absolute path to CHANGELOG.md, or null when it is not shipped
 */
export function getChangelogPath(): string | null {
  const changelogPath = path.resolve(getDirname(import.meta.url), '../../CHANGELOG.md');
  return existsSync(changelogPath) ? changelogPath : null;
}

/**
 * Read release notes from the changelog.
 *
 * @param version - When given, the entry for this exact version; if there is
 *   no matching heading, falls back to the newest versioned entry (or
 *   Unreleased when that is all there is) so the once-per-upgrade notice
 *   always has something to show
 * @returns Parsed entries (newest first, as written), or an empty array when
 *   the changelog is missing or unparseable
 */
export function getReleaseNotes(version?: string): ReleaseEntry[] {
  const changelogPath = getChangelogPath();
  if (!changelogPath) {
    logger.debug('[whatsnew] CHANGELOG.md not found at package root');
    return [];
  }

  try {
    const entries = parseChangelog(readFileSync(changelogPath, 'utf-8'));
    if (entries.length === 0) {
      logger.debug('[whatsnew] CHANGELOG.md parsed to zero release entries', { changelogPath });
    }
    if (!version) {
      return entries;
    }

    const exact = entries.filter(entry => entry.version === version);
    if (exact.length > 0) {
      return exact;
    }

    // No heading for this exact version (changelog not updated for the
    // release) — fall back to the newest versioned entry so the once-per-
    // upgrade notice still shows something before the version is marked seen.
    const fallback = entries.find(entry => entry.version !== 'Unreleased') ?? entries[0];
    if (fallback) {
      logger.debug(`[whatsnew] No changelog entry for ${version} — falling back to ${fallback.version}`);
      return [fallback];
    }
    return [];
  } catch (error) {
    logger.debug('[whatsnew] Failed to read changelog:', error);
    return [];
  }
}

const lastSeenFilePath = (): string => getCodemiePath('.last-seen-version');

/**
 * Version for which the upgrade notice was last shown, or null if never.
 * Best-effort: an unreadable marker is treated as "never seen".
 */
export function getLastSeenVersion(): string | null {
  try {
    return readFileSync(lastSeenFilePath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record that the upgrade notice was shown for a version. Best-effort: write
 * failures are swallowed — worst case the notice shows once more.
 */
export function markVersionSeen(version: string): void {
  try {
    const file = lastSeenFilePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, version, 'utf-8');
  } catch (error) {
    logger.debug('[whatsnew] Failed to persist last-seen version (non-fatal):', error);
  }
}

/**
 * Render release notes to the console. Never throws.
 *
 * @param options.maxItems - Cap on the total number of bullets printed across
 *   all entries; when truncated, a pointer to `codemie whatsnew` is appended
 */
export function renderReleaseNotes(entries: ReleaseEntry[], options?: { maxItems?: number }): void {
  try {
    if (entries.length === 0) {
      return;
    }

    let remaining = options?.maxItems ?? Number.POSITIVE_INFINITY;
    let truncated = false;

    console.log();
    for (const entry of entries) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const dateSuffix = entry.date ? ` (${entry.date})` : '';
      console.log(chalk.bold.cyan(`## What's new in ${entry.version}${dateSuffix}`));

      for (const section of entry.sections) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (section.items.length === 0) {
          continue;
        }

        console.log(chalk.dim(`  ${section.title}`));
        for (const item of section.items) {
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          console.log(`  • ${item}`);
          remaining--;
        }
      }
      console.log();
    }

    if (truncated) {
      console.log(chalk.dim('  … run `codemie whatsnew` for the full notes'));
      console.log();
    }
  } catch (error) {
    logger.debug('[whatsnew] renderReleaseNotes failed (non-fatal):', error);
  }
}

/**
 * Whether the once-per-upgrade notice may print. Deliberately shares the
 * CODEMIE_TIPS switch with feature tips — one "reduce chatter" toggle for all
 * informational CLI output.
 */
export function isWhatsNewEnabled(): boolean {
  return isTipsEnabled();
}
