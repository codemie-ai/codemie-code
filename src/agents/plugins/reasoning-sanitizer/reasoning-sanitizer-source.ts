/**
 * Reasoning Params Sanitizer Plugin Source
 *
 * Contains the OpenCode plugin TypeScript source as a string constant.
 * At runtime this is written to a temp file and loaded by the OpenCode binary.
 *
 * The plugin strips unsupported reasoning params (reasoningSummary, reasoning)
 * for LiteLLM and SSO proxy (codemie-proxy) providers. Both use
 * openai-compatible endpoints that reject these params.
 * reasoningEffort is left intact (supported by both).
 *
 * Why a string constant: The plugin uses `import type { Plugin } from "@opencode-ai/plugin"`
 * which doesn't exist in codemie-code's dependencies. Embedding as a string avoids
 * TypeScript compilation issues. Bun strips the type import at runtime.
 */

export const REASONING_SANITIZER_PLUGIN_SOURCE = `
import type { Plugin } from "@opencode-ai/plugin";

// Strips unsupported reasoning params for LiteLLM AND SSO proxy (codemie-proxy) providers.
// Both use openai-compatible endpoints that reject reasoningSummary/reasoning params.
// reasoningEffort is left intact (supported by both).
const ReasoningParamsSanitizerPlugin: Plugin = async (_input) => ({
  "chat.params": async (input, output) => {
    const pid = input.model.providerID.toLowerCase();
    const aid = input.model.api.id.toLowerCase();
    const opts = input.provider.options;
    const shouldSanitize =
      opts?.["litellmProxy"] === true ||
      pid.includes("litellm") || aid.includes("litellm") ||
      pid.includes("codemie-proxy") || aid.includes("codemie-proxy");
    if (!shouldSanitize) return;
    delete output.options.reasoningSummary;
    delete output.options.reasoning_summary;
    delete output.options.reasoning;
  },
});

export default ReasoningParamsSanitizerPlugin;
`;
