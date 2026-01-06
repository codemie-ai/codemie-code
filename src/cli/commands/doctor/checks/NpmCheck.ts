/**
 * npm health check
 */

import * as npm from '../../../../utils/processes.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class NpmCheck implements HealthCheck {
  name = 'npm';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const version = await npm.getVersion();

    if (version) {
      details.push({
        status: 'ok',
        message: `Version ${version}`
      });
    } else {
      details.push({
        status: 'error',
        message: 'npm not found',
        hint: 'Install npm from https://nodejs.org'
      });
      success = false;
    }

    return { name: this.name, success, details };
  }
}
