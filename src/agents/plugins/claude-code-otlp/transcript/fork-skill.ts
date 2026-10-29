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
 * pending subagent is left an ordinary agent. Ambiguity that evidence cannot lift (several
 * candidates or several `/name` lines for one prompt) is also left an agent.
 *
 * Pure reads; never throws (unreadable inputs resolve to "nothing found").
 */

import { open, readFile } from 'node:fs/promises';
import { plainSlashCommandName } from '../../claude/session/claude-named-invocations.js';

/** The slice of a discovered subagent file this module needs. */
export interface ForkCandidate {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  /** Set when the sidecar marker already named the skill. */
  skillName?: string;
}

export interface ForkSkillResolution {
  /** `agentId` -> skill name, for forks the marker did not already name. */
  skillByAgentId: Map<string, string>;
  /** `promptId`s whose plain `/name` user line started a confirmed fork (marker or inferred). */
  slashPromptIds: Set<string>;
  /** Subagents that cannot yet be told from a skill fork; empty when `final`. */
  pendingAgentIds: Set<string>;
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
  slashByPrompt: Map<string, string[]>;
}

function newScan(): Scan {
  return {
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

function scanTranscript(raw: string, into: Scan, withSlash: boolean, startPrompt = ''): void {
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
    if (typeof line.promptId === 'string' && line.promptId) prompt = line.promptId;
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
        into.resultAgentIdByToolUseId.set(block.tool_use_id, resultAgentId(line, block));
      }
    }
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function firstPromptId(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString('utf-8', 0, bytesRead).split('\n').slice(0, PROMPT_ID_LINES);
    for (const raw of lines) {
      try {
        const id = (JSON.parse(raw) as Line).promptId;
        if (typeof id === 'string' && id) return id;
      } catch {
        // partial or malformed line — try the next one
      }
    }
  } catch {
    // unreadable file
  } finally {
    await handle?.close();
  }
  return '';
}

export async function resolveForkSkills(
  mainTranscriptPath: string,
  files: readonly ForkCandidate[],
  rawTranscript?: string,
  options: { final?: boolean } = {}
): Promise<ForkSkillResolution> {
  const result: ForkSkillResolution = {
    skillByAgentId: new Map(),
    slashPromptIds: new Set(),
    pendingAgentIds: new Set(),
  };
  if (files.length === 0) return result;

  const raw = rawTranscript ?? (await readText(mainTranscriptPath));
  if (!raw) return result;
  const scan = newScan();
  scanTranscript(raw, scan, true);

  // A subagent's own calls (a nested Agent, a Skill fork started inside a subagent) matter to the
  // checks below; only read the subagent transcripts when some subagent still needs them.
  const needsCalls = files.some((f) => !f.skillName && !f.toolUseId);
  if (needsCalls) {
    for (const file of files) {
      scanTranscript(await readText(file.filePath), scan, false, await firstPromptId(file.filePath));
    }
  }

  const skillForks = new Map<string, string>(); // agentId -> skill, from a Skill result
  const startedByOtherTool = new Set<string>(); // agentIds an Agent/Task call started
  // Calls that may still be about to start a fork: those with no result yet. A result of any kind
  // (an error, a denial, a completion that names no agent) closes the call. Counted per user turn.
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
      else if (!answered) bump(openAgentCalls, callPrompt);
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
    if (!options.final) result.pendingAgentIds.add(file.agentId);
  };
  for (const file of files) {
    const bySkillTool = (file.toolUseId && scan.skillByToolUseId.get(file.toolUseId)) || skillForks.get(file.agentId);
    if (bySkillTool) {
      if (!file.skillName) result.skillByAgentId.set(file.agentId, bySkillTool);
      continue;
    }
    if (!file.skillName && (file.toolUseId || startedByOtherTool.has(file.agentId))) continue;
    const promptId = await firstPromptId(file.filePath);
    const slashLine = !!promptId && scan.slashByPrompt.has(promptId);
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
