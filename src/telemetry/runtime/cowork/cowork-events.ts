/**
 * Plugin events of a Claude Desktop Cowork session, built from the lines of its inner transcript (the Claude Code
 * transcript Cowork writes beside `audit.jsonl`) and of its subagent files. Pure: lines and the session's event
 * state in, wire events out; the state is updated in place so the next batch continues where this one ended.
 */

import { boundedText, TEXT_FIELD_LIMITS, UNMASKED_FIELD_KEYS } from '@/agents/core/OtlpAgentAdapter.js';
import { stripPastedContentTags } from '@/agents/core/pasted-content.js';
import { isCountedTranscriptLine, keepFirstByUuid } from '@/agents/plugins/claude/session/transcript-lines.js';
import { buildClaudeEventId } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.event-id.js';
import { resolveForkAgentFields, resolveToolContextFields } from '@/agents/plugins/claude-code-otlp/event-fields/tool-fields.js';
import {
  collectEditLineStats,
  isGenuineUserTurn,
  isSelfWrittenUserText,
  type SignalLine,
  userLineText,
} from '@/agents/plugins/claude-code-otlp/transcript/session-signals.js';
import { maskSecretsDeep } from '@/utils/security.js';

/** What the event builders remember about one session between batches; kept in the producer's cursor. */
export interface CoworkEventState {
  /** `uuid`s of the counted lines already read, so a line Claude Code writes again is not counted twice. */
  seenUuids: string[];
  /** Tool calls whose result has not been read yet: `tool_use_id` -> `tool_name`. */
  openTools: Record<string, string>;
  /**
   * `tool_use_id`s of `Agent` / `Task` / `Skill` calls whose result was read. A background call's launch answer
   * (`status: 'async_launched'`) is not its result: such an agent is stopped at the session's end.
   */
  agentResults: string[];
  subagents: Record<string, { firstAt?: string; lastAt?: string; started?: boolean; stopped?: boolean }>;
  sessionStarted: boolean;
  /** Time of the latest line read of the session, main transcript and subagent files alike; `''` before the first one. */
  lastLineAt: string;
  entrypoint: string;
  clientVersion: string;
}

export interface CoworkSubagentInput {
  agentId: string;
  agentType?: string;
  toolUseId?: string;
  skillName?: string;
  /** Still possibly a skill fork: its start waits until it is resolved, so the start can name the skill. */
  pending?: boolean;
  lines: string[];
}

export interface CoworkTranscriptInput {
  sessionId: string;
  main: string[];
  subagents: CoworkSubagentInput[];
  /** Lines older than this give no event (a session read without a cursor); `-Infinity` reads every line. */
  windowStartMs: number;
  /** The session ends: every started subagent is stopped and `agent.session.end` closes the batch. */
  end: boolean;
}

/** The session-level fields every wire event carries. */
export interface CoworkEnvelope {
  sessionId: string;
  project: string;
  repository: string;
  repoRemote?: string;
  cliVersion: string;
  title?: string;
  entrypoint: string;
  clientVersion: string;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  isError?: boolean;
}

interface CoworkLine extends SignalLine {
  uuid?: string;
  gitBranch?: string;
  entrypoint?: string;
  promptId?: string;
}

type WireEvent = Record<string, unknown>;

const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);
/** Events that carry the session title. */
const TITLED_TYPES = new Set(['agent.session.start', 'agent.prompt.submit']);

export function emptyCoworkEventState(): CoworkEventState {
  return {
    seenUuids: [],
    openTools: {},
    agentResults: [],
    subagents: {},
    sessionStarted: false,
    lastLineAt: '',
    entrypoint: '',
    clientVersion: '',
  };
}

function eventId(type: string, sessionId: string, key: string): string {
  return `${type}:${sessionId}:${key}`;
}

function parseLine(raw: string): CoworkLine | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CoworkLine) : null;
  } catch {
    return null;
  }
}

function contentBlocks(line: CoworkLine): ContentBlock[] {
  const content = line.message?.content;
  return Array.isArray(content) ? content.filter((block): block is ContentBlock => typeof block === 'object' && block !== null) : [];
}

function lineBranch(line: CoworkLine): { git_branch?: string } {
  return typeof line.gitBranch === 'string' && line.gitBranch ? { git_branch: line.gitBranch } : {};
}

function lineTime(line: CoworkLine): string {
  return typeof line.timestamp === 'string' && Number.isFinite(Date.parse(line.timestamp)) ? line.timestamp : '';
}

function readAgentId(toolUseResult: unknown): string {
  const agentId = toolUseResult && typeof toolUseResult === 'object' ? (toolUseResult as Record<string, unknown>)['agentId'] : undefined;
  return typeof agentId === 'string' ? agentId : '';
}

function isBackgroundLaunch(toolUseResult: unknown): boolean {
  return Boolean(toolUseResult && typeof toolUseResult === 'object' && (toolUseResult as Record<string, unknown>)['status'] === 'async_launched');
}

