/**
 * The collection of a machine with a CodeMie backend: hooks spool through the proxy daemon, which sends to CodeMie;
 * the daily sync delivers the JSON report.
 */
import { BackendPolicy } from '@/agents/core/collection-policy.js';
import { ReportSource } from '../../analytics/sync/report-builder.js';
import { backendDoctorPlan } from '../../proxy/doctor/backend-plan.js';
import { ensureOtlpProxy } from '../../proxy/otlp-cold-start.js';
import { restartProxy } from '../../proxy/restart.js';
import { startProxy } from '../../proxy/start.js';
import type { AnalyticsCollection } from './types.js';

/**
 * The backend mode's collection: hooks under `BackendPolicy`, the OTLP proxy as the launcher, the report as the
 * export source, no install steps and no removal of its own, and the proxy's own doctor, start and restart.
 */
export function backendCollection(): AnalyticsCollection {
  return {
    hookPolicy: () => new BackendPolicy(),
    launcher: ensureOtlpProxy,
    exportSource: () => new ReportSource(),
    install: {
      steps: () => [],
      settingsExtras: () => ({}),
      conclude: () => ({ summary: [] }),
    },
    teardown: async (removeInstall) => {
      await removeInstall();
      return false;
    },
    statusLines: () => [],
    doctor: backendDoctorPlan,
    guardProxyCommand: () => undefined,
    daemon: { start: startProxy, restart: restartProxy },
  };
}
