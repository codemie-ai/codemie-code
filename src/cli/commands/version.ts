import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDirname } from '../../utils/paths.js';

export function createVersionCommand(): Command {
  const command = new Command('version');

  command
    .description('Show version information')
    .action(() => {
      try {
        const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
        const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent) as { version: string };
        console.log(chalk.bold(`\nAI/Run CodeMie CLI v${packageJson.version}\n`));
      } catch {
        console.log(chalk.yellow('\nVersion information not available\n'));
      }
    });

  return command;
}
