#!/usr/bin/env node

/**
 * CodeMie Native Agent
 * Direct executable for the codemie-code agent
 */

import { CodeMieCode } from '../dist/agents/codemie-code/index.js';
import { loadCodeMieConfig } from '../dist/agents/codemie-code/config.js';
import { logger } from '../dist/utils/logger.js';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDirname } from '../dist/utils/dirname.js';
import chalk from 'chalk';

const program = new Command();

// Read version from package.json
let version = '1.0.0';
try {
  const packageJsonPath = join(getDirname(import.meta.url), '../package.json');
  const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonContent);
  version = packageJson.version;
} catch {
  // Use default version if unable to read
}

program
  .name('codemie-code')
  .description('CodeMie Native Agent - Built-in LangGraph-based coding assistant')
  .version(version)
  .option('--task <task>', 'Execute a single task and exit')
  .option('--debug', 'Enable debug logging')
  .option('--plan', 'Enable structured planning mode with visual todo tracking')
  .option('--plan-only', 'Generate plan without execution (planning phase only)')
  .argument('[message...]', 'Initial message or conversation starter')
  .action(async (message, options) => {
    try {
      const workingDir = process.cwd();

      // Initialize the agent with debug flag
      const codeMie = new CodeMieCode(workingDir);

      try {
        await codeMie.initialize({ debug: options.debug });
      } catch (error) {
        logger.error('CodeMie configuration required. Please run: codemie setup');
        process.exit(1);
      }

      if (options.task) {
        // Single task execution with modern UI
        const planOptions = {
          planMode: options.plan || options.planOnly,
          planOnly: options.planOnly
        };
        const result = await codeMie.executeTaskWithUI(options.task, planOptions);
        console.log(result);
      } else if (message.length > 0) {
        // Execute initial message then continue interactively
        const initialMessage = message.join(' ');
        console.log(`> ${initialMessage}`);

        const planOptions = {
          planMode: options.plan || options.planOnly,
          planOnly: options.planOnly
        };
        await codeMie.executeTaskWithUI(initialMessage, planOptions);
        console.log(''); // Add spacing

        // Start interactive session (with plan mode if enabled)
        if (options.plan && !options.planOnly) {
          // Enable plan mode for interactive session
          const agent = codeMie.getAgent();
          if (agent) {
            const { CodeMieTerminalUI } = await import('../dist/agents/codemie-code/ui.js');
            const ui = new CodeMieTerminalUI(agent);
            ui.enablePlanMode();
            await ui.startInteractive();
            ui.dispose();
          } else {
            await codeMie.startInteractive();
          }
        } else if (!options.planOnly) {
          await codeMie.startInteractive();
        }
      } else {
        // Pure interactive mode
        if (options.plan) {
          // Enable plan mode for interactive session (no extra console message)
          const agent = codeMie.getAgent();
          if (agent) {
            const { CodeMieTerminalUI } = await import('../dist/agents/codemie-code/ui.js');
            const ui = new CodeMieTerminalUI(agent);
            ui.enablePlanMode();
            await ui.startInteractive();
            ui.dispose();
          } else {
            await codeMie.startInteractive();
          }
        } else {
          await codeMie.startInteractive();
        }
      }
    } catch (error) {
      logger.error('Failed to run CodeMie Native:', error);
      process.exit(1);
    }
  });

// Add health check command
program
  .command('health')
  .description('Check CodeMie Native health and configuration')
  .action(async () => {
    try {
      const result = await CodeMieCode.testConnection(process.cwd());

      if (result.success) {
        logger.success('CodeMie Native is healthy');
        console.log(`Provider: ${result.provider}`);
        console.log(`Model: ${result.model}`);
      } else {
        logger.error('CodeMie Native health check failed:');
        console.log(result.error);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  });

program.parse(process.argv);