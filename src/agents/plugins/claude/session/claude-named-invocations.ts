/**
 * Shared Claude named-invocation extraction.
 *
 * Single source of truth for pulling the *names* of invoked skills, agent subtypes, and slash
 * commands out of a flat list of Claude messages. Used by both the live {@link MetricsProcessor}
 * and the session adapter's parse path (`extractMetrics`), so re-parsed (native, untracked)
 * sessions report the same named invocations as live-tracked ones.
 *
 * - Skills:   `tool_use` block with `name === 'Skill'` → `input.skill` (e.g. "codemie:msgraph")
 * - Agents:   `tool_use` block with `name === 'Agent'` (this CLI) or `'Task'` (standard Claude
 *             Code) → `input.subagent_type` (e.g. "Explore", "sdlc-factory:tech-analyst").
 *             Counted only once its `tool_result` has arrived and is not an error: a denied,
 *             rejected or failed call never started an agent, and a call still waiting for its
 *             result could turn out to be denied with nothing left to subtract it. A call with
 *             no `id` cannot be matched to a result and is counted. See {@link collectToolOutcomes}.
 * - Commands: user message whose text carries the Claude CLI slash-command wrapper. A genuine
 *   invocation always includes a `<command-message>` sibling alongside `<command-name>`; we
 *   require it so documentation/prose that merely mentions `<command-name>` is not miscounted.
 *   Command text can be a plain string or a text content block.
 */

/** Count maps for each named-invocation dimension. Keys are names, values are counts. */
export interface NamedInvocationCounts {
  skillInvocations: Record<string, number>;
  agentInvocations: Record<string, number>;
  commandInvocations: Record<string, number>;
}

/** {@link NamedInvocationCounts} plus the slash commands in call order, repeats kept. */
export interface OrderedNamedInvocations extends NamedInvocationCounts {
  commandsInOrder: string[];
}

interface RawBlock {
  type?: string;
  id?: unknown;
  name?: string;
  input?: { skill?: unknown; subagent_type?: unknown };
  text?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  isError?: unknown;
}

interface RawMessage {
  promptId?: unknown;
  isMeta?: unknown;
  message?: { role?: string; content?: unknown };
}

const COMMAND_TAG = /<command-name>([^<]+)<\/command-name>/g;
const SLASH_LINE = /^\/([A-Za-z0-9][\w:.-]*)(?:\s[\s\S]*)?$/;

/**
 * The name in a typed `/name [args]` user prompt (a lone string or text block), or `''`. A wrapper
 * line (`<command-message>`) is not plain, and neither is prose that merely contains a slash.
 * Alone this proves nothing about the name; callers must have independent evidence it started a run.
 */
export function plainSlashCommandName(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const blocks = content as RawBlock[];
    if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') return '';
    text = blocks[0].text;
  }
  if (!text || text.includes('<command-message>')) return '';
  return SLASH_LINE.exec(text.trim())?.[1] ?? '';
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

/** How a tool call ended: its result succeeded, or carried an `is_error`/`isError` flag. */
export type ToolOutcome = 'ok' | 'failed';

/**
 * The outcome of every tool call that has a `tool_result`, by `tool_use_id`, across the whole
 * message list. Claude Code reports a denied (hook, permission prompt, classifier) or failed tool
 * call with an error flag, so a `failed` call never ran. A call with no entry has no result yet.
 * When one id has several results, `failed` wins. Build it from the FULL transcript: the result
 * sits in a later message than its call, and callers that count a slice of messages would
 * otherwise miss it.
 */
export function collectToolOutcomes(messages: readonly unknown[]): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const raw of messages) {
    const content = (raw as RawMessage | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as RawBlock[]) {
      if (item?.type !== 'tool_result' || typeof item.tool_use_id !== 'string') continue;
      const failed = item.is_error === true || item.isError === true;
      if (failed || !outcomes.has(item.tool_use_id)) {
        outcomes.set(item.tool_use_id, failed ? 'failed' : 'ok');
      }
    }
  }
  return outcomes;
}

