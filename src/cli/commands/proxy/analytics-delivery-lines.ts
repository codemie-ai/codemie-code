import chalk from 'chalk';
import type { DaemonState } from './daemon-manager.js';
import { hasActiveAnalyticsConnector } from './analytics-connectors.js';
import { getEffectiveClientType } from './client-type.js';
import { readDesktopGateway } from './connectors/desktop.js';
import { collectDeliveryHealth, DELIVERY_REASONS, formatDropLines, type DeliveryHealth } from './delivery-health.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';

/**
 * Analytics delivery health for `proxy status`, or null when no connector is connected (a connected
 * Claude Desktop counts as one).
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

/**
 * The `Analytics:` headline for `proxy status`, with an indented `Run:` tip when there is a remedy,
 * then the `Last dropped:` detail when the spool records a drop.
 */
export function formatAnalyticsLines(delivery: DeliveryHealth): string[] {
  return [...analyticsHeadline(delivery), ...formatDropLines(delivery.latestDrop)];
}

function analyticsHeadline(delivery: DeliveryHealth): string[] {
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

export interface DesktopCollection {
  connected: true;
  collecting: boolean;
  reason?: string;
  remedy?: string;
}

/**
 * Whether the daemon collects what the connected Claude Desktop sends: Desktop mode, on the gateway's port; null when
 * Claude Desktop has no CodeMie gateway.
 */
export async function collectDesktopCollection(state: DaemonState): Promise<DesktopCollection | null> {
  const gateway = await readDesktopGateway();
  return gateway ? describeDesktopCollection(state, gateway.port) : null;
}

function describeDesktopCollection(state: DaemonState, gatewayPort: number): DesktopCollection {
  if (state.telemetryMode !== 'claude-desktop') {
    return {
      connected: true,
      collecting: false,
      reason: `the proxy runs as ${getEffectiveClientType(state)}`,
      remedy: 'codemie proxy connect --claude-desktop replaces it',
    };
  }
  if (gatewayPort !== state.port) {
    return {
      connected: true,
      collecting: false,
      reason: `Claude Desktop points at port ${gatewayPort}, the proxy listens on ${state.port}`,
      remedy: 'run: codemie proxy connect --claude-desktop',
    };
  }
  return { connected: true, collecting: true };
}

/** The `Desktop:` line for `proxy status`. */
export function formatDesktopLine(desktop: DesktopCollection): string {
  return desktop.collecting
    ? '  Desktop: collecting'
    : chalk.yellow(`  Desktop: NOT collecting — ${desktop.reason}; ${desktop.remedy}`);
}
