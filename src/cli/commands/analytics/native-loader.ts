/**
 * Native session discovery for analytics.
 *
 * The metrics loader only sees sessions CodeMie tracked into ~/.codemie/sessions/.
 * Plain `claude` / `codex` usage (not via `codemie-claude` / `codemie-codex`) is never
 * tracked, so it is invisible to the report. This module discovers those native agent
 * logs directly (via SessionAdapter.discoverSessions) and synthesizes the same
 * {@link RawSessionData} shape the loader produces, so the whole downstream pipeline
 * (aggregator → formatter/report → cost) sees them too.
 *
 * Native logs already correlated to a tracked CodeMie session are skipped (deduped by
 * real path) so they are not double-counted.
 */

import { realpathSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RawSessionData } from './data-loader.js';
import type { AnalyticsFilter } from './types.js';
import type { MetricDelta } from '../../../agents/core/metrics/types.js';
import type { ParsedSession } from '../../../agents/core/session/BaseSessionAdapter.js';
import type { SessionDescriptor } from '../../../agents/core/session/discovery-types.js';
import { AgentRegistry } from '../../../agents/registry.js';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { stripClear } from '../../../agents/plugins/claude/session/strip-clear.js';
import { SESSION_ORIGIN } from '../../../agents/core/session/types.js';
import { isCodexFamilyAgent } from './cost/codex-agent.js';
import { firstCodexUserText } from '../../../agents/plugins/codex/session/codex-user-prompt.js';
import { collectCodexChildThreadIds } from '../../../agents/plugins/codex/session/codex-collab-links.js';
import { firstPiUserText } from '../../../agents/plugins/pi/session/pi-user-prompt.js';
import { PI_FORKED_CONTINUATION, piForkedContinuations } from '../../../agents/plugins/pi/pi.session.js';

/** Agents whose native logs we discover + synthesize. */
const NATIVE_AGENTS = ['claude', 'codex', 'copilot-cli', 'pi'] as const;

function isPiAgent(agentName: string): boolean {
  return agentName.toLowerCase() === 'pi';
}

/**
 * Agents CodeMie only reads analytics for and never installs, launches, or manages.
 *
 * The ownership gate below exists to stop analytics silently counting UNMANAGED runs of an
 * agent CodeMie CAN manage (EPMCDME-13367). A truly analytics-only agent has no managed
 * variant, so it can never carry an ownership marker — applying the gate would tag 100% of
 * its sessions `native-external` and drop them from the default report.
 */
function isAnalyticsOnlyAgent(agentName: string): boolean {
  try {
    return AgentRegistry.getAgent(agentName)?.metadata.analyticsOnly === true;
  } catch {
    return false;
  }
}

/** A discovered native session paired with its agent. */
export interface DiscoveredNative {
  agentName: string;
  descriptor: SessionDescriptor;
}

/** Injected boundary so synthesis/dedup logic is unit-testable without fs or the registry. */
export interface NativeLoaderDeps {
  /** Real paths of native logs already tracked by CodeMie (skip these to avoid double counting). */
  trackedLogPaths(): Set<string>;
  /** Discover native sessions for discovery-capable agents within the age window. */
  discover(maxAgeDays: number): Promise<DiscoveredNative[]>;
  /** Parse a native log into a unified session. */
  parse(agentName: string, filePath: string, sessionId: string): Promise<ParsedSession | null>;
  /** Resolve a path to its real (symlink-free) form for dedup comparison. */
  realPath(p: string): string;
  /** Returns true when the transcript at filePath contains a codemie_session_start marker (first 10 lines). */
  hasOwnershipMarker(filePath: string): boolean;
}

function safeRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Build the set of native log paths already tracked by CodeMie (from session correlations). */
function readTrackedLogPaths(): Set<string> {
  const out = new Set<string>();
  let dir: string;
  try {
    dir = getCodemiePath('sessions');
  } catch {
    return out;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('_metrics.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        correlation?: { agentSessionFile?: string };
      };
      const asf = meta.correlation?.agentSessionFile;
      if (asf) {
        out.add(safeRealPath(asf));
      }
    } catch {
      // skip unreadable / malformed metadata
    }
  }
  return out;
}

