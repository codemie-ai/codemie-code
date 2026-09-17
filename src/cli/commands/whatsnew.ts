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
  version?: string;
}

export function createWhatsnewCommand(): Command {
  const command = new Command('whatsnew');

  command
    .description('Show release notes (from CHANGELOG.md)')
    .option('--all', 'Show release notes for all versions')
    .option('--version <version>', 'Show release notes for a specific version')
    .action((options: WhatsnewCommandOptions) => {
      const targetVersion = options.all ? undefined : (options.version ?? getCurrentVersion());
      const entries = getReleaseNotes(targetVersion);

      if (entries.length === 0) {
        console.log(chalk.yellow(`\nNo release notes found for ${targetVersion ?? 'this installation'} — try \`codemie whatsnew --all\`\n`));
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
