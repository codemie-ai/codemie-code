/**
 * The display groups of `proxy doctor` (story AC10): one heading per group, in this order. Each group holds the
 * section ids rendered under it; every group but `details` always has at least one section (`compose.ts`).
 */
import type { ProxyDoctorSectionId } from './compose.js';

export interface ProxyDoctorGroup {
  title: string;
  ids: readonly ProxyDoctorSectionId[];
}

export const PROXY_DOCTOR_GROUPS: readonly ProxyDoctorGroup[] = [
  { title: 'Daemon', ids: ['daemon'] },
  { title: 'Authentication and upstream', ids: ['auth', 'upstream'] },
  { title: 'Clients', ids: ['clients'] },
  { title: 'Analytics connectors', ids: ['connectors', 'claude-code-otlp'] },
  { title: 'Analytics delivery', ids: ['delivery'] },
  { title: 'Claude Desktop collection', ids: ['desktop'] },
  { title: 'Environment', ids: ['cli-path'] },
  { title: 'Details', ids: ['verbose'] },
];
