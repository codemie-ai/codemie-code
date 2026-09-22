/**
 * Whatsnew command - Show release notes from CHANGELOG.md
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDirname } from '../../utils/paths.js';
import { getReleaseNotes, renderReleaseNotes } from '../../utils/whatsnew.js';

interface WhatsnewCommandOptions {
  all?: boolean;
}

export function createWhatsnewCommand(): Command {
  const command = new Command('whatsnew');

  command
    .description('Show release notes (from CHANGELOG.md)')
    .argument('[version]', 'Show release notes for a specific version (default: current)')
    .option('--all', 'Show release notes for all versions')
    .action((version: string | undefined, options: WhatsnewCommandOptions) => {
      const targetVersion = options.all ? undefined : (version ?? getCurrentVersion());
      const entries = getReleaseNotes(targetVersion);

      if (entries.length === 0) {
        console.log(chalk.yellow('\nNo release notes found — CHANGELOG.md is missing or has no entries.\n'));
        return;
      }

      renderReleaseNotes(entries);
    });

  return command;
}

function getCurrentVersion(): string {
  try {
    const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    return (JSON.parse(packageJsonContent) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
