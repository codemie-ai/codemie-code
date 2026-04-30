/**
 * Claude Non-Thinking Model Sanitizer Plugin
 * Priority: 17 (runs after Claude thinking parameter transforms)
 *
 * Some Claude clients preserve Anthropic `thinking` content blocks in message
 * history. Those blocks are only valid for models that support extended
 * thinking. When a user switches the same conversation to a model without
 * extended thinking support, such as Claude Haiku, upstream adapters may reject
 * the request with errors like "Content block is not a text block".
 *
 * For non-thinking Claude models, remove thinking controls and thinking-only
 * history blocks while preserving ordinary text, tool, image, and document
 * content.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = ['claude-desktop', 'codemie-claude'];
const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);
const THINKING_BETA_PATTERN = /^interleaved-thinking-[^,\s]+$/i;

function isJsonRequest(context: ProxyContext): boolean {
  return Boolean(
    context.requestBody
      && context.headers['content-type']?.includes('application/json')
  );
}

function modelSupportsExtendedThinking(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('claude-3-7-sonnet')
    || /claude-(?:opus|sonnet)-4(?:[^0-9]|$)/i.test(normalized);
}

function isClaudeModel(modelName: string): boolean {
  return /^claude-/i.test(modelName);
}

function modelRequiresThinkingSanitization(modelName: string): boolean {
  return isClaudeModel(modelName) && !modelSupportsExtendedThinking(modelName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripThinkingBlocksFromContent(content: unknown): {
  content: unknown;
  strippedBlocks: number;
} {
  if (!Array.isArray(content)) {
    return { content, strippedBlocks: 0 };
  }

  let strippedBlocks = 0;
  const filtered = content.filter((block) => {
    if (isRecord(block) && typeof block.type === 'string' && THINKING_BLOCK_TYPES.has(block.type)) {
      strippedBlocks++;
      return false;
    }
    return true;
  });

  return {
    content: filtered.length > 0 ? filtered : [{ type: 'text', text: '' }],
    strippedBlocks,
  };
}

function stripInterleavedThinkingBeta(headerValue: string): string {
  return headerValue
    .split(',')
    .map(part => part.trim())
    .filter(part => part && !THINKING_BETA_PATTERN.test(part))
    .join(',');
}

export class ClaudeNonThinkingModelSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-claude-non-thinking-model-sanitizer';
  name = 'Claude Non-Thinking Model Sanitizer';
  version = '1.0.0';
  priority = 17;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new ClaudeNonThinkingModelSanitizerInterceptor(context.config.model);
  }
}

class ClaudeNonThinkingModelSanitizerInterceptor implements ProxyInterceptor {
  name = 'claude-non-thinking-model-sanitizer';

  constructor(private readonly configModel?: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!isJsonRequest(context)) {
      return;
    }

    try {
      const body = JSON.parse(context.requestBody!.toString('utf-8')) as Record<string, unknown>;
      const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
      if (!modelRequiresThinkingSanitization(model)) {
        return;
      }

      let changed = false;
      let strippedBlocks = 0;
      let removedTopLevelThinking = false;

      if ('thinking' in body) {
        delete body.thinking;
        changed = true;
        removedTopLevelThinking = true;
      }

      if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
          if (!isRecord(message) || !('content' in message)) {
            continue;
          }

          const result = stripThinkingBlocksFromContent(message.content);
          if (result.strippedBlocks > 0) {
            message.content = result.content;
            strippedBlocks += result.strippedBlocks;
            changed = true;
          }
        }
      }

      const betaHeader = context.headers['anthropic-beta'];
      if (typeof betaHeader === 'string') {
        const sanitizedBeta = stripInterleavedThinkingBeta(betaHeader);
        if (sanitizedBeta !== betaHeader) {
          if (sanitizedBeta) {
            context.headers['anthropic-beta'] = sanitizedBeta;
          } else {
            delete context.headers['anthropic-beta'];
          }
          changed = true;
        }
      }

      if (!changed) {
        return;
      }

      context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(
        `[${this.name}] Removed extended thinking data for non-thinking model`,
        {
          model,
          strippedBlocks,
          removedTopLevelThinking,
        }
      );
    } catch {
      // Not valid JSON or unexpected structure - pass through unchanged.
    }
  }
}
