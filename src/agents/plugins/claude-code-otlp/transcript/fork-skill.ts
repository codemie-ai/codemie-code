/**
 * Skill-fork recognition without Claude Code's `.forked-skill.marker.json` sidecar (EPMCDME-16352,
 * EPMCDME-16391).
 *
 * Some clients (the desktop app) never write the sidecar, so a forked skill looks like a plain
 * general-purpose subagent. Each fork is tied to its skill by an exact id found in the transcripts
 * — never by agent name or by how close in time it started:
 *
 * - Skill tool: the `Skill` `tool_use` (`id`, `input.skill`) whose `tool_result` names the fork
 *   (`toolUseResult.agentId`, else the `"agentId"` in the result text), or whose id is the fork's
 *   `.meta.json` `toolUseId`.
 * - Slash command: a plain user line `/name` (Claude Code writes no command wrapper for a fork)
 *   whose `promptId` is the `promptId` of exactly one subagent that no tool call started (no
 *   `toolUseId`, no `agentId` in any tool result).
 *
 * A fork's scope cannot be corrected once sent (the backend takes `max()` of scope_kind and
 * scope_name per request, not the latest), so a subagent is never classified on partial evidence.
 * A subagent that could still turn out to be a skill fork or an ordinary agent is `pending`: a
 * `Skill` call has no result yet (the result names its fork), or a tool-less slash candidate has an
 * `Agent`/`Task`/`Skill` call without a result (that call may be its starter). The caller defers the
 * subagent's usage until a later pass resolves it, or until the session ends (`final`), when a
 * pending subagent is left an ordinary agent. A `.meta.json` `toolUseId` proves an ordinary agent only
 * once the call it names is seen (in the main transcript or a subagent's own); an unseen id may be a
 * `Skill` call whose line is not flushed yet, so it stays pending. Ambiguity that evidence cannot lift (several
 * candidates or several `/name` lines for one prompt) is also left an agent.
 *
 * Pure reads; never throws (unreadable inputs resolve to "nothing found").
 */

import { open, readFile } from 'node:fs/promises';
import {
  EvidenceCache,
  MAX_INDEXED_KEYS,
  emptyEvidence,
  evidenceStillValid,
  identityOf,
  isValidEntry,
  readRange,
  sealEvidence,
} from './evidence-index.js';
import { plainSlashCommandName } from '../../claude/session/claude-named-invocations.js';

/** The slice of a discovered subagent file this module needs. */
export interface ForkCandidate {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  /** Set when the sidecar marker already named the skill. */
  skillName?: string;
  /**
   * Already settled by an earlier pass: its usage was derived with a scope that cannot change, so it
   * is not resolved again (no reads of its file). A settled skill fork still takes part in the
   * slash-line confirmation, with its recorded `promptId`.
   */
  settled?: boolean;
  /** The subagent's `promptId` as recorded when it settled (skips reading the file head). */
  promptId?: string;
  /** The head of its file was read completely (see `PromptHead.done`). */
  headDone?: boolean;
}

export interface ForkSkillResolution {
  /** `agentId` -> skill name, for forks the marker did not already name. */
  skillByAgentId: Map<string, string>;
  /** `promptId`s whose plain `/name` user line started a confirmed fork (marker or inferred). */
  slashPromptIds: Set<string>;
  /** Subagents that cannot yet be told from a skill fork; empty when `final`. */
  pendingAgentIds: Set<string>;
  /** With `final`: the subagents left an agent only because nothing more will arrive (no proof). */
  unprovenAgentIds: Set<string>;
}

const AGENT_ID_IN_TEXT = /"agentId":\s*"([A-Za-z0-9_-]+)"/;
/** How many leading subagent lines are searched for a `promptId`. */
const PROMPT_ID_LINES = 5;
const HEAD_BYTES = 256 * 1024;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: { skill?: unknown };
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface Line {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  promptId?: unknown;
  toolUseResult?: { agentId?: unknown } | null;
  message?: { role?: string; content?: unknown };
}

/** Everything the correlation reads out of one or more transcripts. */
interface Scan {
  toolNameById: Map<string, string>;
  skillByToolUseId: Map<string, string>;
  /** tool_use_id -> the agentId its result names ('' when it names none). */
  resultAgentIdByToolUseId: Map<string, string>;
  /** tool_use_id -> promptId of the user turn it was made in ('' when unknown). */
  promptByToolUseId: Map<string, string>;
  /** tool_use_ids whose result is an error or denial: no launch happened. */
  failedToolUseIds: Set<string>;
  slashByPrompt: Map<string, string[]>;
  /** Every promptId that has a line in the scanned transcript (main only: a flush-lag probe). */
  promptsSeen: Set<string>;
}

