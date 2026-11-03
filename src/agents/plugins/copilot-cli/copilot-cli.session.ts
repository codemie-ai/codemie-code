/**
 * Copilot CLI Session Adapter.
 *
 * Sessions live at `~/.copilot/session-state/<uuid>/` (or `$COPILOT_HOME/...`), one
 * directory per session, each holding a `workspace.yaml` manifest and — from the
 * schema-bearing CLI versions — an `events.jsonl` transcript.
 *
 * Discovery reads only the manifest; transcripts are opened during parse, so a report run
 * never pays to read a transcript it goes on to filter out.
 *
 * Modeled on `CodexSessionAdapter` (`src/agents/plugins/codex/codex.session.ts`), the
 * closest analog — a natively-discovered JSONL agent. Discovery here is simpler: Codex
 * walks `YYYY/MM/DD` directories and stats mtimes, whereas Copilot's flat layout plus the
 * manifest's own timestamps make both unnecessary.
 */

import { readdirSync, existsSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import {
  latestRecordTime,
  type SessionAdapter,
  type ParsedSession,
  type AggregatedResult,
  type SessionDiscoveryOptions,
  type SessionDescriptor,
  type RunBounds,
} from '../../core/session/BaseSessionAdapter.js';
import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import type { Session } from '../../core/session/types.js';
import { getCopilotSessionStateRoot } from './copilot-cli.paths.js';
import { readWorkspaceManifest } from './copilot-cli.workspace.js';
import { COPILOT_CLI_AGENT_NAME, FULL_SESSION_UUID } from './copilot-cli.constants.js';
import { readCopilotEventsTolerant } from './copilot-cli.storage-utils.js';
import {
  extractCopilotUsage,
  extractCopilotRunUsage,
  inRun,
  runShutdownShare,
} from './copilot-cli.usage.js';
import { applyShutdownShare, callFileOperations, directoryCursor, type ToolCall } from './copilot-cli.file-operations.js';
import type {
  CopilotSessionStartData,
  CopilotShutdownData,
  CopilotToolStartData,
  CopilotToolCompleteData,
  CopilotSkillInvokedData,
  CopilotAssistantMessageData,
} from './copilot-cli-event-types.js';
import { CopilotCliMetricsProcessor } from './session/processors/copilot-cli.metrics-processor.js';
import { CopilotCliConversationsProcessor } from './session/processors/copilot-cli.conversations-processor.js';
import { resolveRunWindow } from '../../core/session/run-window.js';
import type { RunWindow } from '../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js';
import { SessionRecordNotFoundError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The whole transcript, for a caller that names no run (a report over the native session). */
const WHOLE_SESSION: RunBounds = { startTime: -Infinity };

/** Trailing-slash-insensitive directory comparison. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** The record's run window; none without a record — the metrics processor reports it, no conversation is queued. */
async function recordRunWindow(sessionId: string, context: ProcessingContext): Promise<RunWindow | undefined> {
  try {
    return await resolveRunWindow(sessionId, context);
  } catch (error) {
    if (error instanceof SessionRecordNotFoundError) return undefined;
    throw error;
  }
}

const SESSION_ID_SHAPE = '00000000-0000-0000-0000-000000000000';

/**
 * A `--resume` value that is a strict prefix of a session id (hex digits and dashes in the id's shape), lower-cased.
 * A hex-shaped session name is read as a prefix too: it narrows the lookup only while that locates something,
 * else the session is found by the window like any name.
 */
function resumedIdPrefix(resumed: string | undefined): string | undefined {
  const value = resumed?.trim().toLowerCase();
  if (!value || FULL_SESSION_UUID.test(value)) return undefined;
  return SESSION_ID_SHAPE.startsWith(value.replace(/[0-9a-f]/g, '0')) ? value : undefined;
}

/** Every session directory name under the root; none when the root cannot be read. */
function sessionDirNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The transcript whose latest `session.start` / `session.resume` in [from, until) ran in `runCwd`. */
function latestStartInWindow(paths: string[], from: number, until: number | undefined, runCwd: string): string | undefined {
  let best: { path: string; at: number } | undefined;
  for (const path of paths) {
    try {
      if (statSync(path).mtimeMs < from) continue;
    } catch {
      continue;
    }
    for (const event of readCopilotEventsTolerant(path)) {
      if (event.type !== 'session.start' && event.type !== 'session.resume') continue;
      const at = Date.parse(event.timestamp ?? '');
      const cwd = (event.data as CopilotSessionStartData | undefined)?.context?.cwd;
      if (!Number.isFinite(at) || at < from || (until !== undefined && at >= until)) continue;
      if (!cwd || realpathOrSelf(cwd) !== runCwd) continue;
      if (!best || at > best.at) best = { path, at };
    }
  }
  return best?.path;
}

export class CopilotCliSessionAdapter implements SessionAdapter {
  readonly agentName = COPILOT_CLI_AGENT_NAME;
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.registerProcessor(new CopilotCliMetricsProcessor());
    this.registerProcessor(new CopilotCliConversationsProcessor());
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(
      `[copilot-cli-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`
    );
  }

  /**
   * Enumerate `session-state/<uuid>/` directories that carry a transcript, newest first.
   *
   * Directories without `events.jsonl` are pre-schema sessions with nothing to parse or
   * price, and are skipped rather than surfaced as empty rows.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const root = getCopilotSessionStateRoot();
    if (!existsSync(root)) {
      logger.debug(`[copilot-cli-discovery] no session-state directory at ${root}`);
      return [];
    }

    let dirNames: string[];
    try {
      dirNames = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      logger.debug('[copilot-cli-discovery] failed to read session-state:', error);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;

    const results: SessionDescriptor[] = [];

    for (const name of dirNames) {
      const dir = join(root, name);
      const eventsPath = join(dir, 'events.jsonl');
      if (!existsSync(eventsPath)) {
        continue;
      }

      const manifest = readWorkspaceManifest(dir);
      if (!manifest) {
        continue;
      }

      const { createdAt } = manifest;
      if (createdAt === undefined) {
        if (!options?.includeTimestampless) {
          continue;
        }
      } else if (createdAt < cutoffMs) {
        continue;
      }

      const projectPath = manifest.cwd ?? manifest.gitRoot;
      if (options?.cwd && !sameDir(projectPath, options.cwd)) {
        continue;
      }

      results.push({
        sessionId: manifest.id,
        filePath: eventsPath,
        projectPath,
        createdAt: createdAt ?? 0,
        updatedAt: manifest.updatedAt,
        agentName: this.agentName,
      });
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (options?.limit && options.limit > 0) {
      logger.debug(
        `[copilot-cli-discovery] found ${results.length} session(s), returning ${options.limit}`
      );
      return results.slice(0, options.limit);
    }

    logger.debug(`[copilot-cli-discovery] found ${results.length} session(s)`);
    return results;
  }

  /**
   * Read `events.jsonl` into the unified `ParsedSession`.
   *
   * `messages` carries the RAW per-model Copilot buckets — `readCopilotCli` in
   * `usage-readers.ts` owns the conversion into `TokenUsage`, so the OpenAI/Anthropic
   * convention mismatch lives in exactly one place.
   *
   * With `run`, the usage and the session-level counters (tools, prompts, skills, file operations)
   * are the run's own: one native session is shared by every run that resumed it. The turn records
   * stay whole — the conversation is numbered over the full session.
   */
  async parseSessionFile(filePath: string, sessionId: string, _agentSessionId?: string, run?: RunBounds): Promise<ParsedSession> {
    const events = readCopilotEventsTolerant(filePath);

    const start = events.find((e) => e.type === 'session.start')?.data as
      | CopilotSessionStartData
      | undefined;
    const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown')?.data as
      | CopilotShutdownData
      | undefined;

    const bounds = run ?? WHOLE_SESSION;
    const usage = run ? extractCopilotRunUsage(events, run) : extractCopilotUsage(events);

    const tools: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const skillInvocations: Record<string, number> = {};
    const userPrompts: Array<{ count: number; text: string }> = [];
    const fileOperations: NonNullable<ParsedSession['metrics']>['fileOperations'] = [];

    const context = start?.context;
    const cwd = context?.cwd ?? context?.gitRoot;
    const branch = context?.branch;

    // Per-turn records in the Claude-shaped form `synthesizeRawSession` understands, so
    // native synthesis derives turns, models, timestamps, cwd and branch correctly. These
    // carry no `usage`, so `readCopilotCli` skips them; the per-model usage rows appended
    // afterwards carry no `type`, so turn counting skips those. Orthogonal filters.
    const turnRecords: unknown[] = [];

    // tool.execution_start is the ONLY event carrying the tool name and arguments;
    // tool.execution_complete carries just toolCallId + a boolean success. Pair by id.
    const toolCallById = new Map<string, ToolCall>();
    const callDirectory = directoryCursor(events);

    // Only the newest CLI builds put `model` on each assistant.message; 1.0.17 and every
    // 0.0.x omit it. Track the model in effect from session.model_change so those turns
    // are still attributed, and remember which turns stayed unlabelled for the
    // single-model backfill below.
    let currentModel: string | undefined;
    const unlabelledTurns: Array<{ message: { model?: string } }> = [];

    for (const event of events) {
      switch (event.type) {
        case 'tool.execution_start': {
          const data = (event.data ?? {}) as CopilotToolStartData;
          if (!data.toolCallId || !data.toolName) {
            break;
          }
          // Remember the name and target path; whether the write actually happened is
          // only known at tool.execution_complete.
          const args = data.arguments;
          toolCallById.set(data.toolCallId, typeof args === 'string'
            ? { name: data.toolName, patch: args }
            : { name: data.toolName, path: args?.path });
          break;
        }
        case 'tool.execution_complete': {
          const data = (event.data ?? {}) as CopilotToolCompleteData;
          const call = data.toolCallId ? toolCallById.get(data.toolCallId) : undefined;
          if (!call || !inRun(event, bounds)) {
            break; // orphaned completion (truncated transcript), or another run's call
          }
          tools[call.name] = (tools[call.name] ?? 0) + 1;
          const bucket = toolStatus[call.name] ?? { success: 0, failure: 0 };
          const failed = data.success === false || data.error !== undefined;
          bucket[failed ? 'failure' : 'success'] += 1;
          toolStatus[call.name] = bucket;

          // Record the file operation only once the write is known to have SUCCEEDED.
          // A failed edit/create (permission denied, bad old_str) must not count as a
          // changed file, or the report inflates filesChanged and can attach the
          // session's line totals to a file that was never written.
          if (!failed) {
            fileOperations.push(...callFileOperations(call, data, callDirectory(event)));
          }
          break;
        }
        case 'skill.invoked': {
          const data = (event.data ?? {}) as CopilotSkillInvokedData;
          const name = data.skill ?? data.name;
          if (name && inRun(event, bounds)) {
            skillInvocations[name] = (skillInvocations[name] ?? 0) + 1;
          }
          break;
        }
        case 'user.message': {
          const data = (event.data as { text?: string; content?: string } | undefined) ?? {};
          const text = typeof data.text === 'string' && data.text.trim()
            ? data.text
            : typeof data.content === 'string'
              ? data.content
              : undefined;
          if (typeof text === 'string' && text.trim() && inRun(event, bounds)) {
            userPrompts.push({ count: 1, text });
          }
          turnRecords.push({
            type: 'user',
            timestamp: event.timestamp,
            cwd,
            gitBranch: branch,
            message: { role: 'user', content: typeof text === 'string' ? text : '' },
          });
          break;
        }
        case 'session.model_change': {
          const next = (event.data as { newModel?: string } | undefined)?.newModel;
          if (next) {
            currentModel = next;
          }
          break;
        }
        case 'assistant.message': {
          const data = (event.data ?? {}) as CopilotAssistantMessageData;
          const record = {
            type: 'assistant',
            timestamp: event.timestamp,
            cwd,
            gitBranch: branch,
            message: {
              role: 'assistant',
              model: data.model ?? currentModel,
              content: typeof (data as { content?: string }).content === 'string'
                ? (data as { content?: string }).content
                : '',
              toolRequests: Array.isArray(data.toolRequests) ? data.toolRequests : [],
            },
          };
          if (!record.message.model) {
            unlabelledTurns.push(record);
          }
          turnRecords.push(record);
          break;
        }
        default:
          break;
      }
    }

    // Last resort: if turns are still unlabelled but the shutdown rollup shows the session
    // used exactly ONE model, every turn must have been that model. With two or more,
    // attributing an unlabelled turn to either would be a fabrication — leave it unknown.
    if (unlabelledTurns.length > 0) {
      const usedModels = Object.keys(shutdown?.modelMetrics ?? {});
      if (usedModels.length === 1) {
        for (const turn of unlabelledTurns) {
          turn.message.model = usedModels[0];
        }
      }
    }

    // session.shutdown.codeChanges is cumulative over the copilot session and session-wide: the
    // run's share fills in what the calls themselves did not record.
    applyShutdownShare(fileOperations, runShutdownShare(events, bounds));

    return {
      sessionId,
      agentName: this.metadata.displayName,
      agentVersion: start?.copilotVersion,
      metadata: {
        projectPath: cwd,
        createdAt: start?.startTime,
        repository: context?.repository,
        branch,
        gitBranch: branch,
      },
      messages: [...turnRecords, ...usage.messages],
      recordTimes: events.map((event) => event.timestamp),
      usageMeta: {
        premiumRequests: usage.premiumRequests,
        usagePartial: usage.partial,
        usageUnavailableReason: usage.unavailableReason,
      },
      metrics: {
        tools,
        toolStatus,
        fileOperations,
        skillInvocations,
        userPrompts,
      },
    };
  }

  /**
   * The `events.jsonl` of a record that names none: a pinned run's (native id = the CodeMie id),
   * a `--resume <id>` run's (its stored native id), else the session started or resumed in the
   * run's window (its start → the start of the next copilot record in the same directory) in the
   * run's directory — the latest such event wins. A `--resume <id prefix>` run searches the sessions
   * whose id starts with the prefix first, all of them when those locate none; `--continue` and a
   * session name are matched by the window alone.
   *
   * ponytail: two runs selecting a session in one directory at once are indistinguishable
   */
  async locateTranscript(record: Session): Promise<string[]> {
    const root = getCopilotSessionStateRoot();
    const eventsOf = (id: string) => join(root, id, 'events.jsonl');

    if (existsSync(eventsOf(record.sessionId))) {
      return [eventsOf(record.sessionId)];
    }
    const resumedId = record.correlation?.agentSessionId;
    if (resumedId && resumedId !== 'unknown' && !/[\\/]/.test(resumedId) && existsSync(eventsOf(resumedId))) {
      return [eventsOf(resumedId)];
    }

    const dirNames = sessionDirNames(root);
    const prefix = resumedIdPrefix(record.resumeSessionId);
    const runCwd = realpathOrSelf(record.workingDirectory);
    const { nextRecordStartInDirectory } = await import('../../core/session/next-record-start.js');
    const until = await nextRecordStartInDirectory(record);
    const locate = (names: string[]) => latestStartInWindow(names.map(eventsOf), record.startTime, until, runCwd);
    const byPrefix = prefix ? dirNames.filter((name) => name.toLowerCase().startsWith(prefix)) : [];
    const located = (byPrefix.length > 0 ? locate(byPrefix) : undefined) ?? locate(dirNames);
    return located ? [located] : [];
  }

  /** Resolve and parse the record's run window once, then run every registered processor in priority order. */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    const runWindow = await recordRunWindow(sessionId, context);
    const parsed = { ...(await this.parseSessionFile(filePath, sessionId, undefined, runWindow)), runWindow };

    const processors: AggregatedResult['processors'] = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      // With no record no window bounds the run's turns: every turn of the native session would be queued
      if (!processor.shouldProcess(parsed) || (!runWindow && processor instanceof CopilotCliConversationsProcessor)) {
        continue;
      }
      try {
        const result: ProcessingResult = await processor.process(parsed, context);
        const recordsProcessed = result.metadata?.recordsProcessed ?? 0;
        totalRecords += recordsProcessed;
        processors[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed,
        };
        if (!result.success) {
          failedProcessors.push(processor.name);
        }
      } catch (error) {
        logger.error(`[copilot-cli-adapter] Processor ${processor.name} failed:`, error);
        processors[processor.name] = {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
        failedProcessors.push(processor.name);
      }
    }

    return {
      success: failedProcessors.length === 0,
      processors,
      totalRecords,
      failedProcessors,
      lastRecordAt: latestRecordTime(parsed.recordTimes, context.recordsBeforeMs),
    };
  }
}
