/**
 * AWS CLI health check
 */

import { exec } from '../../../../utils/processes.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class AwsCliCheck implements HealthCheck {
  name = 'AWS CLI';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const result = await exec('aws', ['--version']);
      details.push({
        status: 'ok',
        message: `Version ${result.stdout}`
      });
    } catch {
      details.push({
        status: 'warn',
        message: 'AWS CLI not found',
        hint: 'Optional: Install AWS CLI from https://aws.amazon.com/cli/ (required for Bedrock profile management)'
      });
      success = false;
    }

    return { name: this.name, success, details };
  }
}