/** The `tool_use_id`s whose result carried an error flag (see {@link collectToolOutcomes}). */
export function collectFailedToolUseIds(messages: readonly unknown[]): Set<string> {
  const failed = new Set<string>();
  for (const [id, outcome] of collectToolOutcomes(messages)) {
    if (outcome === 'failed') failed.add(id);
  }
  return failed;
}

/**
 * Extract skill / agent / command name counts from a flat list of Claude messages.
 * Safe against missing or malformed fields — anything that isn't a recognized shape is skipped.
 * When `toolOutcomes` (see {@link collectToolOutcomes}) is given, an `Agent`/`Task` call with an id
 * is counted only if its result has arrived and succeeded; without it every call is counted.
 */
export function extractNamedInvocations(
  messages: readonly unknown[],
  toolOutcomes?: ReadonlyMap<string, ToolOutcome>
): NamedInvocationCounts {
  const { skillInvocations, agentInvocations, commandInvocations } =
    extractOrderedNamedInvocations(messages, undefined, toolOutcomes);
  return { skillInvocations, agentInvocations, commandInvocations };
}

/**
 * Same extraction as {@link extractNamedInvocations}, additionally keeping the slash commands in
 * the order they were invoked (repeats kept, no leading slash).
 */
export function extractOrderedNamedInvocations(
  messages: readonly unknown[],
  forkedSlashPromptIds?: ReadonlySet<string>,
  toolOutcomes?: ReadonlyMap<string, ToolOutcome>
): OrderedNamedInvocations {
  const skillInvocations: Record<string, number> = {};
  const agentInvocations: Record<string, number> = {};
  const commandInvocations: Record<string, number> = {};
  const commandsInOrder: string[] = [];

  // The command names in a text payload, but only when it carries the CLI's `<command-message>`
  // sibling — that distinguishes a real invocation from prose that merely quotes `<command-name>`
  // (e.g. docs, specs, this very file). Pure: callers decide what to do with the names.
  const matchCommandNames = (text: string): string[] => {
    if (!text.includes('<command-message>')) {
      return [];
    }
    const names: string[] = [];
    COMMAND_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMAND_TAG.exec(text)) !== null) {
      const cmd = match[1].replace(/^\//, '').trim();
      if (cmd) names.push(cmd);
    }
    return names;
  };

  for (const raw of messages) {
    const msg = raw as RawMessage;
    const content = msg?.message?.content;
    const isUser = msg?.message?.role === 'user';

    // A forked skill run as `/name` is a plain user line with no wrapper. The caller vouches for
    // the prompts that started a fork; the line is the command, counted once, in order.
    if (isUser && !msg.isMeta && typeof msg.promptId === 'string' && forkedSlashPromptIds?.has(msg.promptId)) {
      const cmd = plainSlashCommandName(content);
      if (cmd) {
        bump(commandInvocations, cmd);
        commandsInOrder.push(cmd);
      }
    }

    // Real slash commands arrive as plain string content (the CLI shape).
    if (typeof content === 'string') {
      if (isUser) {
        for (const cmd of matchCommandNames(content)) {
          bump(commandInvocations, cmd);
          commandsInOrder.push(cmd);
        }
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content as RawBlock[]) {
      if (item?.type === 'tool_use') {
        if (item.name === 'Skill' && typeof item.input?.skill === 'string') {
          const skill = item.input.skill.trim();
          if (skill) bump(skillInvocations, skill);
        } else if (
          (item.name === 'Agent' || item.name === 'Task') &&
          typeof item.input?.subagent_type === 'string'
        ) {
          // Count the launch only once it is known to have run: a denied/errored call never
          // started an agent, and a call with no result yet may still be denied (nothing could
          // subtract it later). A call without an id cannot be matched to a result and counts.
          if (toolOutcomes && typeof item.id === 'string' && toolOutcomes.get(item.id) !== 'ok') continue;
          const subtype = item.input.subagent_type.trim();
          if (subtype) bump(agentInvocations, subtype);
        }
      } else if (isUser && item?.type === 'text' && typeof item.text === 'string') {
        for (const cmd of matchCommandNames(item.text)) {
          bump(commandInvocations, cmd);
          commandsInOrder.push(cmd);
        }
      }
    }
  }

  return { skillInvocations, agentInvocations, commandInvocations, commandsInOrder };
}
