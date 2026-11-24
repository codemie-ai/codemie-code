/**
 * Tools Guard (pure helper)
 *
 * Bedrock (via LiteLLM's Converse transformation) rejects requests whose messages carry tool
 * history (tool_use / tool_result, or OpenAI tool_calls / role "tool") while `tools` is absent
 * or empty. Compaction-style requests look exactly like that. This helper injects one inert
 * placeholder tool so the request stays valid. Body shape only: it never looks at `model`.
 */

export type ToolsGuardShape = 'anthropic' | 'openai';

/**
 * Optionally send tool_choice "none" so the placeholder is never called. Disabled: acceptance of it by the
 * gateway and Bedrock is unverified, so the placeholder description alone discourages calling it.
 */
const SET_TOOL_CHOICE_NONE = false;

const PLACEHOLDER_NAME = 'noop_placeholder_tool';
const PLACEHOLDER_DESCRIPTION =
  'Placeholder required by the upstream API because the conversation contains tool history. Never call this tool.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function detectToolHistory(messages: unknown): ToolsGuardShape | null {
  if (!Array.isArray(messages)) return null;

  let openai = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && (block.type === 'tool_use' || block.type === 'tool_result')) {
          return 'anthropic';
        }
      }
    }

    if (message.role === 'tool' || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) {
      openai = true;
    }
  }

  return openai ? 'openai' : null;
}

/**
 * Mutates `body`, returning the injected shape, or null when untouched.
 */
export function applyToolsGuard(body: Record<string, unknown>): ToolsGuardShape | null {
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return null;

  const shape = detectToolHistory(body.messages);
  if (!shape) return null;

  const parameters = { type: 'object', properties: {} };

  if (shape === 'anthropic') {
    body.tools = [{ name: PLACEHOLDER_NAME, description: PLACEHOLDER_DESCRIPTION, input_schema: parameters }];
    if (SET_TOOL_CHOICE_NONE && (body.tool_choice === undefined || body.tool_choice === null)) {
      body.tool_choice = { type: 'none' };
    }
  } else {
    body.tools = [
      { type: 'function', function: { name: PLACEHOLDER_NAME, description: PLACEHOLDER_DESCRIPTION, parameters } },
    ];
    if (SET_TOOL_CHOICE_NONE && (body.tool_choice === undefined || body.tool_choice === null)) {
      body.tool_choice = 'none';
    }
  }

  return shape;
}
