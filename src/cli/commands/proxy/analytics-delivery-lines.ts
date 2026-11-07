import chalk from 'chalk';
import type { DaemonState } from './daemon-manager.js';
import { hasActiveAnalyticsConnector } from './analytics-connectors.js';
import { collectDeliveryHealth, DELIVERY_REASONS, type DeliveryHealth } from './delivery-health.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';

/**
 * Analytics delivery health for `proxy status`, or null when no connector is connected.
 * Leftover unsent spool bytes never make it visible: with nothing connected there is nothing to report.
 */
export async function collectVisibleDeliveryHealth(
  state: DaemonState,
  reply: AnalyticsHealthReply | undefined
): Promise<DeliveryHealth | null> {
  if (!(await hasActiveAnalyticsConnector())) {
    return null;
  }
  return collectDeliveryHealth(state, reply);
}

/** The `Analytics:` headline for `proxy status`, with an indented `Run:` tip when there is a remedy. */
export function formatAnalyticsLines(delivery: DeliveryHealth): string[] {
  if (delivery.status === 'healthy') {
    return [`Analytics: ${chalk.green('healthy')}`];
  }
  if (delivery.status === 'unhealthy') {
    const entry = delivery.reason ? DELIVERY_REASONS[delivery.reason] : undefined;
    return [
      `Analytics: ${chalk.yellow(`unhealthy${entry ? ` (${entry.label})` : ''}`)}`,
      `  Run: ${entry?.run ?? 'codemie proxy analytics status'}`,
    ];
  }
  return [`Analytics: ${chalk.dim('unknown (restart the proxy to enable all checks)')}`];
}