function newScan(): Scan {
  return {
    promptsSeen: new Set(),
    failedToolUseIds: new Set(),
    toolNameById: new Map(),
    skillByToolUseId: new Map(),
    resultAgentIdByToolUseId: new Map(),
    promptByToolUseId: new Map(),
    slashByPrompt: new Map(),
  };
}

/** The text of a tool_result `content`: a string, or the text blocks of an array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: unknown }[])
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/**
 * The agent a tool result names: the typed `toolUseResult.agentId`, else the `agentId` of a result
 * whose text is itself a JSON object (a cut-off object falls back to the pattern). Prose is never
 * searched, so text that merely mentions an id cannot name an agent.
 */
function resultAgentId(line: Line, block: Block): string {
  const typed = line.toolUseResult?.agentId;
  if (typeof typed === 'string' && typed) return typed;
  const text = resultText(block.content).trim();
  if (!text.startsWith('{')) return '';
  try {
    const id = (JSON.parse(text) as { agentId?: unknown } | null)?.agentId;
    return typeof id === 'string' ? id : '';
  } catch {
    return AGENT_ID_IN_TEXT.exec(text)?.[1] ?? '';
  }
}

/** Scans transcript text into `into`; returns the prompt in force at its end. */
function scanTranscript(raw: string, into: Scan, withSlash: boolean, startPrompt = ''): string {
  let prompt = startPrompt; // promptId of the latest user turn seen
  for (const text of raw.split('\n')) {
    if (!text.includes('"tool_use"') && !text.includes('"tool_result"') && !(withSlash && text.includes('"user"'))) {
      continue;
    }
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      continue;
    }
    const content = line.message?.content;
    if (typeof line.promptId === 'string' && line.promptId) {
      prompt = line.promptId;
      if (withSlash) into.promptsSeen.add(prompt);
    }
    if (withSlash && line.type === 'user' && !line.isMeta && !line.isSidechain) {
      const name = plainSlashCommandName(content);
      if (name && typeof line.promptId === 'string' && line.promptId) {
        into.slashByPrompt.set(line.promptId, [...(into.slashByPrompt.get(line.promptId) ?? []), name]);
      }
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        into.toolNameById.set(block.id, block.name);
        into.promptByToolUseId.set(block.id, prompt);
        const skill = block.name === 'Skill' && typeof block.input?.skill === 'string' ? block.input.skill.trim() : '';
        if (skill) into.skillByToolUseId.set(block.id, skill);
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        if (block.is_error === true) into.failedToolUseIds.add(block.tool_use_id);
        into.resultAgentIdByToolUseId.set(block.tool_use_id, resultAgentId(line, block));
      }
    }
  }
  return prompt;
}

/** The only calls a subagent's evidence can concern (a `.meta.json` `toolUseId` names one of them). */
const INDEXED_TOOLS = new Set(['Skill', ...AGENT_TOOLS]);

/**
 * Read one subagent transcript's call/result evidence into `scan`, through the persistent index when
 * it can be trusted (see `evidence-index.ts`): an unchanged file costs ~1 KiB of reads, a grown one only
 * its new bytes up to the last complete line, whose prompt context is carried across the boundary. A
 * trailing partial line is scanned for this pass only and never indexed. Without a usable index (no
 * cache, start prompt not known yet, any I/O or format problem) it is the plain full read.
 */
async function scanSubagentFile(file: ForkCandidate, scan: Scan, cache?: EvidenceCache): Promise<void> {
  const head = file.settled
    ? { promptId: file.promptId ?? '', done: !!(file.promptId || file.headDone) }
    : await probePromptHead(file.filePath);
  // A start prompt that is not final yet would be baked into the carried context: do not index.
  if (cache && (head.promptId || head.done)) {
    try {
      await scanIndexed(file.filePath, head.promptId, scan, cache);
      return;
    } catch {
      cache.drop(file.filePath);
    }
  }
  scanTranscript(await readText(file.filePath), scan, false, head.promptId);
}

