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
 *             Code) → `input.subagent_type` (e.g. "Explore", "sdlc-factory:tech-analyst")
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
  name?: string;
  input?: { skill?: unknown; subagent_type?: unknown };
  text?: unknown;
}

interface RawMessage {
  promptId?: unknown;
  isMeta?: unknown;
  message?: { role?: string; content?: unknown };
}

const COMMAND_TAG = /<command-name>([^<]+)<\/command-name>/g;
const SLASH_LINE = /^\/([A-Za-z0-9][\w:.-]*)(?:\s[\s\S]*)?$/;
const GENUINE_WRAPPER_START =
  /^\s*(?:<command-name>[^<]+<\/command-name>\s*<command-message>|<command-message>[^<]*<\/command-message>\s*<command-name>)/;

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

/**
 * Every command name (leading slash stripped) in a genuine CLI wrapper anchored at the very start
 * of `text`, or `[]` when the text does not open with `<command-name>` and `<command-message>`
 * immediately adjacent (only whitespace between), in either order — fixtures across this codebase
 * disagree on which tag Claude Code writes first, and `isLocalCommandTurn` (`orchestrator.ts`)
 * already accepts either, so this does too. Anchored — unlike `matchCommandNames` — because this
 * feeds a Turns exclusion: a typed prompt that merely quotes a wrapper mid-text (e.g. asking about
 * one), or opens with a pasted `<command-name>` tag that isn't actually paired with a
 * `<command-message>`, is real user text and must still count as a turn, not be mistaken for the
 * genuine wrapper line Claude Code writes as the entire message. Returns every name, not just the
 * first, so a caller can require all of them to agree before excluding the line — Claude Code
 * writes one command per line, but nothing here assumes that holds.
 */
export function wrappedCommandNames(text: string): string[] {
  if (!GENUINE_WRAPPER_START.test(text)) return [];
  const names: string[] = [];
  COMMAND_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_TAG.exec(text)) !== null) {
    const cmd = match[1].replace(/^\//, '').trim();
    if (cmd) names.push(cmd);
  }
  return names;
}

/**
 * Extract skill / agent / command name counts from a flat list of Claude messages.
 * Safe against missing or malformed fields — anything that isn't a recognized shape is skipped.
 */
export function extractNamedInvocations(messages: readonly unknown[]): NamedInvocationCounts {
  const { skillInvocations, agentInvocations, commandInvocations } =
    extractOrderedNamedInvocations(messages);
  return { skillInvocations, agentInvocations, commandInvocations };
}

/**
 * Same extraction as {@link extractNamedInvocations}, additionally keeping the slash commands in
 * the order they were invoked (repeats kept, no leading slash).
 */
export function extractOrderedNamedInvocations(
  messages: readonly unknown[],
  forkedSlashPromptIds?: ReadonlySet<string>
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
