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

  constructor(private readonly metadata: AgentMetadata) {}

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

  // Implemented in Task 3/6 of the plan.
  async parseSessionFile(_filePath: string, sessionId: string): Promise<ParsedSession> {
    return {
      sessionId,
      agentName: this.metadata.displayName,
      metadata: {},
      messages: [],
    };
  }

  // Implemented in Task 6 of the plan.
  async processSession(
    _filePath: string,
    _sessionId: string,
    _context: ProcessingContext
  ): Promise<AggregatedResult> {
    const processors: Record<string, ProcessingResult & { success: boolean }> = {};
    return { success: true, processors, totalRecords: 0, failedProcessors: [] };
  }
}
