/**
 * Pi Session Adapter
 *
 * Discovers and parses Pi JSONL session files, then runs the metrics processor.
 */

import { open, readFile, readdir, stat } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { resolvePiSessionDir } from './pi.paths.js';

export interface PiDiscoveryOptions extends SessionDiscoveryOptions {
  /** Earliest time this run may have started; reject files whose header timestamp predates it. */
  runStartedAt?: number;
  /** Pi's own session id (from line-1 header `id`), if known. */
  agentSessionId?: string;
  /** Environment variables used to resolve Pi session-directory overrides. */
  env?: NodeJS.ProcessEnv;
}
import { PiMetricsProcessor } from './session/processors/pi.metrics-processor.js';
import { isPiSessionHeader, type PiEntry, type PiSessionHeader } from './pi.types.js';

/** A transcript that could belong to this run, plus the fork link used to prove it. */
interface PiSessionCandidate {
  descriptor: SessionDescriptor;
  /** Absolute path of the transcript this one was forked from, when Pi recorded one. */
  parentSessionPath?: string;
}

/** Where this run's transcripts can live, and under which cwd Pi ran the session. */
interface PiDiscoveryScope {
  /** Every directory Pi may have written a transcript to during this run. */
  dirs: string[];
  /** The cwd Pi's session actually ran under, which candidates must declare. */
  cwd: string;
  /** Whether a Pi process other than this run could also be writing to `dirs`. */
  mayBeShared: boolean;
}

/**
 * Whether a Pi session id was minted by CodeMie rather than by Pi.
 *
 * CodeMie derives it from `randomUUID()` (UUIDv4) and injects it via `--session-id`;
 * Pi's own ids are UUIDv7. So an unlinked transcript carrying a v4 id that is not
 * this run's anchor is provably another CodeMie-driven Pi run.
 */
function isCodeMieSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export class PiSessionAdapter implements SessionAdapter {
  readonly agentName = 'pi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new PiMetricsProcessor(this.metadata));
    logger.debug(`[pi-adapter] Initialized ${this.processors.length} processors`);
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

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Pi',
        metadata: {
          projectPath,
          ...(header?.timestamp && { createdAt: header.timestamp }),
          ...(header?.id && { agentSessionId: header.id }),
        },
        messages: entries as unknown[],
      };
    } catch (error) {
      logger.error(`[pi-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
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

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const piOptions = options as PiDiscoveryOptions | undefined;
    const scope = await this.resolveDiscoveryScope(piOptions);

    const maxAgeDays = piOptions?.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const candidates: PiSessionCandidate[] = [];
    const scanned = new Set<string>();
    for (const dir of scope.dirs) {
      const key = resolve(dir);
      if (scanned.has(key)) continue;
      scanned.add(key);
      candidates.push(...(await this.collectCandidates(dir, cutoff, scope.cwd)));
    }

    const owned = this.attributeToRun(candidates, piOptions, scope.mayBeShared);

    owned.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const limited = piOptions?.limit && piOptions.limit > 0 ? owned.slice(0, piOptions.limit) : owned;
    logger.debug(
      `[pi-discovery] ${candidates.length} candidate(s) in ${[...scanned].join(', ')}, `
      + `attributed ${owned.length}, returning ${limited.length}`
    );
    return limited;
  }

  /** Whether Pi would treat a `--session` argument as a file path rather than an id. */
  private looksLikeTranscriptPath(identity: string): boolean {
    return identity.includes('/') || identity.includes('\\') || identity.endsWith('.jsonl');
  }

  /**
   * Work out where this run's transcripts can live.
   *
   * By default that is the session directory derived from the wrapper's cwd. But
   * `--session <path>` opens a transcript directly and Pi then runs the entire
   * session under *that transcript's* cwd (`SessionManager.open` takes the cwd
   * from the header, and the runtime uses `sessionManager.getCwd()`), writing any
   * later `/new` transcript beside the opened file unless an explicit
   * `--session-dir` says otherwise. Both differ from the wrapper's cwd, so the
   * scope has to follow the selected file or nothing is ever attributed.
   */
  private async resolveDiscoveryScope(options?: PiDiscoveryOptions): Promise<PiDiscoveryScope> {
    const cwd = options?.cwd ?? process.cwd();
    const { sessionDir, isCustom } = resolvePiSessionDir(cwd, options?.env);
    // A custom directory is one the operator named, so another Pi process — a bare
    // `pi` reading the same project `.pi/settings.json`, or a second CodeMie run —
    // can be writing to it. CodeMie's own per-cwd default is private by construction.
    const scope: PiDiscoveryScope = { dirs: [sessionDir], cwd, mayBeShared: isCustom };

    const identity = options?.agentSessionId;
    if (!identity || !this.looksLikeTranscriptPath(identity)) {
      return scope;
    }

    const identityPath = resolve(cwd, identity);
    const header = existsSync(identityPath) ? await this.readSessionHeader(identityPath) : undefined;
    if (!header) {
      return scope;
    }

    const selectedDir = dirname(identityPath);
    const isOutsideDefaultDir = resolve(selectedDir) !== resolve(sessionDir);
    logger.debug(`[pi-discovery] Following path-selected session into ${selectedDir} (cwd ${header.cwd})`);
    return {
      dirs: isCustom && isOutsideDefaultDir ? [sessionDir, selectedDir] : [selectedDir],
      cwd: header.cwd,
      mayBeShared: isCustom || isOutsideDefaultDir,
    };
  }

  /**
   * Collect every transcript in the session directory that could plausibly belong
   * to this project. This pass is deliberately free of run attribution: the lineage
   * closure below needs the complete set to walk `parentSession` links.
   */
  private async collectCandidates(
    sessionDir: string,
    cutoff: number,
    projectPath: string
  ): Promise<PiSessionCandidate[]> {
    if (!existsSync(sessionDir)) {
      return [];
    }

    const resolvedCwd = resolve(projectPath);
    const candidates: PiSessionCandidate[] = [];
    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(sessionDir, file);

        let statResult;
        try {
          statResult = await stat(filePath);
        } catch {
          continue;
        }
        if (!statResult.isFile()) continue;

        // Filter on modification time so long-running sessions are not discarded
        // while they are still being written to.
        const updatedAt = statResult.mtime.getTime();
        if (updatedAt < cutoff) continue;

        const header = await this.readSessionHeader(filePath);
        if (!header) {
          logger.debug(`[pi-discovery] Skipping file with invalid header: ${filePath}`);
          continue;
        }

        // Only attribute sessions whose own header claims this cwd. A shared
        // --session-dir can hold transcripts from several projects.
        if (resolve(header.cwd) !== resolvedCwd) {
          logger.debug(`[pi-discovery] Skipping session from different cwd: ${header.cwd}`);
          continue;
        }

        const createdAt = Date.parse(header.timestamp);
        candidates.push({
          descriptor: {
            sessionId: header.id,
            filePath,
            projectPath: header.cwd,
            createdAt: Number.isNaN(createdAt) ? updatedAt : createdAt,
            updatedAt,
            agentName: 'pi',
          },
          ...(header.parentSession && { parentSessionPath: header.parentSession }),
        });
      }
    } catch (error) {
      logger.debug(`[pi-discovery] Failed to scan session dir ${sessionDir}:`, error);
    }

    return candidates;
  }

  /**
   * Locate the transcript the published identity refers to, mirroring how Pi
   * resolves `--session <arg>`: an exact session id, a transcript path, then an id
   * prefix. An injected `--session-id` is always a full id, so it matches exactly.
   *
   * A fourth form has no counterpart in Pi's resolution but is still provable: when
   * `--session <id>` matches a session in a *different* project, Pi asks to fork it
   * into the current one and mints a fresh uuidv7 for the copy, so the named id
   * never appears as a header id here. The fork does record the source transcript's
   * path, whose file name ends in `_<source-id>.jsonl`, so descent from the named
   * session still identifies the run.
   */
  private findAnchor(candidates: PiSessionCandidate[], identity: string): PiSessionCandidate | undefined {
    return (
      candidates.find((candidate) => candidate.descriptor.sessionId === identity) ??
      candidates.find((candidate) => resolve(candidate.descriptor.filePath) === resolve(identity)) ??
      candidates.find((candidate) => candidate.descriptor.sessionId.startsWith(identity)) ??
      candidates.find(
        (candidate) =>
          candidate.parentSessionPath !== undefined &&
          basename(candidate.parentSessionPath).includes(`_${identity}`)
      )
    );
  }

  /**
   * Decide which candidate transcripts belong to the current run.
   *
   * Ownership is established in order of decreasing certainty. Timing never
   * accepts a transcript on its own — it only narrows the set — because a
   * concurrent Pi run in the same directory produces files indistinguishable by
   * time alone.
   *
   *  1. Identity — Pi was started with `--session-id`, or resumed a named session,
   *     so a header id match is proof.
   *  2. Lineage — `/fork` records the parent transcript's absolute path, so every
   *     descendant of an owned file is proof.
   *  3. Elimination — `/new` writes an unlinked header with a fresh id, carrying no
   *     proof at all. It is claimed only when the directory is provably this run's
   *     alone: identity established, no competing CodeMie run in the window, and no
   *     other Pi process able to write there.
   *
   * Timing alone accepts a transcript in exactly one case — a run that never named a
   * session (`--continue`, bare `--resume`) and found a single in-window candidate.
   * Everything else requires identity or lineage, so a run whose named transcript is
   * missing reports nothing rather than claiming a stranger's.
   */
  private attributeToRun(
    candidates: PiSessionCandidate[],
    options?: PiDiscoveryOptions,
    mayBeShared = true
  ): SessionDescriptor[] {
    const { agentSessionId, runStartedAt } = options ?? {};

    const ownedPaths = new Set<string>();
    const owned: PiSessionCandidate[] = [];
    const adopt = (candidate: PiSessionCandidate): void => {
      const key = resolve(candidate.descriptor.filePath);
      if (ownedPaths.has(key)) return;
      ownedPaths.add(key);
      owned.push(candidate);
    };

    // 1. Identity. Pi resolves `--session <arg>` as an exact id, then a transcript
    // path, then an id prefix, so the published identity is matched the same way.
    const identityPublished = agentSessionId !== undefined;
    const anchor = agentSessionId === undefined ? undefined : this.findAnchor(candidates, agentSessionId);
    if (anchor) {
      adopt(anchor);
    } else if (identityPublished) {
      // Pi does not create the transcript file until the session holds an assistant
      // message, so a run that ended before its first reply leaves no anchor behind.
      logger.debug(
        `[pi-discovery] Published session identity ${agentSessionId} matched no transcript; `
        + 'claiming nothing rather than resolving by time.'
      );
    }

    // 2. Lineage, to a fixpoint: a forked session can itself be forked again.
    // Only walk downward — the anchor's own parent belongs to an earlier run.
    const closeLineage = (): void => {
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of candidates) {
          if (!candidate.parentSessionPath) continue;
          if (ownedPaths.has(resolve(candidate.descriptor.filePath))) continue;
          if (!ownedPaths.has(resolve(candidate.parentSessionPath))) continue;
          adopt(candidate);
          grew = true;
        }
      }
    };
    closeLineage();

    // 3. Elimination, over the transcripts that are neither owned nor forked from a
    // file we own. With an anchor, a `/new` transcript must have been created after
    // it; without one the run appended to a transcript it never named, so only
    // "written during the run" can be required.
    const lowerBound = Math.max(runStartedAt ?? -Infinity, anchor?.descriptor.createdAt ?? -Infinity);
    const unlinked = candidates.filter(({ descriptor, parentSessionPath }) => {
      if (ownedPaths.has(resolve(descriptor.filePath))) return false;
      // With an anchor, a transcript forked from a file we do not own belongs to
      // whoever owns its parent. Without one there is no owned set to compare
      // against, and `--continue` may well have reopened a transcript that an
      // earlier run forked, so lineage cannot exclude anything.
      if (anchor && parentSessionPath) return false;
      return anchor
        ? descriptor.createdAt >= lowerBound
        : (descriptor.updatedAt ?? 0) >= (runStartedAt ?? -Infinity);
    });

    let survivors = unlinked;
    if (anchor) {
      // Identity is established, so any other CodeMie-minted root in the window is a
      // concurrent CodeMie run: reject it, and treat its presence as proof that this
      // directory has more than one writer. The v4/v7 test is only meaningful here —
      // without an anchor, a v4 id may well be this run's own transcript, minted by
      // the earlier CodeMie run that `--continue` is reopening.
      const concurrentRuns = unlinked.filter((candidate) => isCodeMieSessionId(candidate.descriptor.sessionId));
      survivors = unlinked.filter((candidate) => !isCodeMieSessionId(candidate.descriptor.sessionId));
      // With no competing run and no other possible writer, the remaining transcripts
      // can only be this run's own /new files, so claim them all — requiring a single
      // survivor would silently drop every /new after the first. A directory the
      // operator named is not exclusive: Pi reads `sessionDir` from the project's
      // `.pi/settings.json` too, so a bare `pi` in the same project writes there
      // alongside CodeMie, and its transcript is uuidv7 like any /new file.
      if (concurrentRuns.length === 0 && !mayBeShared) {
        survivors.forEach(adopt);
        closeLineage();
        return owned.map((candidate) => candidate.descriptor);
      }
    }

    // Timing is the last resort and applies only to a run that named no session at
    // all (`--continue` / bare `--resume`): Pi appended to a transcript this run
    // never identified, so "written during the run" is the only signal available. A
    // lone candidate is unambiguous — a second writer would have touched a file of
    // its own. Once an identity *was* published, an unmatched transcript is someone
    // else's by elimination, so timing must not be allowed to claim it.
    if (!identityPublished && survivors.length === 1) {
      adopt(survivors[0]);
      // The adopted transcript may itself have been forked afterwards.
      closeLineage();
    } else if (survivors.length > 0) {
      logger.warn(
        `[pi-discovery] ${survivors.length} unattributable transcript(s) in the run window; `
        + `claiming only the ${owned.length} provably owned. `
        + (identityPublished
          ? 'Only identity and fork lineage can prove ownership once a session was named.'
          : 'A concurrent Pi run in this directory makes them indistinguishable by time alone.')
      );
    }

    return owned.map((candidate) => candidate.descriptor);
  }
}
