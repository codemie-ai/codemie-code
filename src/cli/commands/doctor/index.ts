/**
 * Doctor command - health check orchestrator
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { HealthCheck, ItemWiseHealthCheck, HealthCheckResult } from './types.js';
import { HealthCheckFormatter } from './formatter.js';
import {
  NodeVersionCheck,
  NpmCheck,
  PythonCheck,
  UvCheck,
  AIConfigCheck,
  AgentsCheck,
  WorkflowsCheck
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
        new AIConfigCheck(),
        new AgentsCheck(),
        new WorkflowsCheck()
      ];

      // Run and display standard checks immediately
      for (const check of checks) {
        // Check if this is an ItemWiseHealthCheck
        const isItemWise = 'runWithItemDisplay' in check;

        if (isItemWise) {
          // Display section header
          console.log(formatter['getCheckHeader'](check.name));

          // Run with item-by-item display
          const result = await (check as ItemWiseHealthCheck).runWithItemDisplay(
            (itemName) => formatter.startItem(itemName),
            (detail) => formatter.displayItem(detail)
          );
          results.push(result);

          // Add blank line after section
          console.log();
        } else {
          // Regular check with section-level progress
          formatter.startCheck(check.name);
          const result = await check.run((message) => {
            formatter.updateProgress(message);
          });
          results.push(result);
          formatter.displayCheck(result);
        }

        // After AIConfigCheck, immediately run provider-specific checks
        if (check instanceof AIConfigCheck) {
          const config = check.getConfig();

          if (config && config.provider) {
            // Get health check from ProviderRegistry
            const healthCheck = ProviderRegistry.getHealthCheck(config.provider);

            if (healthCheck) {
              formatter.startCheck('Provider');

              try {
                const providerResult = await healthCheck.check(config);
                const doctorResult = adaptProviderResult(providerResult);
                results.push(doctorResult);
                formatter.displayCheckWithHeader(doctorResult);
              } catch (error) {
                // If check throws, capture error
                results.push({
                  name: 'Provider Check Error',
                  success: false,
                  details: [{
                    status: 'error',
                    message: `Check failed: ${error instanceof Error ? error.message : String(error)}`
                  }]
                });
              }
            }
          }
        }
      }

      // Display summary
      await formatter.displaySummary(results);
    });

  return command;
}
