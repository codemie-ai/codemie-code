/**
 * Programmatic, side-effect-free session-scoped analytics report generator.
 * Composes the same building blocks the `analytics --report --report-format json`
 * CLI path uses, but prints nothing and never calls process.exit — safe to invoke
 * from agent session finalization. Failures propagate to the caller (who logs them).
 */

import { SessionsSource } from '../sources/sessions-source.js';
import { enrichCosts } from '../cost/cost-enricher.js';
import { AnalyticsAggregator } from '../aggregator.js';
import { buildPayload } from './payload-builder.js';
import { generateReportJson, writeReportWithFallback } from './report-generator.js';

export interface SessionReportOptions {
  /** Session id to scope the report to. */
  sessionId: string;
  /** Absolute or cwd-relative output path for the JSON report. */
  outputPath: string;
  /** Include native agent-log discovery (default true). */
  scanNative?: boolean;
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
  const payload = buildPayload(analytics, index, summary, {
    rangeLabel: 'all',
    projectFilter: 'all',
    generatedAt: new Date().toISOString(),
  });

  // Explicit path ⇒ no home/tmp fallback; a write error propagates to the caller.
  const result = writeReportWithFallback((p) => generateReportJson(payload, p), options.outputPath, false);
  return { written: result.path, sessions: payload.meta.totals.sessions };
}
