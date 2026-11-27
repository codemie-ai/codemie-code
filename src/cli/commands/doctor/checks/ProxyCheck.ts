/**
 * Proxy Health Check
 *
 * The condensed `proxy doctor`: no authenticated probe, never fails on warnings
 * (`codemie doctor` exits 1 on any `success: false`), and a proxy nothing is connected to is informational.
 */

import type { HealthCheck, HealthCheckDetail, HealthCheckResult } from '../types.js';
import { composeProxyDoctor } from '../../proxy/doctor/compose.js';
import type { DoctorPlan } from '../../proxy/doctor/plan.js';
import { logger } from '../../../../utils/logger.js';

/** The condensed section always ends by naming the full report. */
const FULL_REPORT_POINTER: HealthCheckDetail = { status: 'info', message: 'Full report: codemie proxy doctor' };

export class ProxyCheck implements HealthCheck {
  name = 'Proxy';

  /** The doctor plan of the collection the command resolved, or the error that resolve threw — this check's failure. */
  constructor(private readonly plan: DoctorPlan | Error) {}

  async run(): Promise<HealthCheckResult> {
    try {
      if (this.plan instanceof Error) throw this.plan;
      const report = await composeProxyDoctor({ authProbe: false, verbose: false, plan: this.plan });
      const details: HealthCheckDetail[] = report.sections.map(({ status, message, hint }) => ({
        status: report.nothingConnected && status === 'warn' ? 'info' : status,
        message,
        ...(hint !== undefined && { hint }),
      }));
      details.push(FULL_REPORT_POINTER);
      return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('[proxy-check] failed:', error);
      return {
        name: this.name,
        success: false,
        details: [{ status: 'error', message: `Proxy check failed: ${message}` }, FULL_REPORT_POINTER],
      };
    }
  }
}
