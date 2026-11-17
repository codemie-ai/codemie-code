/**
 * Builds the JSON report `codemie analytics sync` uploads to the configured webhook target.
 *
 * Reuses the same in-process pipeline the interactive `codemie analytics` command uses
 * (`loadAnalytics`) and the same payload shape (`buildPayload`), so the bytes produced here are
 * byte-for-byte identical to what `generateReportJson` would write for the same payload — just
 * built in memory instead of hitting disk, since sync uploads the report rather than saving it.
 */
import { loadAnalytics } from '../analytics-core.js';
import type { AnalyticsSource } from '../sources/types.js';
import { buildPayload } from '../report/payload-builder.js';
import { emailSlug } from '../report/report-generator.js';
import type { SyncReport } from './types.js';
import type { SyncWindow } from './window.js';

export interface BuildSyncReportOptions {
  source: AnalyticsSource;
  window: SyncWindow;
  email: string;
  includeExternal: boolean;
  now: Date;
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Loads, enriches and aggregates sessions for `window`, then builds the same JSON report the
 * interactive `--export json` path writes. Returns `null` when there are no sessions (or the
 * aggregate is empty) for the window — the caller decides how to react (e.g. skip + log).
 */
export async function buildSyncReport(opts: BuildSyncReportOptions): Promise<SyncReport | null> {
  const { source, window, email, includeExternal, now } = opts;

  const loaded = await loadAnalytics(
    source,
    { fromDate: window.from, toDate: window.to },
    includeExternal,
    true
  );

  if (loaded.kind !== 'ok') {
    return null;
  }

  const { analytics, costResult } = loaded;
  const { index: costIndex, summary } = costResult;

  const payload = buildPayload(analytics, costIndex, summary, {
    rangeLabel: window.label,
    projectFilter: 'all',
    generatedAt: now.toISOString(),
    userEmail: email,
    periodStart: window.from.toISOString(),
    periodEnd: window.to.toISOString(),
  });

  // Lowercase is applied here only (sync's attachment name), never in the shared `emailSlug`
  // helper or the interactive export path, so two differently-cased emails for the same
  // developer always produce the same daily attachment name.
  const slug = emailSlug(email.toLowerCase());
  const fileName = `codemie-analytics-${slug}-${formatUtcDate(now)}.report.json`;

  return {
    fileName,
    bytes: Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'),
  };
}
