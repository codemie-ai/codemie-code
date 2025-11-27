/**
 * Python version health check
 */

import { exec } from '../../../../utils/exec.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class PythonCheck implements HealthCheck {
  name = 'Python';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      // Try python3 first (preferred on most systems)
      let result;
      try {
        result = await exec('python3', ['--version']);
      } catch {
        // Fallback to python command
        result = await exec('python', ['--version']);
      }

      const version = result.stdout.trim() || result.stderr.trim();
      const versionMatch = version.match(/Python (\d+\.\d+\.\d+)/);

      if (versionMatch) {
        const [major, minor] = versionMatch[1].split('.').map(Number);

        if (major >= 3 && minor >= 8) {
          details.push({
            status: 'ok',
            message: `Version ${versionMatch[1]}`
          });
        } else {
          details.push({
            status: 'warn',
            message: `Version ${versionMatch[1]}`,
            hint: 'Recommended: Python >= 3.8'
          });
        }
      } else {
        details.push({
          status: 'ok',
          message: version
        });
      }
    } catch {
      details.push({
        status: 'warn',
        message: 'Python not found',
        hint: 'Install Python from https://python.org (required for some agents)'
      });
      // Not critical, so don't mark as failure
    }

    return { name: this.name, success, details };
  }
}
