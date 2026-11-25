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
import { existsSync } from 'node:fs';
import { isReductionOn, readOptedInProjects } from '@/utils/analytics-reduction-setting.js';
import { findAllConfigDirs } from '@/agents/core/event-fields/identity-fields.js';
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

export function redactSession(session: ReportSessionRecord): ReportSessionRecord {
  // `agentSessionFile` is dropped (not blanked) so it stays absent-iff-no-log (`hadLog`).
  const { agentSessionFile: _agentSessionFile, ...rest } = session;
  return {
    ...rest,
    title: '',
    project: projectBasename(session.project),
  };
}

export function reduceSession(session: ReportSessionRecord): ReportSessionRecord {
  const { agentSessionFile: _agentSessionFile, title, branch, ...rest } = session;
  const reduced = reduceRecord({ ...rest, project: projectBasename(session.project) }, REPORT_SESSION_KEEP_LIST);
  return {
    ...(reduced as Omit<ReportSessionRecord, 'title' | 'branch' | 'agentSessionFile'>),
    title: title ? reducePrompt(title) : '',
    branch: branch ? (reduceBranch(branch) ?? '') : '',
  };
}

/**
 * Privacy mode for the local report. Reduction on and not `--unreduced` gives `reduce`; else
 * `--redact` gives `redact`; else `undefined` (unchanged). Read per run, never cached.
 */
/**
 * Applies the privacy mode per session: the global setting is the floor, and a session's own project config
 * (nearest to the session's project directory) can turn reduction on for it. `unreduced` skips reduction only.
 * Sync and export span projects, so the current directory must not decide for every session.
 */
export async function redactPayloadPerSession(
  payload: ReportPayload,
  options: { redact?: boolean; unreduced?: boolean }
): Promise<ReportPayload> {
  const decisions = new Map<string, boolean>();
  const modes: Array<ReportPrivacyMode | undefined> = [];
  for (const session of payload.sessions) {
    let on = false;
    if (!options.unreduced) {
      const key = session.project;
      if (!decisions.has(key)) {
        decisions.set(key, await isReportReductionOn(key || process.cwd()));
      }
      on = decisions.get(key) === true;
    }
    modes.push(on ? 'reduce' : options.redact ? 'redact' : undefined);
  }
  if (modes.every((mode) => mode === undefined)) {
    return payload;
  }
  const sessions = payload.sessions.map((session, index) => {
    const mode = modes[index];
    return mode === 'reduce' ? reduceSession(session) : mode === 'redact' ? redactSession(session) : session;
  });
  const { projectFilter } = payload.meta;
  return {
    meta: { ...payload.meta, projectFilter: projectFilter === 'all' ? projectFilter : REDACTED_PROJECT_FILTER },
    sessions,
  };
}

export async function resolveReportPrivacyMode(
  options: { redact?: boolean; unreduced?: boolean },
  cwd: string = process.cwd()
): Promise<ReportPrivacyMode | undefined> {
  // The console report mixes every project's sessions, so the current directory alone must not decide: it is
  // reduced when this directory's project is on, or when any project on this machine opted in (fail closed).
  if (!options.unreduced && ((await isReportReductionOn(cwd)) || (await anyProjectOptedIn()))) {
    return 'reduce';
  }
  return options.redact ? 'redact' : undefined;
}

/** Whether any project opted in; an unreadable list counts as yes. */
async function anyProjectOptedIn(): Promise<boolean> {
  const projects = await readOptedInProjects();
  return projects === 'unreadable' || projects.length > 0;
}

export async function isReportReductionOn(cwd: string = process.cwd()): Promise<boolean> {
  // A session whose project directory is gone (moved or deleted) has no config to read: it is reduced when any
  // project opted in, never sent unreduced by default.
  if (!existsSync(cwd)) {
    return (await isReductionOn({ configDirs: [] })) || (await anyProjectOptedIn());
  }
  let configDirs = [cwd];
  try {
    configDirs = await findAllConfigDirs(cwd);
  } catch {
    // an unreadable directory falls back to the start directory; the global flag still applies
  }
  return isReductionOn({ configDirs });
}