async function scanIndexed(filePath: string, start: string, scan: Scan, cache: EvidenceCache): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const now = identityOf(await handle.stat({ bigint: true }));
    const size = now.size;
    let ev = await cache.get(filePath);
    if (ev && (!isValidEntry(ev) || ev.start !== start || !(await evidenceStillValid(handle, ev, now)))) ev = undefined;
    const base = ev ?? emptyEvidence(start);
    const previousOffset = base.offset;
    const region = size > previousOffset ? await readRange(handle, previousOffset, size - previousOffset) : Buffer.alloc(0);
    const lastNewline = region.lastIndexOf(0x0a);
    const complete = region.subarray(0, lastNewline + 1);
    const tail = region.subarray(lastNewline + 1);
    if (complete.length > 0) {
      const delta = newScan();
      base.prompt = scanTranscript(complete.toString('utf-8'), delta, false, base.prompt);
      const others = new Set(base.others);
      for (const [id, name] of delta.toolNameById) {
        if (id === '__proto__') throw new Error('unsupported tool id');
        if (INDEXED_TOOLS.has(name)) {
          const skill = delta.skillByToolUseId.get(id);
          base.calls[id] = { n: name, p: delta.promptByToolUseId.get(id) ?? '', ...(skill ? { s: skill } : {}) };
        } else {
          others.add(id);
        }
      }
      base.others = [...others];
      // A result is kept unless its call is known to be another tool's in this file: the full scan joins
      // calls and results across all sources, so a result whose call is elsewhere (or not seen yet) stays.
      for (const [id, agentId] of delta.resultAgentIdByToolUseId) {
        if (id === '__proto__') throw new Error('unsupported tool id');
        if (others.has(id) && !Object.hasOwn(base.calls, id)) continue;
        base.results[id] = { a: agentId, ...(delta.failedToolUseIds.has(id) || base.results[id]?.e ? { e: 1 as const } : {}) };
      }
      if (Object.keys(base.calls).length + Object.keys(base.results).length + base.others.length > MAX_INDEXED_KEYS) {
        cache.drop(filePath);
        throw new Error('index too large');
      }
      base.offset += complete.length;
      await sealEvidence(handle, base, complete, previousOffset);
      base.id = now.id;
      base.size0 = now.size;
      base.mtimeNs = now.mtimeNs;
      // A file that changed while it was read is used for this pass but not remembered.
      const after = identityOf(await handle.stat({ bigint: true }));
      if (after.id === now.id && after.size === now.size && after.mtimeNs === now.mtimeNs) cache.set(filePath, base);
      else cache.drop(filePath);
    } else if (!ev) {
      cache.drop(filePath); // nothing indexable (empty / only a partial line) or an entry that no longer applies
    }
    for (const [id, call] of Object.entries(base.calls)) {
      scan.toolNameById.set(id, call.n);
      scan.promptByToolUseId.set(id, call.p);
      if (call.s) scan.skillByToolUseId.set(id, call.s);
    }
    // A tool_use of another tool only has to be "seen" (a `.meta.json` tool id is checked against it).
    for (const id of base.others) if (!scan.toolNameById.has(id)) scan.toolNameById.set(id, '');
    for (const [id, result] of Object.entries(base.results)) {
      scan.resultAgentIdByToolUseId.set(id, result.a);
      if (result.e) scan.failedToolUseIds.add(id);
    }
    if (tail.length > 0) scanTranscript(tail.toString('utf-8'), scan, false, base.prompt);
  } finally {
    await handle.close();
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

const HEAD_CHUNK = 4 * 1024;

/**
 * The head of a file: read in chunks until `lines` newlines are seen or `limit` bytes are read, so a
 * file with a short head is not read (or allocated) in full. `lines` newlines = the first `lines`
 * lines are complete. Never throws.
 */
async function readHead(
  filePath: string,
  lines: number,
  limit: number
): Promise<{ text: string; newlines: number; total: number }> {
  let handle;
  const chunks: Buffer[] = [];
  let total = 0;
  let newlines = 0;
  try {
    handle = await open(filePath, 'r');
    const chunk = Buffer.allocUnsafe(HEAD_CHUNK);
    while (total < limit && newlines < lines) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(HEAD_CHUNK, limit - total), total);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) if (chunk[i] === 0x0a) newlines++;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
    }
  } catch {
    // unreadable or missing file: whatever was read
  } finally {
    await handle?.close();
  }
  return { text: Buffer.concat(chunks).toString('utf-8'), newlines, total };
}

