/**
 * Doctor command - health check orchestrator
 */

import { Command } from 'commander';
import chalk from 'chalk';
import os from 'os';
import { HealthCheckResult } from './types.js';
import { HealthCheckFormatter } from './formatter.js';
import {
  NodeVersionCheck,
  NpmCheck,
  PythonCheck,
  UvCheck,
  AwsCliCheck,
  AIConfigCheck,
  AgentsCheck,
  WorkflowsCheck,
  FrameworksCheck
} from './checks/index.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import { adaptProviderResult } from './type-adapters.js';
import { logger } from '../../../utils/logger.js';

export function createDoctorCommand(): Command {
  const command = new Command('doctor');

  command
    .description('Check system health and configuration')
    .option('-v, --verbose', 'Enable verbose debug output with detailed API logs')
    .action(async (options: { verbose?: boolean }) => {
      // Enable debug mode if verbose flag is set
      if (options.verbose) {
        process.env.CODEMIE_DEBUG = 'true';

        // Show log file location
        const logFilePath = logger.getLogFilePath();
        if (logFilePath) {
          console.log(chalk.dim(`Debug logs: ${logFilePath}\n`));
        }
      }

      // Log system information for debugging
      logger.debug('=== CodeMie Doctor - System Information ===');
      logger.debug(`Platform: ${os.platform()}`);
      logger.debug(`OS: ${os.type()} ${os.release()}`);
      logger.debug(`Architecture: ${os.arch()}`);
      logger.debug(`Node Version: ${process.version}`);
      logger.debug(`Working Directory: ${process.cwd()}`);
      logger.debug(`Home Directory: ${os.homedir()}`);
      logger.debug(`Temp Directory: ${os.tmpdir()}`);

      // Log all environment variables (sanitized)
      logger.debug('=== Environment Variables (All) ===');
      const sortedEnvKeys = Object.keys(process.env).sort();
      for (const key of sortedEnvKeys) {
        const value = process.env[key];
        if (value) {
          // Mask sensitive values (API keys, tokens, secrets)
          if (key.toLowerCase().includes('key') ||
              key.toLowerCase().includes('token') ||
              key.toLowerCase().includes('secret') ||
              key.toLowerCase().includes('password')) {
            const masked = value.length > 12
              ? value.substring(0, 8) + '***' + value.substring(value.length - 4)
              : '***';
            logger.debug(`${key}: ${masked}`);
          } else {
            logger.debug(`${key}: ${value}`);
          }
        }
      }
      logger.debug('=== End Environment Variables ===');
      logger.debug('');

      const formatter = new HealthCheckFormatter();
      const results: HealthCheckResult[] = [];

      // Display header
      formatter.displayHeader();

      // Helper to display a pre-computed check result
      const displayResult = (result: HealthCheckResult): void => {
        formatter.displayCheck(result);
        if (result.details && result.details.length > 0) {
          result.details.forEach(detail => {
            logger.debug(`  - ${detail.status}: ${detail.message}`);
          });
        }
        logger.debug('');
      };

      // --- Group 1: Independent tool checks (run in parallel) ---
      const nodeCheck = new NodeVersionCheck();
      const npmCheck = new NpmCheck();
      const pythonCheck = new PythonCheck();
      const uvCheck = new UvCheck();
      const awsCheck = new AwsCliCheck();

      logger.debug('=== Running Tool Checks (parallel) ===');
      const toolStartTime = Date.now();
      const [nodeResult, npmResult, pythonResult, uvResult, awsResult] = await Promise.all([
        nodeCheck.run(),
        npmCheck.run(),
        pythonCheck.run(),
        uvCheck.run(),
        awsCheck.run()
      ]);
      logger.debug(`Tool checks completed in ${Date.now() - toolStartTime}ms`);

      // Display tool check results sequentially
      for (const result of [nodeResult, npmResult, pythonResult, uvResult, awsResult]) {
        results.push(result);
        displayResult(result);
      }

      // --- Group 2: AI Config + Provider check (sequential, provider depends on config) ---
      const aiConfigCheck = new AIConfigCheck();
      logger.debug('=== Running Check: Active Profile ===');
      const configStartTime = Date.now();
      const configResult = await aiConfigCheck.run();
      logger.debug(`Check completed in ${Date.now() - configStartTime}ms`);
      results.push(configResult);
      displayResult(configResult);

      // Run provider-specific checks if config is available
      const config = aiConfigCheck.getConfig();
      if (config && config.provider) {
        logger.debug(`=== Running Provider Check: ${config.provider} ===`);
        logger.debug(`Base URL: ${config.baseUrl}`);
        logger.debug(`Model: ${config.model}`);

        const healthCheck = ProviderRegistry.getHealthCheck(config.provider);

        if (healthCheck) {
          formatter.startCheck('Provider');

          try {
            const providerStartTime = Date.now();
            const providerResult = await healthCheck.check(config);
            logger.debug(`Provider check completed in ${Date.now() - providerStartTime}ms`);
            logger.debug(`Status: ${providerResult.status}`);

            const doctorResult = adaptProviderResult(providerResult);
            results.push(doctorResult);
            formatter.displayCheckWithHeader(doctorResult);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Provider check failed: ${errorMessage}`);
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }

            results.push({
              name: 'Provider Check Error',
              success: false,
              details: [{
                status: 'error',
                message: `Check failed: ${errorMessage}`
              }]
            });
          }
        } else {
          logger.debug(`No health check available for provider: ${config.provider}`);
        }
      }

      // --- Group 3: Discovery checks (run in parallel) ---
      const agentsCheck = new AgentsCheck();
      const workflowsCheck = new WorkflowsCheck();
      const frameworksCheck = new FrameworksCheck();

      logger.debug('=== Running Discovery Checks (parallel) ===');
      const discoveryStartTime = Date.now();
      const [agentsResult, workflowsResult, frameworksResult] = await Promise.all([
        agentsCheck.run(),
        workflowsCheck.run(),
        frameworksCheck.run()
      ]);
      logger.debug(`Discovery checks completed in ${Date.now() - discoveryStartTime}ms`);

      // Display discovery check results sequentially
      for (const result of [agentsResult, workflowsResult, frameworksResult]) {
        results.push(result);
        displayResult(result);
      }

      logger.debug('=== All Checks Completed ===');
      const successCount = results.filter(r => r.success).length;
      logger.debug(`Passed: ${successCount}/${results.length}`);

      // Display summary
      await formatter.displaySummary(results);
    });

  return command;
}
