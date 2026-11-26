/**
 * The proxy diagnosis of a machine with a CodeMie backend: the `proxy` commands as remedies, the sign-in and delivery
 * sections, every display group, and the daemon described by its profile.
 */
import { renderHint } from '@/utils/hint.js';
import { readDaemonStatus, type DaemonState } from '../daemon-manager.js';
import { checkProxyHealth } from '../health-check.js';
import { collectDeliveryHealth, type DeliveryHealth } from '../delivery-health.js';
import { RELATED } from '@/cli/related-commands.js';
import { CLAUDE_OTLP_FLAG, COPILOT_OTLP_FLAG } from '../flag-list.js';
import { resumeNote } from '../analytics-hints.js';
import { deliverySections } from './delivery-sections.js';
import { PROXY_DOCTOR_GROUPS } from './groups.js';
import type { DoctorPlan, DoctorRemedies } from './plan.js';

const connect = (flags?: string): string => (flags ? `codemie proxy connect ${flags}` : 'codemie proxy connect');

export const BACKEND_REMEDIES: DoctorRemedies = {
  connect,
  disconnect: (flags: string) => `codemie proxy disconnect ${flags}`,
  connectAnalytics: `${connect(CLAUDE_OTLP_FLAG)} (or ${COPILOT_OTLP_FLAG})`,
  start: 'codemie proxy start',
  restart: 'codemie proxy restart',
  reconnect: 'reconnect',
  resumeNote,
};

/** Delivery health of the running daemon, or `null` when it is stopped. */
async function collectStatusDelivery(): Promise<DeliveryHealth | null> {
  const { running, state } = await readDaemonStatus();
  if (!running || !state) {
    return null;
  }
  const health = await checkProxyHealth({ port: state.port, gatewayKey: state.gatewayKey, expectedPid: state.pid });
  return collectDeliveryHealth(state, health.analytics);
}

const NEXT_STEP_OUTCOME: Record<'stop' | 'status', { path: string; outcome?: string }> = {
  stop: { path: 'proxy stop' },
  status: { path: 'proxy status', outcome: 'stopped' },
};

export const backendDoctorPlan: DoctorPlan = {
  remedies: BACKEND_REMEDIES,
  // Loaded on use: the composition's module reads the health-check timeouts on load.
  authSections: async (state, reply, authProbe) =>
    (await import('./compose.js')).authSections(state, reply, authProbe, BACKEND_REMEDIES),
  deliverySections: (state, reply) => deliverySections(state, reply),
  extraSections: async () => [],
  groups: PROXY_DOCTOR_GROUPS,
  daemonLabel: (state: DaemonState) => `profile ${state.profile}`,
  nextSteps: (command) => {
    const { path, outcome } = NEXT_STEP_OUTCOME[command];
    const next = RELATED[path]?.next;
    const step = (outcome !== undefined ? next?.byOutcome?.[outcome] : undefined) ?? next?.default;
    return step ? [step] : [];
  },
  authProbe: (requested) => requested,
  statusLines: (state) => [
    `  Client keys: ${state.gatewayKey}.<client> — written by ${BACKEND_REMEDIES.connect()}`,
    `  Profile: ${state.profile}`,
  ],
  deliveryHealth: async ({ json }) =>
    json
      ? { json: await collectStatusDelivery(), lines: [] }
      : { lines: [renderHint({ reason: 'Delivery health', command: 'codemie proxy doctor' })] },
};
