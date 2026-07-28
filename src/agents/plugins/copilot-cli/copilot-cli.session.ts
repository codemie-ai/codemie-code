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
  CopilotToolCompleteData,
  CopilotSkillInvokedData,
} from './copilot-cli-event-types.js';
import { CopilotCliMetricsProcessor } from './session/processors/copilot-cli.metrics-processor.js';
import { CopilotCliConversationsProcessor } from './session/processors/copilot-cli.conversations-processor.js';
import { logger } from '../../../utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

    for (const event of events) {
      switch (event.type) {
        case 'tool.execution_complete': {
          const data = (event.data ?? {}) as CopilotToolCompleteData;
          if (!data.name) {
            break;
          }
          tools[data.name] = (tools[data.name] ?? 0) + 1;
          const bucket = toolStatus[data.name] ?? { success: 0, failure: 0 };
          const failed = data.status === 'error' || data.error !== undefined;
          bucket[failed ? 'failure' : 'success'] += 1;
          toolStatus[data.name] = bucket;
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
          const text = (event.data as { text?: string } | undefined)?.text;
          if (typeof text === 'string' && text.trim()) {
            userPrompts.push({ count: 1, text });
          }
          break;
        }
        default:
          break;
      }
    }

    // session.shutdown.codeChanges is the authoritative churn figure. Copilot reports no
    // per-file line deltas, so the session totals are attributed to the first modified
    // file and the rest are recorded as touched.
    const changes = shutdown?.codeChanges;
    for (const [index, path] of (changes?.filesModified ?? []).entries()) {
      fileOperations.push({
        type: 'edit',
        path,
        linesAdded: index === 0 ? changes?.linesAdded ?? 0 : 0,
        linesRemoved: index === 0 ? changes?.linesRemoved ?? 0 : 0,
      });
    }

    const context = start?.context;
    return {
      sessionId,
      agentName: this.metadata.displayName,
      agentVersion: start?.copilotVersion,
      metadata: {
        projectPath: context?.cwd ?? context?.gitRoot,
        createdAt: start?.startTime,
        repository: context?.repository,
        branch: context?.branch,
        gitBranch: context?.branch,
      },
      messages: usage.messages,
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
