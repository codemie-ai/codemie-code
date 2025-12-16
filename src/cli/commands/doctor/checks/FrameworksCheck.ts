/**
 * Frameworks Health Check
 *
 * Verifies installation status of development frameworks
 */

import type { HealthCheckResult, ItemWiseHealthCheck, HealthCheckDetail } from '../types.js';
import { FrameworkRegistry } from '../../../../frameworks/index.js';

export class FrameworksCheck implements ItemWiseHealthCheck {
  name = 'Frameworks';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const frameworks = FrameworkRegistry.getAllFrameworks();

      if (frameworks.length === 0) {
        details.push({
          status: 'info',
          message: 'No frameworks registered'
        });
      } else {
        // Check each framework
        for (const framework of frameworks) {
          const installed = await framework.isInstalled();
          const version = installed ? await framework.getVersion() : null;
          const versionStr = version ? ` (${version})` : '';

          if (installed) {
            details.push({
              status: 'ok',
              message: `${framework.metadata.displayName}${versionStr}`
            });
          } else {
            details.push({
              status: 'info',
              message: `${framework.metadata.displayName} - not installed`
            });
          }
        }
      }

      return { name: this.name, success, details };
    } catch (error) {
      return {
        name: this.name,
        success: false,
        details: [{
          status: 'error',
          message: `Failed to check frameworks: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }

  async runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void
  ): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const frameworks = FrameworkRegistry.getAllFrameworks();

      if (frameworks.length === 0) {
        const detail: HealthCheckDetail = {
          status: 'info',
          message: 'No frameworks registered'
        };
        details.push(detail);
        onDisplayItem(detail);
      } else {
        // Check each framework
        for (const framework of frameworks) {
          onStartItem(`Checking ${framework.metadata.displayName}...`);

          const installed = await framework.isInstalled();
          const version = installed ? await framework.getVersion() : null;
          const versionStr = version ? ` (${version})` : '';

          const detail: HealthCheckDetail = installed
            ? {
                status: 'ok',
                message: `${framework.metadata.displayName}${versionStr}`
              }
            : {
                status: 'info',
                message: `${framework.metadata.displayName} - not installed`
              };

          details.push(detail);
          onDisplayItem(detail);
        }
      }

      return { name: this.name, success, details };
    } catch (error) {
      const detail: HealthCheckDetail = {
        status: 'error',
        message: `Failed to check frameworks: ${error instanceof Error ? error.message : String(error)}`
      };
      details.push(detail);
      onDisplayItem(detail);

      return {
        name: this.name,
        success: false,
        details
      };
    }
  }
}
