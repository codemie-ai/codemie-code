/**
 * Pi Session Adapter
 *
 * Discovers and parses Pi JSONL session files, then runs the metrics processor.
 */

import { open, readFile, readdir, stat } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getUserPiAgentDir, resolvePiSessionDir, type PiSessionDirResolution } from './pi.paths.js';

export interface PiDiscoveryOptions extends SessionDiscoveryOptions {
  /** Environment variables used to resolve Pi session-directory overrides. */
  env?: NodeJS.ProcessEnv;
}

/** One transcript linked to a parsed session, as {@link ParsedSession.subagents} carries it. */
type LinkedTranscript = NonNullable<ParsedSession['subagents']>[number];

/**
 * `subagents[].agentType` for a nested sub-agent run: a delegated agent Pi ran under this
 * transcript, stored at `<transcript-without-.jsonl>/<agentId>/run-N/session.jsonl`.
 */
export const PI_SUBAGENT_RUN = 'pi-subagent-run';

/**
 * `subagents[].agentType` for a transcript that CONTINUED this one (`/fork`, `/branch`).
 * Its inherited entries are byte-identical copies of this transcript's, ids included, so
 * consumers must fold it in by entry identity rather than concatenating blindly.
 *
 * Never attached by this adapter — see {@link PiSessionAdapter.loadSubagentRuns} for why folding
 * a fork family is the analytics layer's job. `native-loader.ts` attaches it.
 */
export const PI_FORKED_CONTINUATION = 'pi-forked-continuation';

/** The transcripts that continued `parsed` via `/fork` or `/branch`, in discovery order. */
export function piForkedContinuations(parsed: ParsedSession): LinkedTranscript[] {
  return (parsed.subagents ?? []).filter((sub) => sub.agentType === PI_FORKED_CONTINUATION);
}

/** The immediate subdirectories of `root`, or [] when it is absent or unreadable. */
async function subdirectoriesOf(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Every project's session directory, for an unscoped (analytics) listing.
 *
 * Pi transcripts live under TWO roots, and a listing that reads one of them is blind to
 * whichever half of the user's usage lives in the other:
 *
 *  - `<cwd>/.pi/codemie/agent/sessions` — where CodeMie points Pi (`beforeRun` sets
 *    `PI_CODING_AGENT_DIR`), so every MANAGED run lands here. In practice it holds exactly
 *    one directory, the project's own.
 *  - `~/.pi/agent/sessions` — Pi's own default (upstream `getDefaultSessionDir`), so every
 *    BARE `pi` run lands here. Native discovery exists precisely to report those runs, and
 *    this is the only root that has them.
 *
 * Both use the same one-directory-per-cwd layout, so a root's subdirectories ARE the projects.
 * A directory the user pointed Pi at explicitly (`PI_CODING_AGENT_SESSION_DIR`, or `sessionDir`
 * in settings) is not part of that layout — its siblings are arbitrary directories that have
 * nothing to do with Pi — so a custom resolution stays alone.
 */
async function allProjectSessionDirs(resolution: PiSessionDirResolution): Promise<string[]> {
  const { sessionDir, isCustom } = resolution;
  if (isCustom) {
    return [sessionDir];
  }

  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const root of [dirname(sessionDir), join(getUserPiAgentDir(), 'sessions')]) {
    for (const dir of await subdirectoriesOf(root)) {
      const key = resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }
  }
  // Both roots unreadable — fall back to the project's own directory.
  return dirs.length > 0 ? dirs : [sessionDir];
}
import {
  PI_METRICS_PROCESSOR_NAME,
  PiMetricsProcessor,
  type PiLedgerInvocations,
} from './session/processors/pi.metrics-processor.js';
import { PiConversationsProcessor } from './session/processors/pi.conversations-processor.js';
import { isPiSessionHeader, type PiEntry, type PiSessionHeader } from './pi.types.js';

