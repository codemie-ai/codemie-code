/**
 * Skill-fork recognition without Claude Code's `.forked-skill.marker.json` sidecar (EPMCDME-16352,
 * EPMCDME-16391).
 *
 * Some clients (the desktop app) never write the sidecar, so a forked skill looks like a plain
 * general-purpose subagent. Each fork is tied to its skill by an exact id found in the main
 * transcript — never by agent name or by how close in time it started:
 *
 * - Skill tool: the `Skill` `tool_use` (`id`, `input.skill`) whose `tool_result` names the fork
 *   (`toolUseResult.agentId`, else the `"agentId"` in the result text), or whose id is the fork's
 *   `.meta.json` `toolUseId`.
 * - Slash command: a plain user line `/name` (Claude Code writes no command wrapper for a fork)
 *   whose `promptId` is the `promptId` of exactly one subagent that no tool call started (no
 *   `toolUseId`, no `agentId` in any tool result). Zero or several candidates, or several
 *   `/name` lines for the prompt, leave the fork unresolved — a guess would mislabel an agent.
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
}

const AGENT_ID_IN_TEXT = /"agentId":\s*"([A-Za-z0-9_-]+)"/;
/** How many leading subagent lines are searched for a `promptId`. */
const PROMPT_ID_LINES = 5;
const HEAD_BYTES = 256 * 1024;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: { skill?: unknown };
  tool_use_id?: string;
  content?: unknown;
  text?: unknown;
}

interface Line {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  promptId?: unknown;
  toolUseResult?: { agentId?: unknown } | null;
  message?: { role?: string; content?: unknown };
}

function resultAgentId(line: Line, block: Block): string {
  const typed = line.toolUseResult?.agentId;
  if (typeof typed === 'string' && typed) return typed;
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
  return AGENT_ID_IN_TEXT.exec(text)?.[1] ?? '';
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
  rawTranscript?: string
): Promise<ForkSkillResolution> {
  const result: ForkSkillResolution = { skillByAgentId: new Map(), slashPromptIds: new Set() };
  if (files.length === 0) return result;

  let raw = rawTranscript;
  if (raw === undefined) {
    try {
      raw = await readFile(mainTranscriptPath, 'utf-8');
    } catch {
      return result;
    }
  }

  const skillByToolUseId = new Map<string, string>();
  const skillToolForks = new Map<string, string>(); // agentId -> skill (Skill tool result)
  const startedByOtherTool = new Set<string>(); // agentIds a non-Skill tool call started
  const toolNameById = new Map<string, string>();
  const slashByPrompt = new Map<string, string[]>();
  const results: { toolUseId: string; agentId: string }[] = [];

  for (const text of raw.split('\n')) {
    if (!text.includes('"tool_use"') && !text.includes('"user"')) continue;
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      continue;
    }
    if (line.isSidechain) continue;
    const content = line.message?.content;
    if (line.type === 'user' && !line.isMeta) {
      const name = plainSlashCommandName(content);
      if (name && typeof line.promptId === 'string' && line.promptId) {
        slashByPrompt.set(line.promptId, [...(slashByPrompt.get(line.promptId) ?? []), name]);
      }
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolNameById.set(block.id, block.name);
        const skill = block.name === 'Skill' && typeof block.input?.skill === 'string' ? block.input.skill.trim() : '';
        if (skill) skillByToolUseId.set(block.id, skill);
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const agentId = resultAgentId(line, block);
        if (agentId) results.push({ toolUseId: block.tool_use_id, agentId });
      }
    }
  }

  for (const { toolUseId, agentId } of results) {
    const skill = skillByToolUseId.get(toolUseId);
    if (skill) skillToolForks.set(agentId, skill);
    else startedByOtherTool.add(agentId);
  }

  // Slash-fork candidates: started by no tool call, grouped by the prompt that spawned them.
  const candidatesByPrompt = new Map<string, ForkCandidate[]>();
  for (const file of files) {
    const bySkillTool = (file.toolUseId && skillByToolUseId.get(file.toolUseId)) || skillToolForks.get(file.agentId);
    if (bySkillTool) {
      if (!file.skillName) result.skillByAgentId.set(file.agentId, bySkillTool);
      continue;
    }
    if (!file.skillName && (file.toolUseId || startedByOtherTool.has(file.agentId))) continue;
    const promptId = await firstPromptId(file.filePath);
    if (promptId && slashByPrompt.has(promptId)) {
      candidatesByPrompt.set(promptId, [...(candidatesByPrompt.get(promptId) ?? []), file]);
    }
  }

  for (const [promptId, candidates] of candidatesByPrompt) {
    const names = slashByPrompt.get(promptId) ?? [];
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
