#!/usr/bin/env node

import chalk from 'chalk';
import { FirstTimeExperience } from './first-time.js';
import { installSystemProxyDispatcher } from '../utils/system-proxy-dispatcher.js';
import { createProgram } from './program.js';

installSystemProxyDispatcher();
const program = createProgram();

// Check for --task option before parsing commands
const taskIndex = process.argv.indexOf('--task');
if (taskIndex !== -1 && taskIndex < process.argv.length - 1) {
  (async () => {
    try {
      const { AgentRegistry } = await import('../agents/registry.js');
      const { AgentCLI } = await import('../agents/core/AgentCLI.js');
      const agent = AgentRegistry.getAgent('codemie-code');
      if (!agent) {
        console.error('CodeMie Code agent not found. Run: codemie doctor');
        process.exit(1);
      }
      const cli = new AgentCLI(agent);
      await cli.run(process.argv);
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
