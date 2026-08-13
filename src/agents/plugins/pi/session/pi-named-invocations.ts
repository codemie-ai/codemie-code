/**
 * Shared Pi named-invocation extraction.
 *
 * Pulls the *names* of invoked skills and subagents out of Pi session JSONL entries, so
 * the analytics report shows the same per-name breakdown Claude and Codex already do.
 *
 * - Skills:   the `<skill name="..." location="...">` wrapper Pi prepends to the user
 *             message when a `/skill:<name>` command expands (upstream
 *             `core/agent-session.ts` builds it, and parses it back with the same shape).
 * - Agents:   an assistant `toolCall` named `subagent`, from the `pi-subagents` package
 *             this plugin installs. The child's name is `arguments.agent`.
 * - Commands: always empty here. Pi expands a prompt template into plain user text before
 *             persisting it, so `/review` never reaches the JSONL and no regex over the
 *             transcript can recover it. Those counts come from the run ledger, which the
 *             CodeMie extension records from inside Pi at input time.
 *
 * @see ../pi.extension.ts — PiRunLedger.commandInvocations
 */

import { logger } from '@/utils/logger.js';
import type { NamedInvocationCounts } from '../../claude/session/claude-named-invocations.js';
import {
  extractPiToolCalls,
  isPiAssistantMessage,
  isPiMessageEntry,
  isPiUserMessage,
  type PiEntry,
  type PiUserMessage,
} from '../pi.types.js';

export type { NamedInvocationCounts };

/** Name of the tool `pi-subagents` registers for delegating to a child agent. */
const SUBAGENT_TOOL = 'subagent';

/**
 * The opening of Pi's skill wrapper, which only Pi itself writes (`_expandSkillCommand` in
 * `core/agent-session.ts`). Group 1 is the skill name.
 *
 * Matching it is also what makes {@link parseSkillWrapper} fail closed: once the opening is
 * there the text is a skill file's body, so a wrapper this parser cannot finish reading is
 * dropped. That costs one prompt title; returning it would upload a private file.
 */
