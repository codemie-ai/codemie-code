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

interface RawBlock {
  type?: string;
  name?: string;
  input?: { skill?: unknown; subagent_type?: unknown };
  text?: unknown;
}

interface RawMessage {
  message?: { role?: string; content?: unknown };
}

const COMMAND_TAG = /<command-name>([^<]+)<\/command-name>/g;

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Extract skill / agent / command name counts from a flat list of Claude messages.
 * Safe against missing or malformed fields — anything that isn't a recognized shape is skipped.
 */
export function extractNamedInvocations(messages: readonly unknown[]): NamedInvocationCounts {
  const skillInvocations: Record<string, number> = {};
  const agentInvocations: Record<string, number> = {};
  const commandInvocations: Record<string, number> = {};

  // Count slash commands from a text payload, but only when it carries the CLI's
  // `<command-message>` sibling — that distinguishes a real invocation from prose that
  // merely quotes `<command-name>` (e.g. docs, specs, this very file).
  const scanCommands = (text: string): void => {
    if (!text.includes('<command-message>')) {
      return;
    }
    COMMAND_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMAND_TAG.exec(text)) !== null) {
      const cmd = match[1].replace(/^\//, '').trim();
      if (cmd) bump(commandInvocations, cmd);
    }
  };

  for (const raw of messages) {
    const msg = raw as RawMessage;
    const content = msg?.message?.content;
    const isUser = msg?.message?.role === 'user';

    // Real slash commands arrive as plain string content (the CLI shape).
    if (typeof content === 'string') {
      if (isUser) scanCommands(content);
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
        scanCommands(item.text);
      }
    }
  }

  return { skillInvocations, agentInvocations, commandInvocations };
}