/** What the first lines of a subagent file say about its prompt. */
export interface PromptHead {
  promptId: string;
  /** Nothing more can be learned from the head: found, or `PROMPT_ID_LINES` complete lines without it, or the byte limit. */
  done: boolean;
  /** Bytes read; the file is unchanged since when its size still equals this (an incomplete head). */
  size: number;
}

/** The `promptId` of a subagent file from its first lines, and whether the head is final. Never throws. */
export async function probePromptHead(filePath: string): Promise<PromptHead> {
  const { text, newlines, total } = await readHead(filePath, PROMPT_ID_LINES, HEAD_BYTES);
  for (const raw of text.split('\n').slice(0, PROMPT_ID_LINES)) {
    try {
      const id = (JSON.parse(raw) as Line).promptId;
      if (typeof id === 'string' && id) return { promptId: id, done: true, size: total };
    } catch {
      // partial or malformed line — try the next one
    }
  }
  return { promptId: '', done: newlines >= PROMPT_ID_LINES || total >= HEAD_BYTES, size: total };
}

/** The `promptId` of a subagent file, from its first lines (`''` when none). */
export async function firstPromptId(filePath: string): Promise<string> {
  return (await probePromptHead(filePath)).promptId;
}

/** Longest first line searched for its newline; a longer partial line reads as "no complete line yet". */
const COMPLETE_LINE_SCAN_LIMIT = 4 * 1024 * 1024;

/**
 * False while the subagent file is missing or has no complete line yet. Only a boolean is needed, so
 * nothing is accumulated (one reused chunk) and at most {@link COMPLETE_LINE_SCAN_LIMIT} bytes are read: a
 * longer partial first line stays undecided (the safe side — it keeps the subagent pending).
 */
