/**
 * Context Compression Interceptor
 *
 * Implements ProxyInterceptor to compress LLM request message arrays
 * before forwarding to the upstream API, reducing token usage when
 * tokenSavingMode is enabled in the profile configuration.
 *
 * SOLID: Single responsibility = compress messages on request
 * KISS: Errors are caught and logged; compression is never on the critical path
 */

import { IncomingHttpHeaders } from 'http';
import { ProxyInterceptor, PluginContext, ResponseMetadata } from '../types.js';
import { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';
import { Tokenizer, createTokenizer } from './tokenizer/tiktoken.js';
import { ContentRouter, createContentRouter } from './transforms/content-router.js';
import { IntelligentContextManager, createICM, ICMMessage } from './transforms/icm.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { MessageAdapter, ProviderFormat } from './adapters/types.js';
import { SavingsTracker, createSavingsTracker } from './savings/tracker.js';

interface CompressionState {
  originalTokens: number;
  compressedTokens: number;
  model: string;
}

function resolveContextLimit(model: unknown): number {
  if (typeof model !== 'string') return 100_000;
  if (model.startsWith('claude-')) return 200_000;
  if (model.startsWith('gpt-4')) return 128_000;
  if (model.startsWith('gpt-3.5')) return 16_000;
  return 100_000;
}

function detectFormat(path: string, body: Record<string, unknown>): ProviderFormat {
  if (path.includes('/v1/messages')) return 'anthropic';
  if (path.includes('/v1/chat/completions')) {
    // OpenAI-compatible if body has 'model' but unusual shape
    const messages = body['messages'];
    if (Array.isArray(messages)) {
      // Check for any message with undefined content — OpenAI-compatible quirk
      const hasUndefinedContent = messages.some(
        (m): boolean => typeof m === 'object' && m !== null && !('content' in m),
      );
      return hasUndefinedContent ? 'openai-compatible' : 'openai';
    }
    return 'openai';
  }
  return 'openai';
}

function selectAdapter(format: ProviderFormat): MessageAdapter {
  switch (format) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'openai-compatible':
      return new OpenAICompatibleAdapter();
    case 'openai':
    default:
      return new OpenAIAdapter();
  }
}

export class ContextCompressionInterceptor implements ProxyInterceptor {
  readonly name = 'context-compression';

  private readonly pluginContext: PluginContext;
  private readonly tokenizer: Tokenizer;
  private readonly savingsTracker: SavingsTracker;

  /** Per-request compression result, keyed by requestId */
  private readonly compressionState = new Map<string, CompressionState>();

  constructor(pluginContext: PluginContext) {
    this.pluginContext = pluginContext;
    this.tokenizer = createTokenizer();
    this.savingsTracker = createSavingsTracker();
  }

  async onRequest(context: ProxyContext): Promise<void> {
    // Only process JSON request bodies
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    // Check feature flag (features.tokenSavingMode is added in Task 13; access defensively)
    const profileConfig = this.pluginContext.profileConfig as (Record<string, unknown> | undefined);
    const features = profileConfig?.['features'] as Record<string, unknown> | undefined;
    if (features?.['tokenSavingMode'] !== true) {
      return;
    }

    let originalBody: Record<string, unknown>;
    try {
      originalBody = JSON.parse(context.requestBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      // Not valid JSON — pass through unchanged
      return;
    }

    // Require messages array
    const rawMessages = originalBody['messages'];
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return;
    }

    try {
      const format = detectFormat(context.url, originalBody);
      const adapter = selectAdapter(format);
      const normalized: ICMMessage[] = adapter.normalize(rawMessages);

      const model = originalBody['model'];
      const contextLimit = resolveContextLimit(model);

      const originalTokens = await this.tokenizer.countMessages(normalized);

      // Per-message breakdown for diagnosis (INFO so it reaches the log file)
      for (const msg of normalized) {
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as Array<{type: string; text?: string}>)
              .filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        const t = await this.tokenizer.countText(text);
        const lines = text.split('\n').length;
        logger.info(`[${this.name}] msg role=${msg.role} tokens=${t} lines=${lines}`);
      }

      const router: ContentRouter = createContentRouter(this.tokenizer);
      const icm: IntelligentContextManager = createICM(router, this.tokenizer);

      const compressed: ICMMessage[] = await icm.apply(normalized, contextLimit);
      const compressedTokens = await this.tokenizer.countMessages(compressed);

      // Serialize back to the provider's native format
      const serialized: unknown[] = adapter.serialize(compressed);

      // Re-build body with compressed messages
      const newBody: Record<string, unknown> = { ...originalBody, messages: serialized };
      const newBodyStr = JSON.stringify(newBody);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      // Store state for response phase
      this.compressionState.set(context.requestId, {
        originalTokens,
        compressedTokens,
        model: typeof model === 'string' ? model : 'unknown',
      });

      const tokensSaved = originalTokens - compressedTokens;
      const ratio = originalTokens > 0 ? (compressedTokens / originalTokens).toFixed(2) : '1.00';
      logger.info(
        `[${this.name}] ${context.requestId}: ${originalTokens} → ${compressedTokens} tokens` +
        ` (saved ${tokensSaved}, ratio ${ratio}, model: ${typeof model === 'string' ? model : 'unknown'})`
      );
      logger.debug(`[${this.name}] Compressed messages for ${context.requestId}`, {
        model,
        originalTokens,
        compressedTokens,
        tokensSaved,
      });
    } catch (err) {
      // Compression is never on the critical path — log and pass through
      logger.warn(`[${this.name}] Compression failed for ${context.requestId}, passing through`, err);
    }
  }

  async onResponseHeaders(context: ProxyContext, headers: IncomingHttpHeaders): Promise<void> {
    const state = this.compressionState.get(context.requestId);
    if (!state) {
      return;
    }

    const tokensSaved = state.originalTokens - state.compressedTokens;
    if (tokensSaved <= 0) {
      return;
    }

    const ratio = state.compressedTokens / state.originalTokens;
    const ratioStr = ratio.toFixed(2);

    // Inject custom headers — these are copied to the downstream response before streaming begins
    headers['x-codemie-tokens-saved'] = String(tokensSaved);
    headers['x-codemie-compression-ratio'] = ratioStr;
    headers['x-codemie-compression-strategy'] = 'context-compression';
    headers['x-codemie-model'] = state.model;
  }

  async onError(context: ProxyContext, _error: Error): Promise<void> {
    this.compressionState.delete(context.requestId);
  }

  async onResponseComplete(context: ProxyContext, _metadata: ResponseMetadata): Promise<void> {
    const state = this.compressionState.get(context.requestId);
    if (!state) {
      return;
    }

    // Clean up per-request state
    this.compressionState.delete(context.requestId);

    const tokensSaved = state.originalTokens - state.compressedTokens;
    if (tokensSaved <= 0) {
      return;
    }

    // Record to persistent savings tracker (fire-and-forget, non-critical)
    this.savingsTracker
      .record({
        model: state.model,
        tokensSaved,
        totalInputTokens: state.originalTokens,
      })
      .catch((err: unknown) => {
        logger.warn(`[${this.name}] Failed to record savings`, err);
      });
  }
}
