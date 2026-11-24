/**
 * Privacy redaction for the exported {@link ReportPayload} (`--redact`).
 *
 * The payload is built for local dashboards, so it carries free text and machine-specific
 * paths: the full first user prompt of every session (`title`), the absolute project path
 * (which usually embeds the OS user name), and the absolute path of the native agent log.
 * That is fine on the machine that produced it, but not for a report that is forwarded to a
 * third party (shared folder, BI tool, webhook).
 *
 * Redaction is an allowlist-by-omission over the three leaking fields only; every metric
 * (tokens, cost, turns, tools, models, timings) is left untouched so analytics stay intact.
 * Kept: `userEmail` (attribution) and `branch` (branch names may still hint at a ticket or
 * topic — callers that need stricter handling should filter before exporting).
 *
 * Pure: returns a new payload and never mutates its input.
 */

import type { ReportPayload, ReportSessionRecord } from './types.js';

/** Value substituted for a `--project` filter that may have been a full path. */
export const REDACTED_PROJECT_FILTER = '<redacted>';

/** Last path segment of a POSIX or Windows path, ignoring trailing separators. */
export function projectBasename(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

function redactSession(session: ReportSessionRecord): ReportSessionRecord {
  // `agentSessionFile` is dropped (not blanked) so it stays absent-iff-no-log (`hadLog`).
  const { agentSessionFile: _agentSessionFile, ...rest } = session;
  return {
    ...rest,
    title: '',
    project: projectBasename(session.project),
  };
}

export function redactPayload(payload: ReportPayload): ReportPayload {
  const { projectFilter } = payload.meta;
  return {
    meta: {
      ...payload.meta,
      projectFilter: projectFilter === 'all' ? projectFilter : REDACTED_PROJECT_FILTER,
    },
    sessions: payload.sessions.map(redactSession),
  };
}