export async function hasCompleteLine(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const chunk = Buffer.allocUnsafe(HEAD_CHUNK);
    for (let pos = 0; pos < COMPLETE_LINE_SCAN_LIMIT; ) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(HEAD_CHUNK, COMPLETE_LINE_SCAN_LIMIT - pos), pos);
      if (bytesRead === 0) return false;
      if (chunk.subarray(0, bytesRead).includes(0x0a)) return true;
      pos += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export async function resolveForkSkills(
  mainTranscriptPath: string,
  files: readonly ForkCandidate[],
  rawTranscript?: string,
  options: { final?: boolean; evidence?: EvidenceCache } = {}
): Promise<ForkSkillResolution> {
  const result: ForkSkillResolution = {
    skillByAgentId: new Map(),
    slashPromptIds: new Set(),
    pendingAgentIds: new Set(),
    unprovenAgentIds: new Set(),
  };
  if (files.length === 0) return result;

  const raw = rawTranscript ?? (await readText(mainTranscriptPath));
  if (!raw) {
    // The main transcript is missing, unreadable or empty (the desktop app may not have flushed it
    // yet): neither a Skill result nor a `/name` line nor a starting call can be seen, so no
    // subagent that the marker has not named can be told from a skill fork. Unproven until the
    // transcript has content, or until the session ends (`final`, then an agent).
    for (const file of files) {
      if (file.skillName || file.settled) continue;
      (options.final ? result.unprovenAgentIds : result.pendingAgentIds).add(file.agentId);
    }
    return result;
  }
  const scan = newScan();
  scanTranscript(raw, scan, true);

  // A subagent's own calls (a nested Agent, a Skill fork started inside a subagent) matter to the
  // checks below; only read the subagent transcripts when some subagent still needs them.
  // (A tool id the main transcript does not show may belong to a call made inside a subagent.)
  // A settled subagent needs nothing, but its transcript is still read when another one does: it
  // may hold the parent call of that other one (a nested Agent/Skill).
  const needsCalls = files.some(
    (f) => !f.skillName && !f.settled && (!f.toolUseId || !scan.toolNameById.has(f.toolUseId))
  );
  if (needsCalls) {
    for (const file of files) await scanSubagentFile(file, scan, options.evidence);
  }

  const skillForks = new Map<string, string>(); // agentId -> skill, from a Skill result
  const startedByOtherTool = new Set<string>(); // agentIds an Agent/Task call started
  // Calls that may still be about to start (or already have started) an unidentified child: an
  // Agent/Task call with no result, or with a success naming no agent; a Skill call with no result.
  // An error/denial, or a result/meta naming the agent, closes the call. Counted per user turn.
  const openSkillCalls = new Map<string, number>();
  const openAgentCalls = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const [toolUseId, name] of scan.toolNameById) {
    const answered = scan.resultAgentIdByToolUseId.has(toolUseId);
    const agentId = scan.resultAgentIdByToolUseId.get(toolUseId) ?? '';
    const callPrompt = scan.promptByToolUseId.get(toolUseId) ?? '';
    if (name === 'Skill') {
      if (!answered) bump(openSkillCalls, callPrompt);
      else if (agentId) skillForks.set(agentId, scan.skillByToolUseId.get(toolUseId) ?? '');
    } else if (AGENT_TOOLS.has(name)) {
      if (agentId) startedByOtherTool.add(agentId);
      else if (!scan.failedToolUseIds.has(toolUseId) && !files.some((f) => f.toolUseId === toolUseId)) {
        // No result yet, or a success that names no agent: an ordinary child may exist that nothing
        // identifies. Only an error/denial (no launch) or a child whose meta names the call lifts it.
        bump(openAgentCalls, callPrompt);
      }
    }
  }
  /** Open calls that can concern a subagent of `promptId` (all of them when its prompt is unknown). */
  const openFor = (m: Map<string, number>, promptId: string): number =>
    promptId ? (m.get(promptId) ?? 0) + (m.get('') ?? 0) : [...m.values()].reduce((x, y) => x + y, 0);
  for (const [agentId, skill] of [...skillForks]) {
    if (!skill) skillForks.delete(agentId);
  }

  const candidatesByPrompt = new Map<string, ForkCandidate[]>();
  const leavePending = (file: ForkCandidate): void => {
    // At the end of the session nothing more will arrive: an unproven fork stays an agent.
    (options.final ? result.unprovenAgentIds : result.pendingAgentIds).add(file.agentId);
  };
  for (const file of files) {
    // Settled ordinary agent: scope already sent, nothing to decide and nothing to read.
    if (file.settled && !file.skillName) continue;
    const bySkillTool = (file.toolUseId && scan.skillByToolUseId.get(file.toolUseId)) || skillForks.get(file.agentId);
    if (bySkillTool) {
      if (!file.skillName) result.skillByAgentId.set(file.agentId, bySkillTool);
      continue;
    }
    // A tool id proves an ordinary agent only once the call it names is seen: a `Skill` call whose
    // line is not flushed yet (desktop lag) would otherwise be settled, irreversibly, as an agent.
    if (
      !file.skillName &&
      file.toolUseId &&
      !scan.toolNameById.has(file.toolUseId) &&
      !startedByOtherTool.has(file.agentId)
    ) {
      leavePending(file);
      continue;
    }
    if (!file.skillName && (file.toolUseId || startedByOtherTool.has(file.agentId))) continue;
    const promptId = file.settled ? (file.promptId ?? '') : await firstPromptId(file.filePath);
    const slashLine = !!promptId && scan.slashByPrompt.has(promptId);
    // The desktop app can flush a prompt's lines to the main transcript after the fork has stopped:
    // until the main transcript knows the subagent's prompt, neither a `/name` line nor a starting
    // call can be seen, so the absence of both proves nothing.
    if (!file.skillName && !promptId && !(await hasCompleteLine(file.filePath))) {
      leavePending(file);
      continue;
    }
    if (!file.skillName && promptId && !scan.promptsSeen.has(promptId)) {
      leavePending(file);
      continue;
    }
    if (file.skillName) {
      if (slashLine) candidatesByPrompt.set(promptId, [...(candidatesByPrompt.get(promptId) ?? []), file]);
      continue;
    }
    if (openFor(openSkillCalls, promptId) > 0 || (slashLine && openFor(openAgentCalls, promptId) > 0)) {
      leavePending(file);
      continue;
    }
    if (slashLine) candidatesByPrompt.set(promptId, [...(candidatesByPrompt.get(promptId) ?? []), file]);
  }

  for (const [promptId, candidates] of candidatesByPrompt) {
    const names = scan.slashByPrompt.get(promptId) ?? [];
    if (names.length !== 1 || candidates.length !== 1) continue;
    const [fork] = candidates;
    if (fork.skillName) {
      // The marker names the skill itself; the line only confirms it for the summary.
      if (fork.skillName.replace(/^\//, '') === names[0]) result.slashPromptIds.add(promptId);
    } else {
      result.skillByAgentId.set(fork.agentId, names[0]);
      result.slashPromptIds.add(promptId);
    }
  }
  return result;
}
