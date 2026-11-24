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

import { reduceBranch, reducePrompt, reduceRecord } from '@/agents/core/analytics-reduction.js';
import { isReductionOn } from '@/utils/analytics-reduction-setting.js';
import { findNearestConfigDir } from '@/agents/core/event-fields/identity-fields.js';
import type { KeepList } from '@/agents/core/analytics-reduction.js';
import type { ReportPayload, ReportSessionRecord } from './types.js';

/** `redact` is the `--redact` allowlist-by-omission; `reduce` is the prompt-reduction keep-list. `reduce` wins. */
export type ReportPrivacyMode = 'redact' | 'reduce';

/**
 * Session fields kept verbatim in `reduce` mode: ids, type names (agent, tool, skill, command),
 * metrics and per-model figures. `title` and `branch` are reduced explicitly and `agentSessionFile`
 * is dropped; any string field not listed here becomes `REDACTED:<FIELD>`.
 */
export const REPORT_SESSION_KEEP_LIST: KeepList = {
  keep: new Set([
    'sessionId', 'agentName', 'provider', 'project', 'models', 'languages', 'tools',
    'skillInvocations', 'agentInvocations', 'commandInvocations', 'sessionSource', 'tokens',
    'perModelCost', 'costSeries', 'modelTimeline', 'dispatches', 'costSource', 'costBasis',
    'rootOwnTokens', 'unlinkedTokens', 'unlinkedAgentIds', 'usageUnavailableReason',
  ]),
};

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

function reduceSession(session: ReportSessionRecord): ReportSessionRecord {
  const { agentSessionFile: _agentSessionFile, title, branch, ...rest } = session;
  const reduced = reduceRecord({ ...rest, project: projectBasename(session.project) }, REPORT_SESSION_KEEP_LIST);
  return {
    ...(reduced as Omit<ReportSessionRecord, 'title' | 'branch' | 'agentSessionFile'>),
    title: title ? reducePrompt(title) : '',
    branch: branch ? (reduceBranch(branch) ?? '') : '',
  };
}

export function redactPayload(payload: ReportPayload, mode: ReportPrivacyMode): ReportPayload {
  const { projectFilter } = payload.meta;
  return {
    meta: {
      ...payload.meta,
      projectFilter: projectFilter === 'all' ? projectFilter : REDACTED_PROJECT_FILTER,
    },
    sessions: payload.sessions.map(mode === 'reduce' ? reduceSession : redactSession),
  };
}

/**
 * Privacy mode for the local report. Reduction on and not `--unreduced` gives `reduce`; else
 * `--redact` gives `redact`; else `undefined` (unchanged). Read per run, never cached.
 */
export async function resolveReportPrivacyMode(
  options: { redact?: boolean; unreduced?: boolean },
  cwd: string = process.cwd()
): Promise<ReportPrivacyMode | undefined> {
  if (!options.unreduced && (await isReportReductionOn(cwd))) {
    return 'reduce';
  }
  return options.redact ? 'redact' : undefined;
}

/** True when the global or nearest project setting turns prompt reduction on (unreadable counts as on). */
export async function isReportReductionOn(cwd: string = process.cwd()): Promise<boolean> {
  return isReductionOn({ configDirs: [await findNearestConfigDir(cwd)] });
}
