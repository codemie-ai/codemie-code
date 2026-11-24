/**
 * What's New — release notes from CHANGELOG.md
 *
 * CHANGELOG.md (Keep a Changelog format) is the curated source of truth for
 * release notes. It ships inside the npm package and is consumed by:
 * - `codemie whatsnew` — browse notes for the current, one, or all versions
 * - the once-per-upgrade startup notice in bin/codemie.js
 *   (`showUpgradeNotice`), which runs only on interactive, non-hook
 *   invocations and only moves forward: after an upgrade it shows the notes
 *   for the versions between the `.last-seen-version` marker (under the
 *   CodeMie home directory) and the installed version, newest first — never
 *   another version's notes in place of a missing section — then records the
 *   installed version
 *
 * This module must stay safe to import from the bin entry point, so its
 * dependencies are limited to fs/path/chalk plus the logger, paths, tips, and
 * version utilities — never commander or the CLI layer.
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
import { compareVersions, isValidSemanticVersion } from './version-utils.js';

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
 * @param version - When given, only the entry whose heading matches this
 *   exact version. There is no fallback to another version: notes for one
 *   release must never be shown under another release's banner
 * @returns Parsed entries (newest first, as written), or an empty array when
 *   the changelog is missing, unparseable, or has no section for `version`
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
    if (exact.length === 0) {
      logger.debug(`[whatsnew] No changelog entry for ${version}`);
    }
    return exact;
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

/** Most release entries the upgrade notice prints before pointing to `--all`. */
const MAX_NOTICE_VERSIONS = 3;
/** Bullet cap for each entry rendered by the upgrade notice. */
const MAX_NOTICE_ITEMS = 6;
/** Arguments whose invocations have their own output contract. */
const OUTPUT_CONTRACT_ARGS = new Set(['--version', '-V', '--task', '--help']);

export type UpgradeNoticeAction = 'record-silently' | 'show' | 'none';

/**
 * Decide what the upgrade notice does for an installed version and marker.
 *
 * - An unparseable installed version: `none` (nothing to compare or record).
 * - No marker, or one that is not plain semver (e.g. `garbage`, a
 *   pre-release): `record-silently` — treated as a fresh install.
 * - Installed newer than the marker: `show`.
 * - Same or older (a downgrade): `none` — the marker only moves forward.
 */
export function decideUpgradeNotice(installed: string, lastSeen: string | null): UpgradeNoticeAction {
  if (!isValidSemanticVersion(installed)) {
    return 'none';
  }
  if (lastSeen === null || !isValidSemanticVersion(lastSeen)) {
    return 'record-silently';
  }
  return compareVersions(installed, lastSeen) > 0 ? 'show' : 'none';
}

/**
 * Pick the release entries to show after an upgrade: semver headings with
 * `lastSeen < version <= installed`, newest first, capped at three. When the
 * installed version has no section nothing is shown — older notes are never
 * presented as the installed version's.
 *
 * @returns `shown` entries and `hasMore`, true when entries were cut or the
 *   installed version's section is missing
 */
export function selectUpgradeEntries(
  entries: ReleaseEntry[],
  lastSeen: string,
  installed: string
): { shown: ReleaseEntry[]; hasMore: boolean } {
  const inRange = entries
    .filter(entry => isValidSemanticVersion(entry.version))
    .filter(entry => compareVersions(entry.version, lastSeen) > 0 && compareVersions(entry.version, installed) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));

  const hasInstalled = inRange.some(entry => compareVersions(entry.version, installed) === 0);
  if (!hasInstalled) {
    return { shown: [], hasMore: true };
  }

  return {
    shown: inRange.slice(0, MAX_NOTICE_VERSIONS),
    hasMore: inRange.length > MAX_NOTICE_VERSIONS
  };
}

/**
 * Whether the upgrade notice may run for this invocation: stdout must be a
 * known TTY, no output-contract flag may be present, and the command (the
 * first non-option argument, so `codemie --debug hook` counts) must not be
 * `hook`, whose stdout belongs to the calling agent.
 *
 * @param argv - CLI arguments without the node and script paths
 */
export function shouldRunUpgradeNotice(argv: string[], isTTY: boolean | undefined): boolean {
  if (isTTY !== true) {
    return false;
  }
  if (argv.some(arg => OUTPUT_CONTRACT_ARGS.has(arg))) {
    return false;
  }
  const command = argv.find(arg => !arg.startsWith('-'));
  return command !== 'hook';
}

/**
 * Print the once-per-upgrade notice for the installed version and record it
 * as seen. Never throws.
 */
export function showUpgradeNotice(installed: string): void {
  try {
    if (!isWhatsNewEnabled()) {
      return;
    }

    const lastSeen = getLastSeenVersion();
    const action = decideUpgradeNotice(installed, lastSeen);
    if (action === 'none') {
      return;
    }
    if (action === 'record-silently' || lastSeen === null) {
      markVersionSeen(installed);
      return;
    }

    const { shown, hasMore } = selectUpgradeEntries(getReleaseNotes(), lastSeen, installed);
    console.log(chalk.dim(`✨ Updated to ${installed}`));
    for (const entry of shown) {
      renderReleaseNotes([entry], { maxItems: MAX_NOTICE_ITEMS });
    }
    if (hasMore) {
      console.log(chalk.dim('run `codemie whatsnew --all` for older release notes'));
    }
    markVersionSeen(installed);
  } catch (error) {
    logger.debug('[whatsnew] showUpgradeNotice failed (non-fatal):', error);
  }
}
