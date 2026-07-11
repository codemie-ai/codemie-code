/**
 * Azure / DIAL Request Sanitizer Plugin Source
 *
 * Contains the OpenCode plugin TypeScript source as a string constant.
 * At runtime this is written to a temp file and loaded by the OpenCode binary.
 *
 * EPAM DIAL (and standard Azure OpenAI) use an OpenAI-compatible Chat Completions
 * interface. Several Anthropic-native fields that @ai-sdk or OpenCode may inject
 * are not supported and cause HTTP 400 errors:
 *
 *   1. Anthropic-native fields on messages and content items:
 *      - `cache_control`
 *        → DIAL error: "Extra inputs are not permitted on path messages.0.cache_control"
 *      - `reasoning_content`
 *        → DIAL error: "Extra inputs are not permitted on path messages.3.reasoning_content"
 *      - `thinking`, `citations`, and other non-Chat-Completions fields.
 *      → Strategy: sanitize recursively for every message/content part.
 *
 *   2. Anthropic/OpenAI reasoning params on top-level request/options:
 *      - `thinking` / `thinking.budget_tokens`
 *      - `reasoningSummary`, `reasoning_summary`, `reasoning`, `reasoning_effort`
 *      - `include_reasoning`, `reasoning_content`
 *      → These are provider-specific extensions and are not accepted consistently
 *        by DIAL's OpenAI Chat Completions compatibility layer.
 *
 *   3. Unsupported OpenAI-compatible params for non-GPT deployments:
 *      - `parallel_tool_calls`, `store`, `metadata`, `prediction`, `modalities`,
 *        and similar fields can be emitted by newer AI SDK/OpenCode versions.
 *      → Keep only the conservative Chat Completions request shape that DIAL
 *        accepts across GPT, Claude, Gemini, Grok, Qwen, DeepSeek, Llama, etc.
 *
 * Scope: Only runs for azure-openai-* providers (registered per-deployment by
 * buildAzureOpenAIProviders in codemie-code.plugin.ts). Provider IDs always
 * start with "azure-openai-".
 *
 * Why a string constant: The plugin uses `import type { Plugin } from "@opencode-ai/plugin"`
 * which doesn't exist in codemie-code's dependencies. Embedding as a string avoids
 * TypeScript compilation issues. Bun strips the type import at runtime.
 */

// Utility: sanitize an OpenAI/DIAL payload for strict Azure OpenAI / DIAL compatibility
export function sanitizeAzureOpenAIPayload(obj: any): any {
  if (obj == null || typeof obj !== 'object') return obj;
  // conservative OpenAI Chat Completions allowed fields
  const allowedRoot = [
    'model', 'messages', 'temperature', 'max_tokens', 'top_p', 'stream',
    'stop', 'presence_penalty', 'frequency_penalty'
  ];
  const cleaned: any = {};
  for (const k of allowedRoot) if (k in obj) cleaned[k] = obj[k];
  // messages:
  if (Array.isArray(cleaned.messages)) {
    cleaned.messages = cleaned.messages.map((msg: any) => {
      const allowedMsg = ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'function_call'];
      const m: any = {};
      for (const key of allowedMsg) if (key in msg) m[key] = msg[key];
      // clean up Anthropic/DIAL-native fields
      delete m['cache_control'];
      delete m['reasoning_content'];
      delete m['thinking'];
      if (Array.isArray(m.content)) {
        m.content = m.content.map((item: any) => {
          if (item && typeof item === 'object') {
            const c = { ...item };
            delete c['cache_control'];
            delete c['reasoning_content'];
            delete c['thinking'];
            return c;
          }
          return item;
        });
      }
      return m;
    });
  }
  return cleaned;
}