/**
 * Tool events of one line: `agent.tool.start` per `tool_use` block of an assistant line, `agent.tool.end` (or
 * `agent.tool.error`) per `tool_result` block of a user line whose call is known. Only names, ids, paths, line counts
 * and a dispatched agent's id are sent, never input, output or error text.
 */
function toolEvents(line: CoworkLine, sessionId: string, state: CoworkEventState, scope: WireEvent): WireEvent[] {
  const events: WireEvent[] = [];
  const timestamp = lineTime(line);
  for (const block of contentBlocks(line)) {
    if (line.type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
      state.openTools[block.id] = block.name;
      const { file_path, subagent_type, skill_name } = resolveToolContextFields(block.name, block.input);
      events.push({
        type: 'agent.tool.start',
        timestamp,
        tool_name: block.name,
        tool_use_id: block.id,
        ...(file_path && { file_path }),
        ...(subagent_type && { subagent_type }),
        ...(skill_name && { skill_name }),
        ...scope,
        event_id: eventId('agent.tool.start', sessionId, block.id),
      });
      continue;
    }
    const toolName = line.type === 'user' && block.type === 'tool_result' && block.tool_use_id ? state.openTools[block.tool_use_id] : undefined;
    if (!toolName || !block.tool_use_id) continue;
    const toolUseId = block.tool_use_id;
    delete state.openTools[toolUseId];
    if ((toolName === 'Skill' || AGENT_DISPATCH_TOOLS.has(toolName)) && !isBackgroundLaunch(line.toolUseResult)) {
      state.agentResults.push(toolUseId);
    }
    if (block.is_error === true || block.isError === true) {
      events.push({
        type: 'agent.tool.error',
        timestamp,
        tool_name: toolName,
        tool_use_id: toolUseId,
        ...scope,
        event_id: eventId('agent.tool.error', sessionId, toolUseId),
      });
      continue;
    }
    const { linesAdded, linesRemoved } = collectEditLineStats([line]);
    const fork = toolName === 'Skill' ? resolveForkAgentFields('Skill', line.toolUseResult) : {};
    const namedAgent = toolName === 'Skill' ? fork.fork_agent_id ?? '' : AGENT_DISPATCH_TOOLS.has(toolName) ? readAgentId(line.toolUseResult) : '';
    events.push({
      type: 'agent.tool.end',
      timestamp,
      tool_name: toolName,
      tool_use_id: toolUseId,
      ...(typeof linesAdded === 'number' && typeof linesRemoved === 'number' && { lines_added: linesAdded, lines_removed: linesRemoved }),
      ...fork,
      ...(namedAgent && { tool_response: JSON.stringify({ agentId: namedAgent }) }),
      ...scope,
      event_id: eventId('agent.tool.end', sessionId, toolUseId),
    });
  }
  return events;
}

/**
 * The counted, not yet seen lines of one file, each with its time. A line without a time, or older than the window,
 * is consumed without an event.
 */
function freshLines(rawLines: string[], state: CoworkEventState, seen: Set<string>): CoworkLine[] {
  const lines: CoworkLine[] = [];
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (!line || !isCountedTranscriptLine(line) || keepFirstByUuid([line], seen).length === 0) continue;
    if (typeof line.entrypoint === 'string' && line.entrypoint) state.entrypoint = line.entrypoint;
    if (typeof line.version === 'string' && line.version) state.clientVersion = line.version;
    lines.push(line);
  }
  return lines;
}

/** Moves the session's last line time forward only: a subagent line can be older than a main line already read. */
function advanceLastLineAt(state: CoworkEventState, time: string): void {
  if (time && (!state.lastLineAt || Date.parse(time) > Date.parse(state.lastLineAt))) state.lastLineAt = time;
}

function inWindow(time: string, windowStartMs: number): boolean {
  return time !== '' && Date.parse(time) >= windowStartMs;
}

/**
 * The producer's own events of one batch, in order: `agent.session.start` (once per session), then the main
 * transcript's prompts and tool events, then per subagent its `agent.subagent.start` and tool events, then the
 * `agent.subagent.stop`s now due, then `agent.session.end` when the session ends and its start was built. The
 * session start, the prompts and the tool events carry their line's `gitBranch` as `git_branch`. Each `event_id` is
 * `<type>:<session_id>:<key>`, so a batch read again gives the same ids.
 */
