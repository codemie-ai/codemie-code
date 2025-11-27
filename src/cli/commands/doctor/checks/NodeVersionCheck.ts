/**
 * Node.js version health check
 */

import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class NodeVersionCheck implements HealthCheck {
  name = 'Node.js';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

      if (majorVersion >= 18) {
        details.push({
          status: 'ok',
          message: `Version ${nodeVersion}`
        });
      } else {
        details.push({
          status: 'warn',
          message: `Version ${nodeVersion}`,
          hint: 'Recommended: >= 18.0.0'
        });
        success = false;
      }
    } catch (error) {
      details.push({
        status: 'error',
        message: 'Failed to check version',
        hint: String(error)
      });
      success = false;
    }

    return { name: this.name, success, details };
  }
}