/**
 * Lazy-built ownership index: union of
 *   (a) agentSessionFile real-paths from correlation records (*.json, non-metrics, non-marker)
 *   (b) transcriptPath values from sidecar marker files (*-codemie-marker.json)
 * Cached for the lifetime of the process — analytics runs are short-lived.
 */
let ownershipIndexCache: Set<string> | null = null;

function buildOwnershipIndex(): Set<string> {
  const out = new Set<string>();
  let dir: string;
  try {
    dir = getCodemiePath('sessions');
  } catch {
    return out;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      if (f.endsWith('-codemie-marker.json')) {
        const marker = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
          transcriptPath?: string;
        };
        if (marker.transcriptPath) out.add(safeRealPath(marker.transcriptPath));
      } else if (!f.endsWith('_metrics.json')) {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
          correlation?: { agentSessionFile?: string };
          origin?: string;
        };
        // A confirmed external-resume session must never re-adopt its transcript into the
        // ownership index — that would silently exclude it from `native-external` filtering
        // again, undoing the whole point of flagging it. See EPMCDME-12992.
        if (meta.origin === SESSION_ORIGIN.EXTERNAL_RESUME) continue;
        const asf = meta.correlation?.agentSessionFile;
        if (asf) out.add(safeRealPath(asf));
      }
    } catch {
      // skip unreadable / malformed files
    }
  }
  return out;
}

export const realNativeDeps: NativeLoaderDeps = {
  trackedLogPaths: readTrackedLogPaths,
  async discover(maxAgeDays) {
    const found: DiscoveredNative[] = [];
    for (const agentName of NATIVE_AGENTS) {
      const adapter = AgentRegistry.getAgent(agentName)?.getSessionAdapter?.();
      if (!adapter?.discoverSessions) {
        continue;
      }
      try {
        const descriptors = await adapter.discoverSessions({ maxAgeDays });
        for (const descriptor of descriptors) {
          found.push({ agentName: descriptor.agentName ?? agentName, descriptor });
        }
      } catch (e) {
        logger.debug(`[native] discovery failed for ${agentName}:`, e);
      }
    }
    return found;
  },
  async parse(agentName, filePath, sessionId) {
    const adapter = AgentRegistry.getAgent(agentName)?.getSessionAdapter?.();
    if (!adapter) {
      return null;
    }
    try {
      return await adapter.parseSessionFile(filePath, sessionId);
    } catch (e) {
      logger.debug(`[native] parse failed for ${sessionId}:`, e);
      return null;
    }
  },
  realPath: safeRealPath,
  hasOwnershipMarker(filePath: string): boolean {
    // CR-003: index-first check — correlation index + sidecar markers
    if (!ownershipIndexCache) ownershipIndexCache = buildOwnershipIndex();
    if (ownershipIndexCache.has(safeRealPath(filePath))) return true;

    // CR-002: bounded transcript scan (4 KB) for legacy sessions without sidecar
    try {
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(4096);
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buf, 0, 4096, 0);
      } finally {
        closeSync(fd);
      }
      return buf
        .subarray(0, bytesRead)
        .toString('utf-8')
        .split('\n')
        .slice(0, 10)
        .some((line) => {
          try {
            return (JSON.parse(line) as { type?: string }).type === 'codemie_session_start';
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    }
  },
};

interface RawMessage {
  type?: string;
  timestamp?: string | number;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; model?: string; content?: unknown };
}

/**
 * The first genuine user prompt text in a native transcript — the session's opening message.
 * Skips messages whose content is a tool_result (role 'user' but not a real prompt) and returns
 * the first string/text-block content found, so the aggregator can derive a session title.
 */
function firstUserText(messages: RawMessage[]): string | undefined {
  for (const m of messages) {
    const role = m.message?.role ?? m.type;
    if (role !== 'user') {
      continue;
    }
    const content = m.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) {
        return content;
      }
      continue;
    }
    if (Array.isArray(content)) {
      const block = content.find(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
      );
      if (block && block.text.trim()) {
        return block.text;
      }
    }
  }
  return undefined;
}

