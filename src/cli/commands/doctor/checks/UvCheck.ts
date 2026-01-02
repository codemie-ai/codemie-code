/**
 * UV (Python package installer) health check
 */

import { exec } from '../../../../utils/processes.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class UvCheck implements HealthCheck {
  name = 'uv';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const result = await exec('uv', ['--version']);
      const version = result.stdout.trim();

      details.push({
        status: 'ok',
        message: `Version ${version.replace('uv ', '')}`
      });
    } catch {
      details.push({
        status: 'info',
        message: 'uv not found',
        hint: 'Install uv from https://docs.astral.sh/uv/ (optional, faster Python package management)'
      });
      // Not critical, so don't mark as failure
    }

    return { name: this.name, success, details };
  }
}
