/**
 * npm health check
 */

import { exec } from '../../../../utils/exec.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class NpmCheck implements HealthCheck {
  name = 'npm';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const result = await exec('npm', ['--version']);
      details.push({
        status: 'ok',
        message: `Version ${result.stdout}`
      });
    } catch {
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