function toMs(ts: string | number | undefined): number | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function isAssistant(m: RawMessage): boolean {
  return m.type === 'assistant' || m.message?.role === 'assistant';
}

/** Most frequent value in a list (ties → first seen), or undefined if empty. */
function modal(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/**
 * Codex child rollout thread IDs referenced by parent collab_agent_spawn_end events.
 * Those files are discovered separately; skip them as top-level native sessions to avoid double counting.
 */
export { collectCodexChildThreadIds } from '../../../agents/plugins/codex/session/codex-collab-links.js';

interface CodexRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    role?: string;
    content?: unknown;
  };
}

function countCodexTurns(records: CodexRolloutLine[]): number {
  const completes = records.filter((r) => r.type === 'event_msg' && r.payload?.type === 'task_complete').length;
  return Math.max(completes, 1);
}

function codexTimestamps(records: CodexRolloutLine[]): number[] {
  return records
    .map((r) => (r.timestamp ? Date.parse(r.timestamp) : NaN))
    .filter((n): n is number => Number.isFinite(n));
}

/**
 * The facts only a per-agent transcript reader can supply. Everything else about a synthesized
 * native session is identical across agents and lives in {@link buildNativeRawSession}.
 */
interface NativeSessionFacts {
  cwd: string;
  branch?: string;
  startTime: number;
  endTime: number;
  turns: number;
  models: string[];
  openingPrompt?: string;
}

/**
 * Assemble {@link RawSessionData} from per-agent facts.
 *
 * All per-session metrics (tools / file ops / models / named invocations) ride on a single
 * metrics-bearing delta — the aggregator sums across deltas, so one populated delta plus empty
 * placeholders is equivalent to per-turn deltas. The placeholders exist purely so the
 * aggregator's `totalTurns` (= `deltas.length`) matches the transcript's real turn count.
 */
function buildNativeRawSession(
  agentName: string,
  descriptor: SessionDescriptor,
  parsed: ParsedSession,
  facts: NativeSessionFacts
): RawSessionData {
  const { cwd, branch, startTime, endTime, turns, models, openingPrompt } = facts;

  const metricsDelta: MetricDelta = {
    recordId: `${descriptor.sessionId}-native`,
    sessionId: descriptor.sessionId,
    agentSessionId: descriptor.sessionId,
    timestamp: startTime,
    gitBranch: branch,
    tools: parsed.metrics?.tools ?? {},
    toolStatus: parsed.metrics?.toolStatus,
    fileOperations: parsed.metrics?.fileOperations as MetricDelta['fileOperations'],
    models,
    // Named invocations are extracted at parse time (e.g. claude.session.ts extractMetrics);
    // carry them through so native (untracked) sessions populate the skill/agent/command charts.
    ...(parsed.metrics?.skillInvocations && { skillInvocations: parsed.metrics.skillInvocations }),
    ...(parsed.metrics?.agentInvocations && { agentInvocations: parsed.metrics.agentInvocations }),
    ...(parsed.metrics?.commandInvocations && { commandInvocations: parsed.metrics.commandInvocations }),
    // Opening prompt → drives the session title in the report (aggregator strips command/system XML).
    ...(openingPrompt && { userPrompts: [{ count: 1, text: openingPrompt }] }),
    syncStatus: 'synced',
    syncAttempts: 0,
  };

  const deltas: MetricDelta[] = [metricsDelta];
  for (let i = 1; i < turns; i++) {
    deltas.push({
      recordId: `${descriptor.sessionId}-native-${i}`,
      sessionId: descriptor.sessionId,
      agentSessionId: descriptor.sessionId,
      timestamp: startTime,
      gitBranch: branch,
      tools: {},
      syncStatus: 'synced',
      syncAttempts: 0,
    });
  }

  return {
    sessionId: descriptor.sessionId,
    agentSessionFile: descriptor.filePath, // lets the cost enricher price native (untracked) sessions
    startEvent: {
      recordId: descriptor.sessionId,
      type: 'session_start',
      timestamp: startTime,
      codeMieSessionId: descriptor.sessionId,
      agentName,
      syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: cwd, startTime },
    },
    endEvent: {
      recordId: `${descriptor.sessionId}-end`,
      type: 'session_end',
      timestamp: endTime,
      codeMieSessionId: descriptor.sessionId,
      agentName,
      syncStatus: 'synced',
      data: { endTime, duration: Math.max(0, endTime - startTime), totalTurns: turns },
    },
    deltas,
  };
}

