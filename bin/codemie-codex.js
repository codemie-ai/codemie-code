#!/usr/bin/env node

/**
 * CodeMie Codex Direct Agent
 * Direct executable for the codex agent (bypasses registry)
 */

import { CodexAdapter } from '../dist/agents/adapters/codex.js';
import { ConfigLoader } from '../dist/utils/config-loader.js';
import { logger } from '../dist/utils/logger.js';
import { validateProviderCompatibility, validateModelCompatibility, displayCompatibilityError } from '../dist/utils/agent-compatibility.js';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDirname } from '../dist/utils/dirname.js';

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
  .name('codemie-codex')
  .description('CodeMie Codex - Direct access to OpenAI Codex agent')
  .version(version)
  .option('-m, --model <model>', 'Override model (must be OpenAI-compatible)')
  .option('-p, --provider <provider>', 'Override provider')
  .option('--api-key <key>', 'Override API key')
  .option('--base-url <url>', 'Override base URL')
  .option('--timeout <seconds>', 'Override timeout (in seconds)', parseInt)
  .allowUnknownOption() // Allow passing unknown options to Codex
  .passThroughOptions() // Pass through options to Codex
  .argument('[args...]', 'Arguments to pass to Codex')
  .action(async (args, options) => {
    try {
      const adapter = new CodexAdapter();

      // Check if Codex is installed
      if (!(await adapter.isInstalled())) {
        logger.error('Codex is not installed. Install it first with: codemie install codex');
        process.exit(1);
      }

      // Load configuration with CLI overrides
      const config = await ConfigLoader.load(process.cwd(), {
        model: options.model,
        provider: options.provider,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        timeout: options.timeout
      });

      // Validate essential configuration
      if (!config.baseUrl || !config.apiKey || !config.model) {
        logger.error('Configuration incomplete. Run: codemie setup');
        process.exit(1);
      }

      // Validate provider compatibility
      const providerResult = validateProviderCompatibility('codex', config);
      if (!providerResult.valid) {
        displayCompatibilityError(providerResult, logger);
        process.exit(1);
      }

      // Validate model compatibility
      const modelResult = validateModelCompatibility('codex', config);
      if (!modelResult.valid) {
        displayCompatibilityError(modelResult, logger);
        process.exit(1);
      }

      // Export provider-specific environment variables
      const providerEnv = ConfigLoader.exportProviderEnvVars(config);

      // Collect all arguments to pass to Codex
      const codexArgs = [...args];

      // Add back unknown options that were parsed
      const knownOptions = ['model', 'provider', 'apiKey', 'baseUrl', 'timeout'];
      for (const [key, value] of Object.entries(options)) {
        if (knownOptions.includes(key)) continue;

        if (key.length === 1) {
          codexArgs.push(`-${key}`);
        } else {
          codexArgs.push(`--${key}`);
        }

        if (value !== true && value !== undefined) {
          codexArgs.push(String(value));
        }
      }

      // Run Codex directly
      logger.info(`Starting Codex with model ${config.model}...`);
      await adapter.run(codexArgs, providerEnv);
    } catch (error) {
      logger.error('Failed to run Codex:', error);
      process.exit(1);
    }
  });

// Add health check command
program
  .command('health')
  .description('Check Codex health and installation')
  .action(async () => {
    try {
      const adapter = new CodexAdapter();

      if (await adapter.isInstalled()) {
        const version = await adapter.getVersion();
        logger.success('Codex is installed and ready');
        if (version) {
          console.log(`Version: ${version}`);
        }
      } else {
        logger.error('Codex is not installed');
        console.log('Install with: codemie install codex');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  });

program.parse(process.argv);