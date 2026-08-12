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

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  SessionAdapter,
  ParsedSession,
  AggregatedResult,
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/BaseSessionAdapter.js';
import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { getCopilotSessionStateRoot } from './copilot-cli.paths.js';
import { readWorkspaceManifest } from './copilot-cli.workspace.js';
import { COPILOT_CLI_AGENT_NAME } from './copilot-cli.constants.js';
import { readCopilotEventsTolerant } from './copilot-cli.storage-utils.js';
import { extractCopilotUsage } from './copilot-cli.usage.js';
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
import { logger } from '../../../utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Copilot tools that write to disk. `view` also carries a `path` but is a read, and the
 * aggregator excludes reads from the changed-files metrics.
 */
const FILE_WRITE_TOOLS = new Set(['create', 'edit']);

/** Trailing-slash-insensitive directory comparison. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
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
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    const events = readCopilotEventsTolerant(filePath);

    const start = events.find((e) => e.type === 'session.start')?.data as
      | CopilotSessionStartData
      | undefined;
    const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown')?.data as
      | CopilotShutdownData
      | undefined;

    const usage = extractCopilotUsage(events);

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
    const toolCallById = new Map<string, { name: string; path?: string }>();

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
          toolCallById.set(data.toolCallId, { name: data.toolName, path: data.arguments?.path });
          break;
        }
        case 'tool.execution_complete': {
          const data = (event.data ?? {}) as CopilotToolCompleteData;
          const call = data.toolCallId ? toolCallById.get(data.toolCallId) : undefined;
          if (!call) {
            break; // orphaned completion (truncated transcript) — nothing to attribute
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
          if (!failed && call.path && FILE_WRITE_TOOLS.has(call.name)) {
            fileOperations.push({ type: call.name === 'create' ? 'write' : 'edit', path: call.path });
          }
          break;
        }
        case 'skill.invoked': {
          const data = (event.data ?? {}) as CopilotSkillInvokedData;
          const name = data.skill ?? data.name;
          if (name) {
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
          if (typeof text === 'string' && text.trim()) {
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

    // session.shutdown.codeChanges is the authoritative churn figure, but reports only
    // session-wide line totals plus a file list — no per-file deltas. Merge it into the
    // per-file operations already gathered from tool arguments rather than appending a
    // second entry for the same path, which would double-count the file.
    const changes = shutdown?.codeChanges;
    if (changes) {
      for (const path of changes.filesModified ?? []) {
        if (!fileOperations.some((op) => op.path === path)) {
          fileOperations.push({ type: 'edit', path });
        }
      }
      // Copilot gives no per-file split, so the session totals land on one entry. Prefer a
      // file shutdown actually lists as modified — the first tool-derived entry may be a
      // file that was opened but never changed, and crediting churn to it would be wrong.
      const modified = new Set(changes.filesModified ?? []);
      const target =
        fileOperations.find((op) => op.path !== undefined && modified.has(op.path)) ?? fileOperations[0];
      if (target) {
        target.linesAdded = changes.linesAdded ?? 0;
        target.linesRemoved = changes.linesRemoved ?? 0;
      }
    }

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

  /** Parse once, then run every registered processor in priority order. */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    const parsed = await this.parseSessionFile(filePath, sessionId);

    const processors: AggregatedResult['processors'] = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      if (!processor.shouldProcess(parsed)) {
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
    };
  }
}
