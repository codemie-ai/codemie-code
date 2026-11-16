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
  isSidechain?: unknown;
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

/**
 * The single command name (leading slash stripped) in a genuine CLI wrapper within `text`, or
 * `''` when `text` carries no `<command-name>` tag with its required `<command-message>` sibling.
 * Same genuine-wrapper rule as `scanCommands`; only the first match is returned.
 */
export function wrappedCommandName(text: string): string {
  if (!text.includes('<command-message>')) return '';
  COMMAND_TAG.lastIndex = 0;
  const match = COMMAND_TAG.exec(text);
  return match ? match[1].replace(/^\//, '').trim() : '';
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

  // A user-role message that is purely the mechanical tool_result passback for a prior tool_use
  // — not a new user-authored turn, so it must not end the `nextSkillName` scan below.
  const isToolResultOnlyMessage = (msg: RawMessage): boolean => {
    if (msg?.message?.role !== 'user') return false;
    const content = msg.message.content;
    if (!Array.isArray(content) || content.length === 0) return false;
    return (content as RawBlock[]).every((item) => item?.type === 'tool_result');
  };

  // The skill a slash command dispatched to, when the model resolves the same turn (skipping any
  // isMeta/isSidechain bookkeeping lines, and any prep tool_use/tool_result round-trips the skill's
  // own instructions triggered first) by calling the matching `Skill` tool — the seam EPMCDME-17201
  // covers: such a command is counted once, as the skill, not also as a command. The scan stops the
  // moment a genuine new user-authored message appears (not a tool_result passback): anything after
  // that boundary belongs to a different turn and must never be attributed back to this command.
  const nextSkillName = (fromIndex: number): string => {
    for (let j = fromIndex; j < messages.length; j++) {
      const msg = messages[j] as RawMessage;
      if (msg?.isMeta || msg?.isSidechain) continue;
      const role = msg?.message?.role;
      // A line with no message field at all (e.g. a `compact_boundary` system line) is bookkeeping,
      // not a turn boundary — skip it exactly like isMeta/isSidechain rather than bailing.
      if (role == null) continue;
      if (role === 'user') {
        if (isToolResultOnlyMessage(msg)) continue;
        return '';
      }
      if (role !== 'assistant') return '';
      const content = msg.message?.content;
      if (!Array.isArray(content)) return '';
      for (const item of content as RawBlock[]) {
        if (item?.type === 'tool_use' && item.name === 'Skill' && typeof item.input?.skill === 'string') {
          const skill = item.input.skill.trim();
          if (skill) return skill;
        }
      }
      // No Skill call in this assistant message — it may have called a different tool first
      // (e.g. Read/Bash); keep scanning for the Skill call the round-trip leads to.
    }
    return '';
  };

  const recordCommand = (cmd: string, fromIndex: number): void => {
    const skillAhead = nextSkillName(fromIndex);
    if (skillAhead && skillAhead.replace(/^\//, '') === cmd) return;
    bump(commandInvocations, cmd);
    commandsInOrder.push(cmd);
  };

  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
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
      if (isUser) for (const cmd of matchCommandNames(content)) recordCommand(cmd, i + 1);
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
        for (const cmd of matchCommandNames(item.text)) recordCommand(cmd, i + 1);
      }
    }
  }

  return { skillInvocations, agentInvocations, commandInvocations, commandsInOrder };
}
