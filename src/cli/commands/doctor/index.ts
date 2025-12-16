/**
 * Doctor command - health check orchestrator
 */

import { Command } from 'commander';
import chalk from 'chalk';
import os from 'os';
import { HealthCheck, ItemWiseHealthCheck, HealthCheckResult } from './types.js';
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

      // Define standard health checks
      const checks: HealthCheck[] = [
        new NodeVersionCheck(),
        new NpmCheck(),
        new PythonCheck(),
        new UvCheck(),
        new AwsCliCheck(),
        new AIConfigCheck(),
        new AgentsCheck(),
        new WorkflowsCheck(),
        new FrameworksCheck()
      ];

      // Run and display standard checks immediately
      for (const check of checks) {
        logger.debug(`=== Running Check: ${check.name} ===`);
        const startTime = Date.now();

        // Check if this is an ItemWiseHealthCheck
        const isItemWise = 'runWithItemDisplay' in check;

        if (isItemWise) {
          // Display section header
          console.log(formatter['getCheckHeader'](check.name));

          // Run with item-by-item display
          const result = await (check as ItemWiseHealthCheck).runWithItemDisplay(
            (itemName) => {
              logger.debug(`  Checking item: ${itemName}`);
              formatter.startItem(itemName);
            },
            (detail) => {
              logger.debug(`  Result: ${detail.status} - ${detail.message}`);
              formatter.displayItem(detail);
            }
          );
          results.push(result);

          const elapsed = Date.now() - startTime;
          logger.debug(`Check completed in ${elapsed}ms: ${result.success ? 'SUCCESS' : 'FAILED'}`);
          logger.debug('');

          // Add blank line after section
          console.log();
        } else {
          // Regular check with section-level progress
          formatter.startCheck(check.name);
          const result = await check.run((message) => {
            logger.debug(`  Progress: ${message}`);
            formatter.updateProgress(message);
          });
          results.push(result);
          formatter.displayCheck(result);

          const elapsed = Date.now() - startTime;
          logger.debug(`Check completed in ${elapsed}ms: ${result.success ? 'SUCCESS' : 'FAILED'}`);
          if (result.details && result.details.length > 0) {
            result.details.forEach(detail => {
              logger.debug(`  - ${detail.status}: ${detail.message}`);
            });
          }
          logger.debug('');
        }

        // After AIConfigCheck, immediately run provider-specific checks
        if (check instanceof AIConfigCheck) {
          const config = check.getConfig();

          if (config && config.provider) {
            logger.debug(`=== Running Provider Check: ${config.provider} ===`);
            logger.debug(`Base URL: ${config.baseUrl}`);
            logger.debug(`Model: ${config.model}`);

            // Get health check from ProviderRegistry
            const healthCheck = ProviderRegistry.getHealthCheck(config.provider);

            if (healthCheck) {
              formatter.startCheck('Provider');

              try {
                const providerStartTime = Date.now();
                const providerResult = await healthCheck.check(config);
                const elapsed = Date.now() - providerStartTime;

                logger.debug(`Provider check completed in ${elapsed}ms`);
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

                // If check throws, capture error
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
        }
      }

      logger.debug('=== All Checks Completed ===');
      const successCount = results.filter(r => r.success).length;
      logger.debug(`Passed: ${successCount}/${results.length}`);

      // Display summary
      await formatter.displaySummary(results);
    });

  return command;
}