export class PiSessionAdapter implements SessionAdapter {
  readonly agentName = 'pi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new PiMetricsProcessor(this.metadata));
    this.registerProcessor(new PiConversationsProcessor());
    logger.debug(`[pi-adapter] Initialized ${this.processors.length} processors`);
  }

  /**
   * Supply the run-ledger counts the metrics processor cannot derive from a transcript.
   *
   * Pi expands a prompt template into plain user text before persisting it, so `/review` never
   * appears in the JSONL — the only record of it is the ledger the CodeMie extension wrote
   * (`pi.extension.ts`). The processing pipeline reaches this adapter through the registry
   * singleton, and `ProcessingContext` is shared by every agent, so the counts are handed over
   * here rather than threaded through a field only Pi would ever read.
   */
  setLedgerInvocations(ledgerInvocations: PiLedgerInvocations | undefined): void {
    this.processors = this.processors.filter((processor) => processor.name !== PI_METRICS_PROCESSOR_NAME);
    this.registerProcessor(new PiMetricsProcessor(this.metadata, ledgerInvocations));
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[pi-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const entries = await this.readJsonlFile(filePath);
      const header = await this.readSessionHeader(filePath);
      const projectPath = header?.cwd ?? process.cwd();
      const subagents = await this.loadSubagentRuns(filePath);

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Pi',
        metadata: {
          projectPath,
          ...(header?.timestamp && { createdAt: header.timestamp }),
          ...(header?.id && { agentSessionId: header.id }),
          // The file's own statement of which transcript it was forked from. Analytics uses
          // it to collapse a fork family into the one conversation it really is.
          ...(header?.parentSession && { parentSession: header.parentSession }),
        },
        messages: entries as unknown[],
        ...(subagents.length > 0 && { subagents }),
      };
    } catch (error) {
      logger.error(`[pi-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Nested sub-agent transcripts, stored under `<transcript-without-.jsonl>/<agentId>/run-N/`.
   *
   * A delegated agent gets its own session file there. The parent records tool results for those
   * dispatches but NO usage on them (measured on a real corpus: 1707 `toolResult` entries, zero
   * carrying `usage`), so every token a sub-agent burned lives only in the nested file and a
   * reader that walks `messages` alone misses all of it.
   *
   * Attached WITHOUT a `toolUseId`: this is session-level spend, not the allocation of one
   * dispatch, and `cost-enricher.enrichDispatchCosts` keys on `toolUseId` precisely so it skips
   * these.
   *
   * **Forked continuations are deliberately NOT linked here.** `/fork` writes a new file that
   * replays the prior conversation verbatim, so folding it into its source looks tempting — but
   * `codemie pi --fork` is a second MANAGED run with a CodeMie session of its own, and the cost
   * enricher walks sessions in `startTime` order against a shared `seen` set. Anything attached
   * to the earlier session's transcript is consumed by the earlier session, so the forked run
   * reports as free and its spend lands on the wrong session, date and branch. Collapsing a fork
   * family is the analytics layer's job, where the set of sessions being reported is known;
   * `native-loader.ts` does it for untracked runs.
   *
   * This is identity, not attribution: a directory Pi named after this transcript. Nothing here
   * guesses ownership from mtime, id shape, or timing — see {@link discoverSessions}.
   */
  private async loadSubagentRuns(transcriptPath: string): Promise<LinkedTranscript[]> {
    if (!transcriptPath.endsWith('.jsonl')) {
      return [];
    }
    const runsRoot = transcriptPath.slice(0, -'.jsonl'.length);
    let agentDirs: string[];
    try {
      agentDirs = await readdir(runsRoot);
    } catch {
      return []; // no sub-agent ran under this transcript
    }

    const out: LinkedTranscript[] = [];
    for (const agentDir of agentDirs.sort()) {
      let runDirs: string[];
      try {
        runDirs = await readdir(join(runsRoot, agentDir));
      } catch {
        continue;
      }
      for (const runDir of runDirs.sort()) {
        const sessionPath = join(runsRoot, agentDir, runDir, 'session.jsonl');
        if (!existsSync(sessionPath)) {
          continue;
        }
        try {
          out.push({
            agentId: `${agentDir}/${runDir}`,
            filePath: sessionPath,
            agentType: PI_SUBAGENT_RUN,
            messages: (await this.readJsonlFile(sessionPath)) as unknown[],
          });
        } catch {
          logger.debug(`[pi-adapter] Could not read sub-agent run: ${sessionPath}`);
        }
      }
    }
    return out;
  }


  private static readonly HEADER_READ_BYTES = 65536;

  private async readSessionHeader(filePath: string): Promise<PiSessionHeader | undefined> {
    let handle: import('fs/promises').FileHandle | undefined;
    try {
      handle = await open(filePath, 'r');
      const buffer = Buffer.alloc(PiSessionAdapter.HEADER_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, PiSessionAdapter.HEADER_READ_BYTES, 0);
      if (bytesRead === 0) return undefined;
      const firstLine = buffer.toString('utf-8', 0, bytesRead).split('\n')[0]?.trim();
      if (!firstLine) return undefined;
      const parsed = JSON.parse(firstLine);
      if (isPiSessionHeader(parsed)) {
        return parsed;
      }
    } catch {
      // ignore — malformed header is handled by caller
    } finally {
      await handle?.close().catch(() => {
        // best-effort close
      });
    }
    return undefined;
  }

  private async readJsonlFile(filePath: string): Promise<PiEntry[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries: PiEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed as PiEntry);
        } else {
          logger.debug(`[pi-adapter] Skipping non-object JSONL line in ${filePath}`);
        }
      } catch {
        logger.debug(`[pi-adapter] Skipping malformed JSONL line in ${filePath}`);
      }
    }
    return entries;
  }

  async processSession(filePath: string, sessionId: string, context: ProcessingContext): Promise<AggregatedResult> {
    const parsedSession = await this.parseSessionFile(filePath, sessionId);
    if (context.gitBranch && parsedSession.metadata) {
      (parsedSession.metadata as Record<string, unknown>).gitBranch = context.gitBranch;
    }

    const processorResults: Record<string, { success: boolean; message?: string; recordsProcessed?: number }> = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      try {
        if (!processor.shouldProcess(parsedSession)) {
          logger.debug(`[pi-adapter] Processor ${processor.name} skipped`);
          continue;
        }
        const result = await processor.process(parsedSession, context);
        processorResults[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed: result.metadata?.recordsProcessed,
        };
        if (!result.success) {
          failedProcessors.push(processor.name);
        }
        if (typeof result.metadata?.recordsProcessed === 'number') {
          totalRecords += result.metadata.recordsProcessed;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[pi-adapter] Processor ${processor.name} threw:`, error);
        processorResults[processor.name] = { success: false, message: msg };
        failedProcessors.push(processor.name);
      }
    }

    return {
      success: failedProcessors.length === 0,
      processors: processorResults,
      totalRecords,
      failedProcessors,
    };
  }

  /**
   * Enumerate the Pi transcripts visible from this project.
   *
   * This is a plain listing, and deliberately so: it answers "which Pi transcripts
   * exist here", never "which of them belong to the run that just finished".
   *
   * That second question cannot be answered from a directory. A concurrent `pi` — or
   * a second CodeMie run in the same cwd — writes files indistinguishable from this
   * run's by id, mtime, or `parentSession` lineage, and claiming one of them uploads
   * a stranger's prompts and tool output under this user's session. Successive
   * rounds of increasingly careful heuristics here were each shown to be reachable-
   * wrong, so ownership is no longer inferred at all: the CodeMie extension records
   * each transcript path from inside Pi, and `readPiRunLedger` reads it back.
   *
   * Scope follows the caller. With a `cwd`, the listing is that project's: the transcripts in
   * that project's session directory whose own header declares that cwd — what a managed run
   * needs. Without one, the listing is every project's, because that is what analytics needs:
   * Claude and Codex discovery is global, so a cwd-scoped Pi would report zero usage whenever
   * `codemie analytics` is run from anywhere but the project directory.
   *
   * @see pi.extension.ts
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const piOptions = options as PiDiscoveryOptions | undefined;
    const projectScoped = piOptions?.cwd !== undefined;
    const cwd = piOptions?.cwd ?? process.cwd();
    const resolution = resolvePiSessionDir(cwd, piOptions?.env);

    const maxAgeDays = piOptions?.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const sessionDirs = projectScoped ? [resolution.sessionDir] : await allProjectSessionDirs(resolution);
    const found: SessionDescriptor[] = [];
    for (const dir of sessionDirs) {
      found.push(...(await this.listTranscripts(dir, cutoff, projectScoped ? cwd : undefined)));
    }
    found.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const limited = piOptions?.limit && piOptions.limit > 0 ? found.slice(0, piOptions.limit) : found;

    logger.debug(
      `[pi-discovery] ${found.length} transcript(s) in ${sessionDirs.length} dir(s), returning ${limited.length}`
    );
    return limited;
  }

  /**
   * Every transcript in `sessionDir` recent enough to matter, optionally narrowed to one project.
   *
   * A session directory can be shared between projects (`--session-dir`, or a
   * `sessionDir` in the project's `.pi/settings.json`), so when a `projectPath` is
   * given each file's own header must declare that cwd. Filtering is on mtime rather
   * than header timestamp so a long-running session is not dropped while it is still
   * being written to.
   */
  private async listTranscripts(
    sessionDir: string,
    cutoff: number,
    projectPath?: string
  ): Promise<SessionDescriptor[]> {
    if (!existsSync(sessionDir)) {
      return [];
    }

    const resolvedCwd = projectPath === undefined ? undefined : resolve(projectPath);
    const transcripts: SessionDescriptor[] = [];
    try {
      for (const file of await readdir(sessionDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(sessionDir, file);

        let statResult;
        try {
          statResult = await stat(filePath);
        } catch {
          continue;
        }
        if (!statResult.isFile()) continue;

        const updatedAt = statResult.mtime.getTime();
        if (updatedAt < cutoff) continue;

        const header = await this.readSessionHeader(filePath);
        if (!header) {
          logger.debug(`[pi-discovery] Skipping file with invalid header: ${filePath}`);
          continue;
        }
        if (resolvedCwd !== undefined && resolve(header.cwd) !== resolvedCwd) {
          logger.debug(`[pi-discovery] Skipping session from different cwd: ${header.cwd}`);
          continue;
        }

        const createdAt = Date.parse(header.timestamp);
        transcripts.push({
          sessionId: header.id,
          filePath,
          projectPath: header.cwd,
          createdAt: Number.isNaN(createdAt) ? updatedAt : createdAt,
          updatedAt,
          agentName: 'pi',
        });
      }
    } catch (error) {
      logger.debug(`[pi-discovery] Failed to scan session dir ${sessionDir}:`, error);
    }

    return transcripts;
  }
}
