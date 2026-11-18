/**
 * Proxy Health Check
 *
 * The condensed `proxy doctor`: no authenticated probe, never fails on warnings
 * (`codemie doctor` exits 1 on any `success: false`), and a proxy nothing is connected to is informational.
 */

import type { HealthCheck, HealthCheckDetail, HealthCheckResult } from '../types.js';
import { composeProxyDoctor } from '../../proxy/doctor/compose.js';
import { logger } from '../../../../utils/logger.js';

export class ProxyCheck implements HealthCheck {
  name = 'Proxy';

  async run(): Promise<HealthCheckResult> {
    try {
      const report = await composeProxyDoctor({ authProbe: false, verbose: false });
      const details: HealthCheckDetail[] = report.sections.map(({ status, message, hint }) => ({
        status: report.nothingConnected && status === 'warn' ? 'info' : status,
        message,
        ...(hint !== undefined && { hint }),
      }));
      return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('[proxy-check] failed:', error);
      return { name: this.name, success: false, details: [{ status: 'error', message: `Proxy check failed: ${message}` }] };
    }
  }
}