const SKILL_WRAPPER_OPENING = /^<skill name="([^"]+)" location="[^"]+">\n/;

/**
 * The line that closes the wrapper. Pi writes it on a line of its own, so the leading
 * newline is part of the delimiter.
 */
const SKILL_WRAPPER_CLOSING = '\n</skill>';

/**
 * `agent: "<name>"` inside a `workflowScript`. The script is an opaque JavaScript string
 * (`await runs.run(key, { agent, task })`), not a structured step list, so this is the
 * only handle on the children it launches. It counts one invocation per launch site:
 * a script that loops over the same site undercounts, and a computed agent name is
 * missed entirely. Both are preferable to attributing a workflow to no agent at all.
 */
const WORKFLOW_AGENT = /\bagent\s*:\s*(['"`])([^'"`\n]+)\1/g;

/**
 * The one `action` that launches a child rather than managing a record.
 *
 * `pi-subagents` rejects a `schedule.create` that does not name exactly one target —
 * `agent` (with an optional `task`) or a `workflowScript` — and arms it to run later
 * (`runs/background/scheduled-runs.ts`, `sanitizeTarget`). The launch is counted here, at
 * the call that asked for it, because the firings themselves happen outside any CodeMie
 * session and would otherwise be attributed to nothing. `schedule.run`/`schedule.run-due`
 * stay management: they address an existing schedule by id and carry no agent name.
 */
const DEFERRED_LAUNCH_ACTION = 'schedule.create';

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

export interface PiSkillWrapper {
  /** Skill name from the wrapper, or undefined when the text carries no wrapper. */
  name?: string;
  /** The prompt the user typed after the wrapper, or the original text when there was none. */
  rest: string;
}

/**
 * Split Pi's `<skill>` wrapper off a user text block.
 *
 * Single source of truth for the wrapper shape: the metrics processor consumes `rest`
 * so the skill body is not reported as a user prompt, and the extractor below consumes
 * `name`.
 *
 * The closing line is searched for from the END of the text, because the body between the
 * wrapper's tags is a file the user wrote and may contain `</skill>` lines of its own — a
 * skill documenting Pi's own format does. Everything after the LAST closing line, on the
 * other hand, can only be the arguments the user typed: the real closer always leaves a
 * well-formed tail behind it, so no closer after it exists to be picked instead.
 *
 * Anything else fails closed with no name and no text. `rest` leaves the machine — it is
 * uploaded as the user's prompt and titles the analytics session — so a wrapper this parser
 * cannot read unambiguously must cost a title rather than a private file's contents.
 */
export function parseSkillWrapper(text: string): PiSkillWrapper {
  const opening = SKILL_WRAPPER_OPENING.exec(text);
  if (!opening) {
    return { rest: text };
  }

  // The opening's own trailing newline can double as the closing line's leading one, for a
  // wrapper around an empty body. Nothing before that is part of the wrapper.
  const earliestClosing = opening[0].length - 1;
  for (
    let closing = text.lastIndexOf(SKILL_WRAPPER_CLOSING);
    closing >= earliestClosing;
    closing = text.lastIndexOf(SKILL_WRAPPER_CLOSING, closing - 1)
  ) {
    // Upstream appends `\n\n<args>` only when the `/skill:<name>` invocation carried
    // arguments, so a well-formed tail is either nothing at all or exactly that.
    const tail = text.slice(closing + SKILL_WRAPPER_CLOSING.length);
    if (tail === '') {
      return { name: opening[1], rest: '' };
    }
    const args = tail.startsWith('\n\n') ? tail.slice(2).trim() : '';
    if (args) {
      return { name: opening[1], rest: args };
    }
  }

  // Name only: the body is exactly what must not be logged. Without this line a change to
  // Pi's wrapper would zero prompts and skill counts at once, silently.
  logger.debug('[pi-skills] Unreadable skill wrapper; dropping the text', { skill: opening[1] });
  return { rest: '' };
}

/** Every text block carried by a user message, whatever content shape Pi used. */
function userTextBlocks(message: PiUserMessage): string[] {
  if (typeof message.content === 'string') {
    return [message.content];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const texts: string[] = [];
  for (const part of message.content) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: string; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      texts.push(typed.text);
    }
  }
  return texts;
}

/**
 * Child agent names launched by one `subagent` tool call.
 *
 * A call carrying `action` is management or control (`status`, `stop`, `create`, ...);
 * its `agent` names the record being managed, not a child being run, so it counts
 * nothing. {@link DEFERRED_LAUNCH_ACTION} is the exception.
 */
function subagentNames(args: Record<string, unknown> | undefined): string[] {
  if (!args || typeof args !== 'object') {
    return [];
  }
  if (typeof args.action === 'string') {
    const action = args.action.trim();
    if (action && action !== DEFERRED_LAUNCH_ACTION) {
      return [];
    }
  }

  const names: string[] = [];

  const single = args.agent;
  if (typeof single === 'string' && single.trim()) {
    names.push(single.trim());
  }

  const script = args.workflowScript;
  if (typeof script === 'string') {
    WORKFLOW_AGENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORKFLOW_AGENT.exec(script)) !== null) {
      const name = match[2].trim();
      if (name) names.push(name);
    }
  }

  return names;
}

/**
 * Extract skill and agent name counts from Pi session entries.
 *
 * Safe against missing or malformed fields — anything that is not a recognized shape is
 * skipped. `commandInvocations` is always empty; see the module comment.
 */
export function extractPiNamedInvocations(entries: readonly unknown[]): NamedInvocationCounts {
  const skillInvocations: Record<string, number> = {};
  const agentInvocations: Record<string, number> = {};

  for (const raw of entries) {
    const entry = raw as PiEntry;
    if (!isPiMessageEntry(entry)) {
      continue;
    }
    const message = entry.message;

    if (isPiUserMessage(message)) {
      for (const text of userTextBlocks(message)) {
        const { name } = parseSkillWrapper(text);
        if (name) bump(skillInvocations, name);
      }
      continue;
    }

    if (isPiAssistantMessage(message)) {
      for (const toolCall of extractPiToolCalls(message)) {
        if (toolCall.name !== SUBAGENT_TOOL) continue;
        for (const agent of subagentNames(toolCall.arguments)) {
          bump(agentInvocations, agent);
        }
      }
    }
  }

  return { skillInvocations, agentInvocations, commandInvocations: {} };
}