/** Synthesize {@link RawSessionData} from a parsed Codex rollout (non-Claude JSONL shape). */
export function synthesizeCodexRawSession(
  agentName: string,
  descriptor: SessionDescriptor,
  parsed: ParsedSession
): RawSessionData {
  const records = (parsed.messages ?? []) as CodexRolloutLine[];
  const timestamps = codexTimestamps(records);
  const meta = parsed.metadata as { projectPath?: string; branch?: string; model?: string } | undefined;

  return buildNativeRawSession(agentName, descriptor, parsed, {
    cwd: meta?.projectPath ?? descriptor.projectPath ?? 'Unknown',
    branch: meta?.branch,
    startTime: timestamps.length ? Math.min(...timestamps) : descriptor.createdAt,
    endTime: timestamps.length ? Math.max(...timestamps) : descriptor.updatedAt ?? descriptor.createdAt,
    turns: countCodexTurns(records),
    models: meta?.model ? [meta.model] : [],
    openingPrompt: firstCodexUserText(records),
  });
}

/** A Pi v3 session-log line, narrowed to the fields native synthesis reads. */
interface PiSessionLine {
  type?: string;
  /** Entry identity, stable across the verbatim copies a `/fork` inherits. */
  id?: string;
  /** ISO timestamp on the entry envelope. */
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    responseModel?: string;
    /** Epoch ms. */
    timestamp?: number;
  };
}

/**
 * Every entry of the conversation this transcript belongs to, each counted once.
 *
 * `/fork` writes a NEW file that replays the prior conversation VERBATIM — entry ids included —
 * and {@link foldPiForkFamilies} attaches those continuations to the transcript they grew out
 * of. Concatenating blindly would count the replayed history once per fork: on a real 12-file
 * corpus that is 121 turns for 21 real prompts, and every fork claiming the full multi-hour
 * duration it inherited. De-duplicating on the entry id each file writes about itself collapses
 * the family back to the single conversation it is.
 */
function piConversationLines(parsed: ParsedSession): PiSessionLine[] {
  const own = (parsed.messages ?? []) as PiSessionLine[];
  const continuations = piForkedContinuations(parsed);
  if (continuations.length === 0) {
    return own;
  }

  const lines: PiSessionLine[] = [];
  const seenIds = new Set<string>();
  for (const line of [...own, ...continuations.flatMap((fork) => (fork.messages ?? []) as PiSessionLine[])]) {
    if (line?.id) {
      if (seenIds.has(line.id)) {
        continue; // replayed copy of an entry an earlier transcript in the family already had
      }
      seenIds.add(line.id);
    }
    lines.push(line);
  }
  return lines;
}

function piLineTimestamp(line: PiSessionLine): number | null {
  const messageTs = line.message?.timestamp;
  if (typeof messageTs === 'number' && Number.isFinite(messageTs)) {
    return messageTs;
  }
  const entryTs = line.timestamp ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(entryTs) ? entryTs : null;
}

/**
 * Turns in a Pi transcript = user prompts.
 *
 * Pi gives tool results their own `toolResult` role, so a `user` message is always a real prompt
 * and never a tool round-trip — which makes prompt count the honest analogue of Codex's
 * `task_complete` count. Counting assistant messages instead (what the Claude path does, because
 * Claude has no such separation) would report ~170 "turns" for a dozen-prompt session.
 */
function countPiTurns(lines: PiSessionLine[]): number {
  const prompts = lines.filter((l) => l.type === 'message' && l.message?.role === 'user').length;
  return Math.max(prompts, 1);
}

