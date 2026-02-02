#!/usr/bin/env node

import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

// Initialize provider plugins (triggers auto-registration)
import '../providers/index.js';

// Initialize framework plugins (triggers auto-registration)
import '../frameworks/plugins/index.js';

import { createListCommand } from './commands/list.js';
import { createInstallCommand } from './commands/install.js';
import { createUninstallCommand } from './commands/uninstall.js';
import { createUpdateCommand } from './commands/update.js';
import { createSelfUpdateCommand } from './commands/self-update.js';
import { createDoctorCommand } from './commands/doctor/index.js';
import { createVersionCommand } from './commands/version.js';
import { createSetupCommand } from './commands/setup.js';
import { createWorkflowCommand } from './commands/workflow.js';
import { createProfileCommand } from './commands/profile/index.js';
import { createAnalyticsCommand } from './commands/analytics/index.js';
import { createHookCommand } from './commands/hook.js';
import { createSkillCommand } from './commands/skill.js';
import { createOpencodeMetricsCommand } from './commands/opencode-metrics.js';
import { createAssistantsCommand } from './commands/assistants/index.js';
import { FirstTimeExperience } from './first-time.js';
import { getDirname } from '../utils/paths.js';

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
  .description('AI/Run CodeMie CLI - Professional CLI wrapper for managing multiple AI coding agents')
  .version(version)
  .option('--task <task>', 'Execute a single task using the built-in agent and exit');

// Add commands
program.addCommand(createSetupCommand());
program.addCommand(createProfileCommand());
program.addCommand(createAssistantsCommand());
program.addCommand(createListCommand());
program.addCommand(createInstallCommand());
program.addCommand(createUninstallCommand());
program.addCommand(createUpdateCommand());
program.addCommand(createSelfUpdateCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createVersionCommand());
program.addCommand(createWorkflowCommand());
program.addCommand(createAnalyticsCommand());
program.addCommand(createHookCommand());
program.addCommand(createSkillCommand());
program.addCommand(createOpencodeMetricsCommand());

// Check for --task option before parsing commands
const taskIndex = process.argv.indexOf('--task');
if (taskIndex !== -1 && taskIndex < process.argv.length - 1) {
  // Extract task and run the built-in agent
  const task = process.argv[taskIndex + 1];

  (async () => {
    try {
      const { CodeMieCode } = await import('../agents/codemie-code/index.js');
      const { logger } = await import('../utils/logger.js');

      const workingDir = process.cwd();
      const codeMie = new CodeMieCode(workingDir);

      try {
        await codeMie.initialize();
      } catch {
        logger.error('CodeMie configuration required. Please run: codemie setup');
        process.exit(1);
      }

      // Execute task with UI
      await codeMie.executeTaskWithUI(task);
      process.exit(0);
    } catch (error) {
      console.error('Failed to run task:', error);
      process.exit(1);
    }
  })();
} else if (process.argv.length === 2) {
  // Show prettified help if no command provided (just "codemie")
  FirstTimeExperience.isFirstTime().then(async isFirstTime => {
    if (isFirstTime) {
      // Show welcome message and recommendations for first-time users
      await FirstTimeExperience.showWelcomeMessage();
    } else {
      // Show quick start guide for returning users
      await FirstTimeExperience.showQuickStart();
    }
  }).catch(() => {
    // Fallback to default help if detection fails
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║         CodeMie CLI Wrapper           ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));
    program.help();
  });
} else {
  // Parse commands normally (including --help flag)
  program.parse(process.argv);
}
