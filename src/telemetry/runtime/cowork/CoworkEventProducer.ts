/**
 * Turns the inner transcript of every Claude Desktop Cowork session into Claude Code plugin events in the proxy's
 * OTLP spool, from where the existing tick and forwarder send them to CLI Analytics.
 *
 * The usage, subagent usage and summary events come from the Claude Code transcript orchestrator, called as the hook
 * path calls it; the session, prompt, tool and subagent events come from {@link buildCoworkEvents}. A session is
 * processed when its files changed since its last processing and were unchanged since the previous run, and ended
 * once its last line is older than the inactivity timeout. Every failure is logged per session and retried at the
 * next run from the cursors, which are saved only after the events are in the spool.
 */

import { existsSync } from 'node:fs';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import {
  getClaudeAnalyticsPreferencesPath,
  isProjectExcluded,
  readClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import {
  openMainTranscriptPass,
  openSessionEndPass,
  openSubagentPass,
  type SubagentFile,
  type TranscriptPass,
} from '@/agents/plugins/claude-code-otlp/transcript/orchestrator.js';
import { findSubagentFiles, readForkedSkillMarker, readSubagentMeta } from '@/agents/plugins/claude-code-otlp/transcript/subagent-usage.js';
import { readNewLines } from '@/agents/plugins/claude-code-otlp/transcript/transcript-reader.js';
import { hooksOnlyForwardAllowed } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.js';
import { appendSpool } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { discoverClaudeDesktopSessions } from '@/telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import { getClaudeDesktopLocalSessionsRoot } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import type { LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import { ConfigLoader } from '@/utils/config.js';
import { AnalyticsSourceError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { isPathWithinDirectory } from '@/utils/paths.js';
import { detectGitRemoteRepo, resolveRepositoryName } from '@/utils/processes.js';
import { coworkCursorPath, emptyCoworkCursor, loadCoworkCursor, saveCoworkCursor, type CoworkCursor } from './cowork-cursor.js';
import { buildCoworkEvents, stampCoworkEvent, type CoworkEnvelope, type CoworkSubagentInput } from './cowork-events.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_DAYS = 7;
/** The backend drops a repeated event only within 14 days. */
const MAX_BACKFILL_DAYS = 14;

/**
 * Days back a Cowork session is read from (`CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS`, read on every call): a missing,
 * unparsable, zero or negative value gives 7, a value above 14 gives 14.
 */
export function desktopAnalyticsBackfillDays(): number {
  const parsed = Number(process.env.CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKFILL_DAYS;
  return Math.min(days, MAX_BACKFILL_DAYS);
}

export interface CoworkEventProducerOptions {
  profile?: string;
  inactivityTimeoutMs: number;
  /** Session discovery of the Desktop runtime; replaced in tests. */
  discover?: (sinceMs: number) => Promise<LocalTelemetryDiscoveredSession[]>;
}

interface CoworkSession {
  discovered: LocalTelemetryDiscoveredSession;
  cliSessionId: string;
  innerTranscript: string;
  subagentsDir: string;
}

/** Size and mtime per file name: the inner transcript first, then the subagent files in name order. */
type Fingerprints = Record<string, string>;

/** The step a session's processing is at, named in its failure warning. */
interface Progress {
  step: string;
}

export class CoworkEventProducer {
  private readonly discover: (sinceMs: number) => Promise<LocalTelemetryDiscoveredSession[]>;
  private sessions: CoworkSession[] = [];
  private refreshedAt?: number;
  /** The fingerprints each session had at the previous run of this process. */
  private readonly previousRun = new Map<string, string>();
  /** Per session, the fingerprints of its last completed processing in this process and that cursor's line and end times. */
  private readonly processed = new Map<string, { key: string; lastLineAt: string; lastEndedAt: string }>();
  /** The last failure warned about per session: the same failure again is not repeated at every run. */
  private readonly lastFailure = new Map<string, string>();
  private readonly otelWarned = new Set<string>();
  private hooksOnlyWarned = false;
  private corruptPreferencesWarned = false;

  constructor(private readonly options: CoworkEventProducerOptions) {
    this.discover = options.discover ?? discoverClaudeDesktopSessions;
  }

  /** One pass over the known Cowork sessions. Never throws: a failure is logged and retried at the next run. */
  async run(now: number): Promise<void> {
    try {
      const preferences = await readClaudeAnalyticsPreferences();
      if (preferences.kind === 'corrupt') {
        if (!this.corruptPreferencesWarned) {
          this.corruptPreferencesWarned = true;
          logger.warn(`[cowork-producer] Cowork sessions are not sent while the preferences file is corrupt: ${getClaudeAnalyticsPreferencesPath()}`);
        }
        return;
      }
      this.corruptPreferencesWarned = false;
      if (!preferences.value.enabled) return;
      if (!hooksOnlyForwardAllowed()) {
        if (!this.hooksOnlyWarned) {
          this.hooksOnlyWarned = true;
          logger.warn('[cowork-producer] Cowork sessions are not sent while OTLP_ALLOW_HOOKS_ONLY_FORWARD is false');
        }
        return;
      }
      if (this.refreshedAt === undefined || now - this.refreshedAt >= this.options.inactivityTimeoutMs) {
        const { sessions, listed } = await this.listSessions(now);
        this.sessions = sessions;
        this.refreshedAt = now;
        // What is remembered about a session goes with it once it left the list.
        for (const remembered of [this.previousRun, this.processed, this.lastFailure, this.otelWarned]) {
          for (const id of [...remembered.keys()]) {
            if (!listed.has(id)) remembered.delete(id);
          }
        }
      }
      for (const session of this.sessions) {
        const progress: Progress = { step: 'exclusion' };
        try {
          if (await isProjectExcluded(session.discovered.workingDirectory, preferences.value.excludedProjects)) continue;
          await this.runSession(session, now, progress);
          this.lastFailure.delete(session.cliSessionId);
        } catch (error) {
          this.warnFailure(session.cliSessionId, progress.step, error);
        }
      }
    } catch (error) {
      logger.warn('[cowork-producer] Run failed; retried at the next run', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private warnFailure(cliSessionId: string, step: string, error: unknown): void {
    const message = `${step}: ${error instanceof Error ? error.message : String(error)}`;
    if (this.lastFailure.get(cliSessionId) === message) return;
    this.lastFailure.set(cliSessionId, message);
    logger.warn('[cowork-producer] Session failed; retried at the next run', { cliSessionId, step, error: message });
  }

  /**
   * The Cowork sessions of the window that have an inner transcript, metadata and transcript both under the local-agent
   * sessions root, minus those Desktop exports OTel for itself;
   * `listed` — the id of every session discovered in the window, kept or not.
   */
  private async listSessions(now: number): Promise<{ sessions: CoworkSession[]; listed: Set<string> }> {
    const root = getClaudeDesktopLocalSessionsRoot();
    const sessions: CoworkSession[] = [];
    const listed = new Set<string>();
    for (const discovered of await this.discover(now - desktopAnalyticsBackfillDays() * DAY_MS)) {
      const cliSessionId = discovered.agentSessionId;
      listed.add(cliSessionId);
      if (!isPathWithinDirectory(root, discovered.metadataPath)) continue;
      if (basename(discovered.transcriptPath) !== 'audit.jsonl' || !isSafeSessionId(cliSessionId)) continue;
      const projectsDir = join(dirname(discovered.transcriptPath), '.claude', 'projects', 'session');
      const innerTranscript = join(projectsDir, `${cliSessionId}.jsonl`);
      if (!existsSync(innerTranscript)) continue;
      try {
        if (await this.exportsOwnOtel(discovered.metadataPath, cliSessionId)) continue;
      } catch (error) {
        this.warnFailure(cliSessionId, 'metadata', error);
        continue;
      }
      sessions.push({ discovered, cliSessionId, innerTranscript, subagentsDir: join(projectsDir, cliSessionId, 'subagents') });
    }
    return { sessions, listed };
  }

  /** Desktop exported its own OTel for the session: its requests would reach the backend twice. */
  private async exportsOwnOtel(metadataPath: string, cliSessionId: string): Promise<boolean> {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as { otelConfig?: unknown };
    if (metadata.otelConfig === undefined || metadata.otelConfig === null) return false;
    if (!this.otelWarned.has(cliSessionId)) {
      this.otelWarned.add(cliSessionId);
      logger.warn('[cowork-producer] Cowork session exports its own OTel; not sent, its requests would be counted twice', { cliSessionId });
    }
    return true;
  }

  private async runSession(session: CoworkSession, now: number, progress: Progress): Promise<void> {
    progress.step = 'fingerprint';
    const fingerprints = await this.fingerprint(session);
    const key = JSON.stringify(fingerprints);
    const previous = this.previousRun.get(session.cliSessionId);
    this.previousRun.set(session.cliSessionId, key);
    // Seen for the first time, or written since the previous run: read once it was quiet for one run.
    if (previous !== key) return;
    // Unchanged since its last processing here, no end due and the cursor still on disk: nothing to read.
    const known = this.processed.get(session.cliSessionId);
    if (known && known.key === key && !this.endDue(known.lastLineAt, known.lastEndedAt, now)
      && existsSync(coworkCursorPath(session.cliSessionId))) {
      return;
    }

    progress.step = 'cursor';
    let cursor = await loadCoworkCursor(session.cliSessionId);
    if (!cursor || JSON.stringify(cursor.fingerprints) !== key) {
      cursor = await this.process(session, cursor, now, fingerprints, false, progress);
    }
    if (this.endDue(cursor.events.lastLineAt, cursor.lastEndedAt, now)) {
      cursor = await this.process(session, cursor, now, fingerprints, true, progress);
    }
    this.processed.set(session.cliSessionId, { key, lastLineAt: cursor.events.lastLineAt, lastEndedAt: cursor.lastEndedAt });
  }

  /** The last line is older than the inactivity timeout and no end was recorded for it. */
  private endDue(lastLineAt: string, lastEndedAt: string, now: number): boolean {
    return lastLineAt !== '' && lastEndedAt !== lastLineAt && now - Date.parse(lastLineAt) >= this.options.inactivityTimeoutMs;
  }

  private async fingerprint(session: CoworkSession): Promise<Fingerprints> {
    const fingerprints: Fingerprints = { [basename(session.innerTranscript)]: await fileFingerprint(session.innerTranscript) };
    for (const name of await subagentFileNames(session.subagentsDir)) {
      fingerprints[name] = await fileFingerprint(join(session.subagentsDir, name));
    }
    return fingerprints;
  }

  /**
   * One processing of a session (`end`: its end): the orchestrator's passes one at a time, each appended and
   * finalized before the next opens, then the producer's own events in one append, then the cursor.
   */
  private async process(
    session: CoworkSession,
    cursor: CoworkCursor | null,
    now: number,
    fingerprints: Fingerprints,
    end: boolean,
    progress: Progress
  ): Promise<CoworkCursor> {
    const { cliSessionId, innerTranscript, discovered } = session;
    const mainName = basename(innerTranscript);
    const prior = cursor ?? emptyCoworkCursor();
    const next = structuredClone(prior);

    progress.step = 'read';
    const main = await readNewLines(innerTranscript, prior.offsets[mainName] ?? 0);
    next.offsets[mainName] = main.nextOffset;
    const subagentNames = Object.keys(fingerprints).filter((fileName) => fileName !== mainName);
    const files = await subagentFiles(
      innerTranscript,
      subagentNames.map((name) => join(session.subagentsDir, name)),
      discovered.workingDirectory
    );
    const subagents: Array<CoworkSubagentInput & { file: SubagentFile; name: string }> = [];
    for (const [index, name] of subagentNames.entries()) {
      const file = files[index];
      const read = await readNewLines(file.filePath, prior.offsets[name] ?? 0);
      next.offsets[name] = read.nextOffset;
      subagents.push({ ...file, lines: read.lines, file, name });
    }
    const own = buildCoworkEvents({
      sessionId: cliSessionId,
      main: main.lines,
      subagents,
      windowStartMs: cursor ? Number.NEGATIVE_INFINITY : now - desktopAnalyticsBackfillDays() * DAY_MS,
      end,
    }, next.events);
    // A transcript without a single line yet has nothing to report, not even an empty summary: nothing is consumed.
    if (!next.events.lastLineAt) {
      progress.step = 'cursor-save';
      const unread = { ...prior, fingerprints };
      await saveCoworkCursor(cliSessionId, unread);
      return unread;
    }
    next.fingerprints = fingerprints;

    progress.step = 'context';
    const envelope = await this.envelope(discovered, cliSessionId, next);
    const project = envelope.project ? [envelope.project] : undefined;
    if (end) {
      progress.step = 'session-end-pass';
      await appendPass(await openSessionEndPass(cliSessionId, innerTranscript, discovered.workingDirectory), envelope, next, project);
    } else {
      if (prior.fingerprints[mainName] !== fingerprints[mainName]) {
        progress.step = 'main-pass';
        await appendPass(await openMainTranscriptPass(cliSessionId, innerTranscript, 'Stop'), envelope, next, project);
      }
      for (const subagent of subagents) {
        if (prior.fingerprints[subagent.name] === fingerprints[subagent.name]) continue;
        progress.step = 'subagent-pass';
        await appendPass(await openSubagentPass(cliSessionId, subagent.file), envelope, next, project);
      }
    }
    progress.step = end ? 'session-end-events' : 'events';
    if (own.length > 0) {
      await appendSpool(cliSessionId, 'hooks', spoolLines(own.map((event) => stampCoworkEvent(event, envelope, next.events.lastLineAt))), project);
    }
    if (end) next.lastEndedAt = next.events.lastLineAt;
    progress.step = 'cursor-save';
    await saveCoworkCursor(cliSessionId, next);
    return next;
  }

  private async envelope(discovered: LocalTelemetryDiscoveredSession, cliSessionId: string, cursor: CoworkCursor): Promise<CoworkEnvelope> {
    const workingDirectory = discovered.workingDirectory;
    const profile = this.options.profile;
    const [project, repository, repoRemote, cliVersion] = await Promise.all([
      ConfigLoader.load(workingDirectory, profile ? { name: profile } : undefined)
        .then((config) => config.codeMieProject ?? ''),
      resolveRepositoryName(workingDirectory),
      detectGitRemoteRepo(workingDirectory),
      getCurrentCliVersion().catch(() => null),
    ]);
    return {
      sessionId: cliSessionId,
      project,
      repository,
      repoRemote,
      cliVersion: cliVersion ?? '',
      title: discovered.title,
      entrypoint: cursor.events.entrypoint,
      clientVersion: cursor.events.clientVersion,
    };
  }
}

/**
 * Appends one orchestrator pass and finalizes it: with `true` once its events are in the spool (or it has none), with
 * `false` when the append failed, so the orchestrator derives the same lines again; the failure is then rethrown.
 */
async function appendPass(pass: TranscriptPass, envelope: CoworkEnvelope, cursor: CoworkCursor, project?: string[]): Promise<void> {
  if (pass.events.length === 0) {
    await pass.finalize(true);
    return;
  }
  try {
    const events = pass.events.map((event) => stampCoworkEvent(event, envelope, cursor.events.lastLineAt));
    await appendSpool(envelope.sessionId, 'hooks', spoolLines(events), project);
  } catch (error) {
    await pass.finalize(false);
    throw error;
  }
  await pass.finalize(true);
}

function spoolLines(events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify({ agentName: CLAUDE_CODE_OTLP_AGENT_NAME, hookEvent: JSON.stringify(event) }) + '\n').join('');
}

/** `size:mtime` of a readable regular file; throws for anything else, so a broken session is reported. */
async function fileFingerprint(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new AnalyticsSourceError(`not a regular file: ${basename(path)}`);
  await access(path, constants.R_OK);
  return `${info.size}:${info.mtimeMs}`;
}

async function subagentFileNames(subagentsDir: string): Promise<string[]> {
  try {
    return (await readdir(subagentsDir)).filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The subagents as the `SubagentStop` hook path builds them, with the session's working directory as `cwd`, in the
 * order of `filePaths`. A file with a forked-skill marker is named by it; the others are resolved together, in one
 * resolution over the transcripts.
 */
async function subagentFiles(mainTranscript: string, filePaths: string[], cwd: string): Promise<SubagentFile[]> {
  const candidates = await Promise.all(filePaths.map(async (filePath) => {
    const [meta, marker] = await Promise.all([readSubagentMeta(filePath), readForkedSkillMarker(filePath)]);
    const file: SubagentFile = {
      agentId: basename(filePath).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      filePath,
      toolUseId: meta.toolUseId,
      agentType: meta.agentType,
      spawnDepth: meta.spawnDepth,
      description: meta.description,
      cwd,
    };
    return { file, markerSkill: marker.skillName };
  }));
  const unmarked = candidates.filter((candidate) => !candidate.markerSkill).map((candidate) => candidate.file);
  const resolved = unmarked.length > 0
    ? new Map((await findSubagentFiles(mainTranscript, { extra: unmarked })).map((found) => [found.agentId, found]))
    : new Map<string, SubagentFile>();
  return candidates.map(({ file, markerSkill }) => {
    const found = resolved.get(file.agentId);
    // Not found by the resolution: unproven, so still possibly a skill fork.
    const { skillName, pending } = markerSkill
      ? { skillName: markerSkill, pending: false }
      : { skillName: found?.skillName ?? '', pending: found ? found.pending === true : true };
    return {
      ...file,
      description: file.description || (skillName ? `/${skillName}` : undefined),
      skillName: skillName || undefined,
      pending: pending || undefined,
    };
  });
}