/**
 * Synthesize {@link RawSessionData} from a parsed Pi session (v3 JSONL — neither Claude- nor
 * Codex-shaped: entries are `{type, id, parentId, timestamp, message}` envelopes).
 *
 * Only UNMANAGED `pi` runs reach here. A CodeMie-launched run writes an ownership sidecar for
 * every transcript it produced (pi.plugin.ts `correlateRunToSession`), so `hasOwnershipMarker`
 * classifies those as managed before this synthesis is ever consulted for the provider tag.
 *
 * NO GIT BRANCH. Pi's v3 header records `id`, `timestamp`, `cwd` and `parentSession` — no VCS
 * state — and no entry carries one either, so unlike Codex (`session_meta.git.branch`) and Claude
 * (per-message `gitBranch`) there is nothing truthful to report. Native Pi sessions therefore
 * bucket under "Unknown" and `codemie analytics --branch <x>` filters all of them out. Reading
 * the cwd's CURRENT branch would be a fabrication: it would stamp today's branch on a session
 * recorded weeks ago. (`metadata.gitBranch` IS populated on the managed path, where
 * `processSession` overlays the branch captured while the run was live.)
 */
export function synthesizePiRawSession(
  agentName: string,
  descriptor: SessionDescriptor,
  parsed: ParsedSession
): RawSessionData {
  const lines = piConversationLines(parsed);
  const timestamps = lines.map(piLineTimestamp).filter((n): n is number => n !== null);
  const meta = parsed.metadata as { projectPath?: string } | undefined;

  const models = lines
    .filter((l) => l.type === 'message' && l.message?.role === 'assistant')
    .map((l) => l.message?.responseModel ?? l.message?.model)
    .filter((m): m is string => !!m);

  return buildNativeRawSession(agentName, descriptor, parsed, {
    // The adapter reads cwd from the transcript's own session header, which is authoritative:
    // `--session <path>` can run Pi under a directory other than the one it was launched from.
    cwd: meta?.projectPath ?? descriptor.projectPath ?? 'Unknown',
    startTime: timestamps.length ? Math.min(...timestamps) : descriptor.createdAt,
    endTime: timestamps.length ? Math.max(...timestamps) : descriptor.updatedAt ?? descriptor.createdAt,
    turns: countPiTurns(lines),
    models,
    openingPrompt: firstPiUserText(lines),
  });
}

/**
 * Synthesize a {@link RawSessionData} from a parsed native session, dispatching to the reader
 * that understands the agent's log shape. The Claude-shaped path below is the fallback: turns
 * map to assistant messages, since Claude interleaves tool results into `user` messages and so
 * has no prompt count to key on.
 *
 * A post-/clear file starts with the /clear sentinel as its first user message; stripClear strips
 * it so it is never mistaken for the session's opening prompt.
 */
export function synthesizeRawSession(
  agentName: string,
  descriptor: SessionDescriptor,
  parsed: ParsedSession
): RawSessionData {
  if (isCodexFamilyAgent(agentName)) {
    return synthesizeCodexRawSession(agentName, descriptor, parsed);
  }
  if (isPiAgent(agentName)) {
    return synthesizePiRawSession(agentName, descriptor, parsed);
  }
  const messages = stripClear((parsed.messages ?? []) as RawMessage[]) as RawMessage[];
  const timestamps = messages.map((m) => toMs(m.timestamp)).filter((n): n is number => n != null);
  const assistantMsgs = messages.filter(isAssistant);

  return buildNativeRawSession(agentName, descriptor, parsed, {
    cwd: messages.find((m) => m.cwd)?.cwd ?? descriptor.projectPath ?? 'Unknown',
    branch: modal(messages.map((m) => m.gitBranch).filter((b): b is string => !!b)),
    startTime: timestamps.length ? Math.min(...timestamps) : descriptor.createdAt,
    endTime: timestamps.length ? Math.max(...timestamps) : descriptor.updatedAt ?? descriptor.createdAt,
    turns: Math.max(assistantMsgs.length, 1),
    models: assistantMsgs.map((m) => m.message?.model).filter((m): m is string => !!m),
    openingPrompt: firstUserText(messages),
  });
}

