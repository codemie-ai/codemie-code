/**
 * Programmatic, side-effect-free session-scoped analytics report generator.
 * Composes the same building blocks the `analytics --report --report-format json`
 * CLI path uses, but prints nothing and never calls process.exit — safe to invoke
 * from agent session finalization. Failures propagate to the caller (who logs them).
 */

import { join } from 'node:path';
import { SessionsSource } from '../sources/sessions-source.js';
import { enrichCosts } from '../cost/cost-enricher.js';
import { AnalyticsAggregator } from '../aggregator.js';
import { buildPayload } from './payload-builder.js';
import { generateReportJson, writeReportWithFallback } from './report-generator.js';

export interface SessionReportOptions {
  /** Session id to scope the report to. */
  sessionId: string;
  /** Absolute or cwd-relative output path for the JSON report. Defaults to `docs/codemie/analytics/codemie-analytics-[email-]<sessionId>.json` relative to cwd. */
  outputPath?: string;
  /** Include native agent-log discovery (default true). */
  scanNative?: boolean;
  /** User email to embed in report metadata and default filename. */
  userEmail?: string;
}

export interface SessionReportResult {
  /** Path written, or null when the session had no analytics data. */
  written: string | null;
  /** Number of sessions included in the payload. */
  sessions: number;
}

export async function generateSessionReport(options: SessionReportOptions): Promise<SessionReportResult> {
  const scanNative = options.scanNative ?? true;
  const { rawSessions } = await new SessionsSource().load({
    filter: { sessionId: options.sessionId },
    scanNative,
  });
  if (rawSessions.length === 0) {
    return { written: null, sessions: 0 };
  }

  const { index, summary } = await enrichCosts(rawSessions);
  const keepSessionIds = new Set(
    [...index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
  );
  const analytics = AnalyticsAggregator.aggregate(rawSessions, true, keepSessionIds);
  if (analytics.totalSessions === 0) {
    return { written: null, sessions: 0 };
  }

  const session = rawSessions[0];
  const periodStart = session.startEvent?.data.startTime
    ? new Date(session.startEvent.data.startTime).toISOString()
    : undefined;
  const periodEnd = session.endEvent?.data.endTime
    ? new Date(session.endEvent.data.endTime).toISOString()
    : undefined;

  const payload = buildPayload(analytics, index, summary, {
    rangeLabel: 'all',
    projectFilter: 'all',
    generatedAt: new Date().toISOString(),
    ...(options.userEmail !== undefined && { userEmail: options.userEmail }),
    ...(periodStart !== undefined && { periodStart }),
    ...(periodEnd !== undefined && { periodEnd }),
  });

  const emailSlug = options.userEmail
    ? options.userEmail.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-'
    : '';
  const outputPath =
    options.outputPath ??
    join(process.cwd(), 'docs', 'codemie', 'analytics', `codemie-analytics-${emailSlug}${options.sessionId}.json`);

  // Explicit path ⇒ no home/tmp fallback; a write error propagates to the caller.
  const result = writeReportWithFallback((p) => generateReportJson(payload, p), outputPath, false);
  return { written: result.path, sessions: payload.meta.totals.sessions };
}
