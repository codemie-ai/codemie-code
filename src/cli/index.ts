#!/usr/bin/env node

import { Command } from 'commander';
import { createListCommand } from './commands/list.js';
import { createInstallCommand } from './commands/install.js';
import { createUninstallCommand } from './commands/uninstall.js';
import { createRunCommand } from './commands/run.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createVersionCommand } from './commands/version.js';
import { createSetupCommand } from './commands/setup.js';
import { createConfigCommand } from './commands/config.js';
import { createEnvCommand } from './commands/env.js';
import { FirstTimeExperience } from '../utils/first-time.js';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDirname } from '../utils/dirname.js';

const program = new Command();

// Read version from package.json
let version = '1.0.0';
try {
  const packageJsonPath = join(getDirname(import.meta.url), '../../package.json');
  const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonContent) as { version: string };
  version = packageJson.version;
} catch {
  // Use default version if unable to read
}

program
  .name('codemie')
  .description('CLI wrapper for managing multiple AI coding agents')
  .version(version);

// Add commands
program.addCommand(createSetupCommand());
program.addCommand(createEnvCommand());
program.addCommand(createConfigCommand());
program.addCommand(createListCommand());
program.addCommand(createInstallCommand());
program.addCommand(createUninstallCommand());
program.addCommand(createRunCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createVersionCommand());

// Show help if no command provided
if (process.argv.length === 2) {
  // Check if this is a first-time user
  FirstTimeExperience.isFirstTime().then(isFirstTime => {
    if (isFirstTime) {
      // Show welcome message and recommendations for first-time users
      FirstTimeExperience.showWelcomeMessage();
    } else {
      // Show quick start guide for returning users
      FirstTimeExperience.showQuickStart();
    }
  }).catch(() => {
    // Fallback to default help if detection fails
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║         CodeMie CLI Wrapper           ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));
    program.help();
  });
} else {
  program.parse(process.argv);
}