/** Number of days from a filter's fromDate to now (for the discovery window), or a wide default. */
function windowDays(filter?: AnalyticsFilter): number {
  if (filter?.fromDate) {
    const days = Math.ceil((Date.now() - filter.fromDate.getTime()) / 86_400_000);
    return Math.max(days + 1, 1);
  }
  return 3650; // no lower bound requested → effectively "all"
}

/** A discovered Pi transcript, parsed once, with the fork source its own header names. */
interface PiTranscript {
  descriptor: SessionDescriptor;
  /** Symlink-resolved path — the identity every dedup in this module keys on. */
  realPath: string;
  parsed: ParsedSession | null;
  /** Real path of the transcript this one forked from; set only when that source is also discovered. */
  parentRealPath?: string;
}

/** Parse every discovered Pi transcript once and resolve the fork source each header names. */
async function readPiTranscripts(discovered: DiscoveredNative[], deps: NativeLoaderDeps): Promise<PiTranscript[]> {
  const piDiscoveredPaths = new Set(
    discovered.filter((d) => isPiAgent(d.agentName)).map((d) => deps.realPath(d.descriptor.filePath))
  );

  const transcripts: PiTranscript[] = [];
  for (const { agentName, descriptor } of discovered) {
    if (!isPiAgent(agentName)) {
      continue;
    }
    const parsed = await deps.parse(agentName, descriptor.filePath, descriptor.sessionId);
    const parentSession = (parsed?.metadata as { parentSession?: string } | undefined)?.parentSession;
    const parentRealPath = parentSession ? deps.realPath(parentSession) : undefined;
    transcripts.push({
      descriptor,
      realPath: deps.realPath(descriptor.filePath),
      parsed,
      ...(parentRealPath && piDiscoveredPaths.has(parentRealPath) && { parentRealPath }),
    });
  }
  return transcripts;
}

/**
 * The continuations to leave out of the listing, because the adapter already folded each one
 * into the transcript it grew out of.
 *
 * A `/fork` continuation is not a new conversation, it is the same one carried into a new file:
 * it replays the prior conversation VERBATIM and names its source in the header's
 * `parentSession`. Emitting it separately reports one conversation as a dozen sessions — on a
 * real corpus, 12 files for 2 conversations, with every derived per-session metric wrong by the
 * same factor.
 *
 * Folding and suppression happen HERE, together, in one pass, because they must agree exactly:
 * a file suppressed but not folded loses its spend outright, and one folded but not suppressed
 * has it billed twice. An earlier design folded in the session adapter and suppressed here, and
 * the two disagreed in both directions — including for a cross-directory fork
 * (`SessionManager.forkFrom(sourcePath, targetCwd)`, reached by `pi --fork <global-id>`), which
 * was suppressed while nothing folded it. Doing both from one decision makes that class of
 * mismatch unrepresentable.
 *
 * This is also why the adapter must NOT fold: `codemie pi --fork` is a second MANAGED run with a
 * CodeMie session of its own, and folding there moved its whole spend onto the run it forked
 * from. Only the analytics layer knows which sessions are actually being reported.
 *
 * The source must still be in the listing. A fork whose source fell outside the discovery
 * window has nobody to be counted inside, and dropping it would delete its spend from the report.
 */
function foldPiForkFamilies(transcripts: PiTranscript[]): Set<string> {
  const byRealPath = new Map(transcripts.map((t) => [t.realPath, t]));
  const suppressed = new Set<string>();

  /** The oldest ancestor still in the listing, so a fork of a fork folds into one session. */
  const rootOf = (start: PiTranscript): PiTranscript => {
    let current = start;
    const seen = new Set<string>([current.realPath]);
    for (;;) {
      const parent = current.parentRealPath ? byRealPath.get(current.parentRealPath) : undefined;
      if (!parent?.parsed || seen.has(parent.realPath)) {
        return current; // no parent in the listing, or a cyclic parentSession chain
      }
      seen.add(parent.realPath);
      current = parent;
    }
  };

  for (const transcript of transcripts) {
    if (!transcript.parsed || !transcript.parentRealPath) {
      continue;
    }
    const root = rootOf(transcript);
    if (root === transcript || !root.parsed) {
      continue; // its source is not in the listing — report it on its own or its spend is lost
    }
    root.parsed.subagents = [
      ...(root.parsed.subagents ?? []),
      {
        agentId: basename(transcript.realPath, '.jsonl'),
        filePath: transcript.realPath,
        agentType: PI_FORKED_CONTINUATION,
        messages: transcript.parsed.messages ?? [],
      },
    ];
    suppressed.add(transcript.realPath);
  }
  return suppressed;
}