export function buildCoworkEvents(input: CoworkTranscriptInput, state: CoworkEventState): WireEvent[] {
  const { sessionId, windowStartMs } = input;
  const seen = new Set(state.seenUuids);
  const events: WireEvent[] = [];

  for (const line of freshLines(input.main, state, seen)) {
    const timestamp = lineTime(line);
    advanceLastLineAt(state, timestamp);
    if (!inWindow(timestamp, windowStartMs)) continue;
    const branch = lineBranch(line);
    if (!state.sessionStarted) {
      state.sessionStarted = true;
      events.push({ type: 'agent.session.start', timestamp, ...branch, event_id: eventId('agent.session.start', sessionId, 'start') });
    }
    if (isGenuineUserTurn(line) && typeof line.uuid === 'string') {
      const text = userLineText(line);
      if (!isSelfWrittenUserText(text)) {
        events.push({
          type: 'agent.prompt.submit',
          timestamp,
          prompt_body: stripPastedContentTags(text),
          ...(typeof line.promptId === 'string' && line.promptId && { prompt_id: line.promptId }),
          ...branch,
          event_id: eventId('agent.prompt.submit', sessionId, line.uuid),
        });
      }
    }
    events.push(...toolEvents(line, sessionId, state, branch));
  }

  for (const subagent of input.subagents) {
    const known = (state.subagents[subagent.agentId] ??= {});
    const lineEvents: WireEvent[] = [];
    for (const line of freshLines(subagent.lines, state, seen)) {
      const timestamp = lineTime(line);
      if (timestamp) known.lastAt = timestamp;
      advanceLastLineAt(state, timestamp);
      if (!inWindow(timestamp, windowStartMs)) continue;
      known.firstAt ??= timestamp;
      lineEvents.push(...toolEvents(line, sessionId, state, {
        agent_id: subagent.agentId,
        ...(subagent.agentType && { agent_type: subagent.agentType }),
        ...lineBranch(line),
      }));
    }
    if (subagent.agentType && !known.started && known.firstAt && (!subagent.pending || input.end)) {
      known.started = true;
      events.push(subagentEvent('agent.subagent.start', sessionId, subagent, known.firstAt));
    }
    events.push(...lineEvents);
  }

  for (const subagent of input.subagents) {
    const known = state.subagents[subagent.agentId];
    const resultRead = subagent.toolUseId !== undefined && state.agentResults.includes(subagent.toolUseId);
    if (known.started && !known.stopped && known.lastAt && (input.end || resultRead)) {
      known.stopped = true;
      events.push(subagentEvent('agent.subagent.stop', sessionId, subagent, known.lastAt));
    }
  }

  if (input.end && state.lastLineAt && state.sessionStarted) {
    events.push({
      type: 'agent.session.end',
      timestamp: state.lastLineAt,
      event_id: eventId('agent.session.end', sessionId, state.lastLineAt),
    });
  }

  state.seenUuids = [...seen];
  return events;
}

function subagentEvent(type: string, sessionId: string, subagent: CoworkSubagentInput, timestamp: string): WireEvent {
  return {
    type,
    timestamp,
    agent_id: subagent.agentId,
    agent_type: subagent.agentType,
    ...(subagent.toolUseId && { tool_use_id: subagent.toolUseId }),
    ...(subagent.skillName && { skill_name: subagent.skillName }),
    event_id: eventId(type, sessionId, subagent.agentId),
  };
}

/**
 * The wire form of one event, the producer's or the transcript orchestrator's: the envelope under the event's own
 * fields, every string masked with the hook path's rules, every field of `TEXT_FIELD_LIMITS` cut to its limit and
 * `prompt_body` cut to the prompt limit. An
 * event without an `event_id` (the orchestrator's) gets the one the Claude Code hook path gives it; `timestamp`
 * falls back to `fallbackTimestamp` when the event has none.
 */
export function stampCoworkEvent(event: WireEvent, envelope: CoworkEnvelope, fallbackTimestamp: string): WireEvent {
  const { event_id: ownId, ...own } = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
  const masked = maskSecretsDeep({
    session_id: envelope.sessionId,
    schema_version: 2,
    platform: 'claude-code',
    entrypoint: envelope.entrypoint,
    client_version: envelope.clientVersion,
    codemie_cli_version: envelope.cliVersion,
    cwd: envelope.repository,
    ...(envelope.repoRemote && { repo_remote: envelope.repoRemote }),
    ...(envelope.project && { codemie_project_name: envelope.project }),
    ...(envelope.title && TITLED_TYPES.has(String(own['type'])) && { session_title: envelope.title }),
    ...own,
    timestamp: own['timestamp'] || fallbackTimestamp,
  }, UNMASKED_FIELD_KEYS) as WireEvent;
  for (const [field, maxChars] of Object.entries(TEXT_FIELD_LIMITS)) {
    if (Object.prototype.hasOwnProperty.call(masked, field)) masked[field] = boundedText(masked[field], maxChars);
  }
  if (typeof masked['prompt_body'] === 'string') {
    masked['prompt_body'] = boundedText(masked['prompt_body'], TEXT_FIELD_LIMITS['prompt']);
  }
  const payload = Object.fromEntries(Object.keys(own).map((key) => [key, masked[key]]));
  masked['event_id'] = typeof ownId === 'string' ? ownId : buildClaudeEventId(masked, payload, String(masked['timestamp']));
  return masked;
}