export const AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE = `
import type { Plugin } from "@opencode-ai/plugin";

const UNSUPPORTED_TOP_LEVEL_FIELDS = [
  "reasoningSummary",
  "reasoning_summary",
  "reasoning",
  "reasoning_effort",
  "include_reasoning",
  "reasoning_content",
  "thinking",
  "cache_control",
  "betas",
  "anthropic_beta",
  "anthropic_version",
  "store",
  "metadata",
  "prediction",
  "modalities",
  "service_tier",
  "parallel_tool_calls",
  "prompt_cache_key",
];

const UNSUPPORTED_NESTED_FIELDS = [
  "cache_control",
  "reasoning_content",
  "reasoningContent",
  "thinking",
  "citations",
  "signature",
  "redacted_thinking",
];

const ALLOWED_MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "function_call",
]);

const ALLOWED_TOOL_CALL_FIELDS = new Set(["id", "type", "function"]);
const ALLOWED_FUNCTION_FIELDS = new Set(["name", "arguments"]);

function removeUnsupportedNestedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUnsupportedNestedFields);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const cleaned = { ...(value as Record<string, unknown>) };
  for (const field of UNSUPPORTED_NESTED_FIELDS) {
    delete cleaned[field];
  }

  for (const [key, nested] of Object.entries(cleaned)) {
    cleaned[key] = removeUnsupportedNestedFields(nested);
  }

  return cleaned;
}

function sanitizeToolCall(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== "object") return toolCall;

  const input = toolCall as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_TOOL_CALL_FIELDS.has(key)) continue;

    if (key === "function" && value && typeof value === "object") {
      const fn: Record<string, unknown> = {};
      for (const [fnKey, fnValue] of Object.entries(value as Record<string, unknown>)) {
        if (ALLOWED_FUNCTION_FIELDS.has(fnKey)) {
          fn[fnKey] = fnValue;
        }
      }
      cleaned[key] = fn;
    } else {
      cleaned[key] = removeUnsupportedNestedFields(value);
    }
  }

  return cleaned;
}

/**
 * Normalize a message to a conservative OpenAI Chat Completions shape.
 *
 * DIAL/Azure OpenAI use OpenAI-compatible Chat Completions API and do NOT
 * support Anthropic-only fields at any level — even for Claude deployments.
 *
 * Handles:
 *  - messages[i].cache_control
 *  - messages[i].reasoning_content
 *  - messages[i].content[j].cache_control
 *  - messages[i].content[j].reasoning_content
 *  - message/content metadata injected by AI SDKs or prior model responses.
 */
function sanitizeMessage(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const input = msg as Record<string, unknown>;
  const m: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_MESSAGE_FIELDS.has(key)) continue;

    if (key === "tool_calls" && Array.isArray(value)) {
      m[key] = value.map(sanitizeToolCall);
    } else {
      m[key] = removeUnsupportedNestedFields(value);
    }
  }

  // Remove cache_control from the message object itself
  delete m["cache_control"];
  delete m["reasoning_content"];
  delete m["reasoningContent"];
  delete m["thinking"];

  // Remove cache_control from each item inside content[]
  if (Array.isArray(m["content"])) {
    m["content"] = (m["content"] as unknown[]).map((item: unknown) => {
      if (item && typeof item === "object") {
        const cleaned = removeUnsupportedNestedFields(item) as Record<string, unknown>;
        delete cleaned["cache_control"];
        delete cleaned["reasoning_content"];
        delete cleaned["reasoningContent"];
        delete cleaned["thinking"];
        return cleaned;
      }
      return item;
    });
  }

  return m;
}

function sanitizeParamsContainer(container: unknown): void {
  if (!container || typeof container !== "object") return;

  const params = container as Record<string, unknown>;
  for (const field of UNSUPPORTED_TOP_LEVEL_FIELDS) {
    delete params[field];
  }
}

/**
 * Strip provider-specific fields from messages and top-level params for
 * Azure OpenAI / EPAM DIAL providers.
 *
 * Activated only for providers whose ID starts with "azure-openai-"
 * (the naming convention used by buildAzureOpenAIProviders).
 *
 * Always sanitizes for ALL models (including Claude), because DIAL exposes a
 * single OpenAI-compatible schema and rejects extra provider-native fields.
 */
const AzureOpenAISanitizerPlugin: Plugin = async (_input) => ({
  "chat.params": async (input, output) => {
    const pid: string = (input.model?.providerID ?? "").toLowerCase();
    const aid: string = (input.model?.api?.id ?? "").toLowerCase();

    // Only run for azure-openai-* per-deployment providers
    const isAzureOpenAI =
      pid.startsWith("azure-openai-") ||
      aid.startsWith("azure-openai-");
    if (!isAzureOpenAI) return;

    // 1. Strip provider-native fields from every message and nested content item.
    if (Array.isArray(output.messages)) {
      output.messages = output.messages.map(sanitizeMessage);
    }

    // 2. Strip request-level params from both known OpenCode containers.
    sanitizeParamsContainer(output);
    sanitizeParamsContainer(output.options);
  },
});

export default AzureOpenAISanitizerPlugin;
`;
