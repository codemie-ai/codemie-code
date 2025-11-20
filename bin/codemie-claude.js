#!/usr/bin/env node

/**
 * CodeMie Claude Direct Agent
 * Direct executable for the claude agent (bypasses registry)
 */

import { ClaudeCodeAdapter } from '../dist/agents/adapters/claude-code.js';
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
  .name('codemie-claude')
  .description('CodeMie Claude - Direct access to Claude Code agent')
  .version(version)
  .option('-m, --model <model>', 'Override model')
  .option('-p, --provider <provider>', 'Override provider')
  .option('--api-key <key>', 'Override API key')
  .option('--base-url <url>', 'Override base URL')
  .option('--timeout <seconds>', 'Override timeout (in seconds)', parseInt)
  .allowUnknownOption() // Allow passing unknown options to Claude
  .passThroughOptions() // Pass through options to Claude
  .argument('[args...]', 'Arguments to pass to Claude Code')
  .action(async (args, options) => {
    try {
      const adapter = new ClaudeCodeAdapter();

      // Check if Claude Code is installed
      if (!(await adapter.isInstalled())) {
        logger.error('Claude Code is not installed. Install it first with: codemie install claude');
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

      // Handle SSO provider detection
      if (config.provider === 'ai-run-sso' || (config.baseUrl && config.baseUrl.includes('codemie'))) {
        // Update provider to ai-run-sso if detected from baseUrl
        if (config.provider !== 'ai-run-sso') {
          config.provider = 'ai-run-sso';
        }
      }

      // Validate essential configuration
      if (!config.baseUrl || !config.apiKey || !config.model) {
        logger.error('Configuration incomplete. Run: codemie setup');
        process.exit(1);
      }

      // Validate provider compatibility
      const providerResult = validateProviderCompatibility('claude', config);
      if (!providerResult.valid) {
        displayCompatibilityError(providerResult, logger);
        process.exit(1);
      }

      // Validate model compatibility
      const modelResult = validateModelCompatibility('claude', config);
      if (!modelResult.valid) {
        displayCompatibilityError(modelResult, logger);
        process.exit(1);
      }

      // Export provider-specific environment variables
      const providerEnv = ConfigLoader.exportProviderEnvVars(config);

      // Collect all arguments to pass to Claude
      const claudeArgs = [...args];

      // Add back unknown options that were parsed
      const knownOptions = ['model', 'provider', 'apiKey', 'baseUrl', 'timeout'];
      for (const [key, value] of Object.entries(options)) {
        if (knownOptions.includes(key)) continue;

        if (key.length === 1) {
          claudeArgs.push(`-${key}`);
        } else {
          claudeArgs.push(`--${key}`);
        }

        if (value !== true && value !== undefined) {
          claudeArgs.push(String(value));
        }
      }

      // Run Claude Code directly
      logger.info(`Starting Claude Code with model ${config.model}...`);
      await adapter.run(claudeArgs, providerEnv);
    } catch (error) {
      logger.error('Failed to run Claude Code:', error);
      process.exit(1);
    }
  });

// Add health check command
program
  .command('health')
  .description('Check Claude Code health and installation')
  .action(async () => {
    try {
      const adapter = new ClaudeCodeAdapter();

      if (await adapter.isInstalled()) {
        const version = await adapter.getVersion();
        logger.success('Claude Code is installed and ready');
        if (version) {
          console.log(`Version: ${version}`);
        }
      } else {
        logger.error('Claude Code is not installed');
        console.log('Install with: codemie install claude');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  });

program.parse(process.argv);