/**
 * Discover native (untracked) sessions and return them as RawSessionData, ready to merge
 * with the tracked sessions from {@link MetricsDataLoader}. Sessions whose native log is
 * already tracked by CodeMie are skipped (deduped by real path).
 */
export async function loadNativeSessions(
  filter?: AnalyticsFilter,
  deps: NativeLoaderDeps = realNativeDeps
): Promise<RawSessionData[]> {
  const tracked = deps.trackedLogPaths();
  const discovered = await deps.discover(windowDays(filter));

  // Parse each Codex session ONCE (cached for reuse below) and collect the child thread IDs each
  // parent references via spawn/wait collaboration events, so those sub-agent rollouts are not
  // double-counted as standalone sessions (they are counted inside their parent — see
  // readCodexSubagentUsage in the cost enricher).
  const codexParsed = new Map<string, ParsedSession | null>();
  const codexChildThreads = new Set<string>();
  for (const { agentName, descriptor } of discovered) {
    if (!isCodexFamilyAgent(agentName)) {
      continue;
    }
    const parsed = await deps.parse('codex', descriptor.filePath, descriptor.sessionId);
    codexParsed.set(descriptor.filePath, parsed);
    if (parsed?.messages) {
      for (const id of collectCodexChildThreadIds(parsed.messages)) {
        codexChildThreads.add(id);
      }
    }
  }

  // Same shape for Pi, one level up: parse each transcript ONCE, then drop the `/fork`
  // continuations the adapter already folded into the transcript they grew out of.
  const piTranscripts = await readPiTranscripts(discovered, deps);
  const piByRealPath = new Map(piTranscripts.map((t) => [t.realPath, t]));
  const piForkedChildren = foldPiForkFamilies(piTranscripts);

  const out: RawSessionData[] = [];
  for (const { agentName, descriptor } of discovered) {
    if (isCodexFamilyAgent(agentName) && codexChildThreads.has(descriptor.sessionId)) {
      continue; // linked sub-agent rollout — already counted inside its parent
    }
    if (isPiAgent(agentName) && piForkedChildren.has(deps.realPath(descriptor.filePath))) {
      continue; // forked continuation — already counted inside the transcript it grew out of
    }
    if (tracked.has(deps.realPath(descriptor.filePath))) {
      continue; // already tracked by CodeMie — avoid double counting
    }
    let parsed: ParsedSession | null;
    if (isCodexFamilyAgent(agentName)) {
      parsed = codexParsed.get(descriptor.filePath) ?? null;
    } else if (isPiAgent(agentName)) {
      parsed = piByRealPath.get(deps.realPath(descriptor.filePath))?.parsed ?? null;
    } else {
      parsed = await deps.parse(agentName, descriptor.filePath, descriptor.sessionId);
    }
    if (!parsed) {
      continue;
    }
    const raw = synthesizeRawSession(agentName, descriptor, parsed);
    if (raw.startEvent && !deps.hasOwnershipMarker(descriptor.filePath)) {
      // Truly analytics-only agents can never carry an ownership marker, so tagging them
      // 'native-external' would drop 100% of their sessions from the default report. They
      // still are not CodeMie-managed, so they get their own tag rather than the plain
      // 'native' that means "CodeMie launched this". Managed agents, including Copilot CLI,
      // remain 'native-external' when their transcript lacks CodeMie ownership.
      raw.startEvent.data.provider = isAnalyticsOnlyAgent(agentName)
        ? 'native-unmanaged'
        : 'native-external';
    }
    out.push(raw);
  }
  return out;
}
