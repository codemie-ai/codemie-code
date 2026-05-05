/**
 * Haiku Thinking Disabler Plugin
 * Priority: 14 (runs before RequestSanitizer at 15 and ClaudeThinkingTransformer at 16)
 *
 * Problem: Haiku 4-5 and similar models do not support thinking (extended output).
 * When thinking is present in the request, the API returns an error or unexpected
 * thinking blocks that break downstream processing.
 *
 * Fix: Strip the thinking field from the request body before forwarding when the
 * request model matches a known no-thinking pattern.
 *
 * Scope: Only enabled for codemie-claude agent (Claude Code via SSO proxy).
 *
 * To add support for a new model: append a pattern to NO_THINKING_MODEL_PATTERNS.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from "./types.js";
import { ProxyContext } from "../proxy-types.js";
import { logger } from "../../../../../utils/logger.js";

/**
 * Model name patterns that do NOT support thinking.
 * Matches claude-haiku-4-5 and any date-tagged variants (e.g. claude-haiku-4-5-20251001).
 */
const NO_THINKING_MODEL_PATTERNS: RegExp[] = [/claude-haiku-4-5(?:[^0-9]|$)/i];

function modelDisablesThinking(modelName: string): boolean {
  return NO_THINKING_MODEL_PATTERNS.some((p) => p.test(modelName));
}

const ALLOWED_AGENT = "codemie-claude";

export class ClaudeThinkingDisablerPlugin implements ProxyPlugin {
  id = "@codemie/proxy-haiku-thinking-disabler";
  name = "Haiku Thinking Disabler";
  version = "1.0.0";
  priority = 14; // Before RequestSanitizer (15) and ClaudeThinkingTransformer (16)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || clientType !== ALLOWED_AGENT) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new HaikuThinkingDisablerInterceptor(context.config.model);
  }
}

class HaikuThinkingDisablerInterceptor implements ProxyInterceptor {
  name = "haiku-thinking-disabler";

  constructor(private readonly configModel?: string) { }

  async onRequest(context: ProxyContext): Promise<void> {
    if (
      !context.requestBody ||
      !context.headers["content-type"]?.includes("application/json")
    ) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString("utf-8");
      const body = JSON.parse(bodyStr);

      if (!body.thinking) {
        return;
      }

      const model =
        (typeof body.model === "string" && body.model) ||
        this.configModel ||
        "";
      if (!model || !modelDisablesThinking(model)) {
        return;
      }

      delete body.thinking;

      logger.debug(
        `[${this.name}] Removed thinking field for unsupported model: ${model}`,
      );

      const newBodyStr = JSON.stringify(body);
      context.requestBody = Buffer.from(newBodyStr, "utf-8");
      context.headers["content-length"] = String(context.requestBody.length);
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged
    }
  }
}
