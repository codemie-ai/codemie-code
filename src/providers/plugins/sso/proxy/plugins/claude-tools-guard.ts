/**
 * Tools Guard (pure helper)
 *
 * Bedrock (via LiteLLM's Converse transformation) rejects requests whose history carries tool
 * calls (Anthropic tool_use / tool_result, OpenAI Chat tool_calls / role "tool", or OpenAI
 * Responses function_call / function_call_output items) while `tools` is absent or empty.
 * Compaction-style requests look exactly like that. This helper injects one inert placeholder
 * tool so the request stays valid. Body shape only: it never looks at `model`.
 */

export type ToolsGuardShape = 'anthropic' | 'openai' | 'responses';

/**
 * Optionally send tool_choice "none" so the placeholder is never called. Disabled: acceptance of it by the
 * gateway and Bedrock is unverified, so the placeholder description alone discourages calling it.
 * Independently of this flag, a tool_choice that forces a tool call is always removed when the
 * placeholder is injected, because the only tool it could force is the placeholder.
 */
const SET_TOOL_CHOICE_NONE = false;

const PLACEHOLDER_NAME = 'noop_placeholder_tool';
const PLACEHOLDER_DESCRIPTION =
  'Placeholder required by the upstream API because the conversation contains tool history. Never call this tool.';

const RESPONSES_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(['function_call', 'function_call_output']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function detectMessagesToolHistory(messages: unknown): ToolsGuardShape | null {
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

function detectResponsesToolHistory(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some(item => isRecord(item) && typeof item.type === 'string' && RESPONSES_TOOL_ITEM_TYPES.has(item.type));
}

function detectToolHistory(body: Record<string, unknown>): ToolsGuardShape | null {
  return detectMessagesToolHistory(body.messages) ?? (detectResponsesToolHistory(body.input) ? 'responses' : null);
}

/**
 * True when tool_choice obliges the model to call some tool: Anthropic {type:'any'|'tool'},
 * OpenAI 'required' or {type:'function'|...} naming a specific tool.
 */
function isForcingToolChoice(toolChoice: unknown): boolean {
  if (typeof toolChoice === 'string') return toolChoice === 'required' || toolChoice === 'any';
  if (!isRecord(toolChoice)) return false;
  return toolChoice.type !== 'auto' && toolChoice.type !== 'none';
}

function applyToolChoice(body: Record<string, unknown>, shape: ToolsGuardShape): void {
  if (SET_TOOL_CHOICE_NONE) {
    body.tool_choice = shape === 'anthropic' ? { type: 'none' } : 'none';
    return;
  }
  if (isForcingToolChoice(body.tool_choice)) {
    delete body.tool_choice;
  }
}

function placeholderTools(shape: ToolsGuardShape): unknown[] {
  const parameters = { type: 'object', properties: {} };
  switch (shape) {
    case 'anthropic':
      return [{ name: PLACEHOLDER_NAME, description: PLACEHOLDER_DESCRIPTION, input_schema: parameters }];
    case 'openai':
      return [{ type: 'function', function: { name: PLACEHOLDER_NAME, description: PLACEHOLDER_DESCRIPTION, parameters } }];
    case 'responses':
      return [{ type: 'function', name: PLACEHOLDER_NAME, description: PLACEHOLDER_DESCRIPTION, parameters }];
  }
}

/**
 * Mutates `body`, returning the injected shape, or null when untouched.
 */
export function applyToolsGuard(body: Record<string, unknown>): ToolsGuardShape | null {
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return null;

  const shape = detectToolHistory(body);
  if (!shape) return null;

  body.tools = placeholderTools(shape);
  applyToolChoice(body, shape);

  return shape;
}
