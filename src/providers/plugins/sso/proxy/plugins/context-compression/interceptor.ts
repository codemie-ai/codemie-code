/**
 * Context Compression Interceptor
 *
 * Implements ProxyInterceptor to compress LLM request message arrays
 * before forwarding to the upstream API, reducing token usage when
 * features.contextCompression.enabled is true in the profile configuration.
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
import { CompressionStore, createCompressionStore } from './ccr/store.js';
import { CacheAligner, createCacheAligner } from './transforms/cache-aligner.js';
import { buildCompressConfig } from './transforms/config.js';
import type { ProfileFeatures } from '../../../../../../env/types.js';
import { injectCcrTool } from './ccr/tool_injection.js';
import { CCRResponseHandler, createCcrResponseHandler } from './ccr/response_handler.js';

interface CompressionState {
  originalTokens: number;
  compressedTokens: number;
  model: string;
  cacheKeys: string[];
  stablePrefixHash: string;
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
  private readonly ccrStore: CompressionStore;
  private readonly cacheAligner: CacheAligner;
  private readonly _ccrResponseHandler: CCRResponseHandler;

  /** Per-request compression result, keyed by requestId */
  private readonly compressionState = new Map<string, CompressionState>();

  constructor(pluginContext: PluginContext) {
    this.pluginContext = pluginContext;
    this.tokenizer = createTokenizer();
    this.savingsTracker = createSavingsTracker();
    this.ccrStore = createCompressionStore();
    this.cacheAligner = createCacheAligner();
    this._ccrResponseHandler = createCcrResponseHandler(undefined, this.ccrStore);
  }

  async onRequest(context: ProxyContext): Promise<void> {
    // Only process JSON request bodies
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    const profileConfig = this.pluginContext.profileConfig as (Record<string, unknown> | undefined);
    const features = profileConfig?.['features'] as Record<string, unknown> | undefined;
    const ccFeatures = features?.['contextCompression'] as Record<string, unknown> | undefined;
    if (ccFeatures?.['enabled'] !== true) {
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
      const modelStr = typeof model === 'string' ? model : 'unknown';
      const contextLimit = resolveContextLimit(model);

      const compressConfig = buildCompressConfig(features as ProfileFeatures | undefined);

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

      // Phase 0: CacheAligner — stabilize system-message prefix for KV-cache hits
      // Only active when features.contextCompression.cacheAligner === true; otherwise pass through unchanged.
      const alignerEnabled = ccFeatures?.['cacheAligner'] === true;
      const { messages: alignedMessages, stablePrefixHash, dynamicExtracted } = alignerEnabled
        ? this.cacheAligner.align(normalized)
        : { messages: normalized, stablePrefixHash: '', dynamicExtracted: [] };
      if (dynamicExtracted.length > 0) {
        logger.info(
          `[${this.name}] CacheAligner: extracted ${dynamicExtracted.length} dynamic patterns,` +
            ` prefix hash=${stablePrefixHash}`,
        );
      }

      const router: ContentRouter = createContentRouter(this.tokenizer, undefined, this.ccrStore);
      const icm: IntelligentContextManager = createICM(router, this.tokenizer);

      const { messages: compressed, cacheKeys } = await icm.apply(
        alignedMessages,
        contextLimit,
        compressConfig,
        undefined,
        context.requestId,
      );
      const compressedTokens = await this.tokenizer.countMessages(compressed);

      // Serialize back to the provider's native format
      const serialized: unknown[] = adapter.serialize(compressed);

      // Re-build body with compressed messages
      const newBody: Record<string, unknown> = { ...originalBody, messages: serialized };

      // Inject CCR retrieval tool when compression occurred
      const ccrProvider: 'anthropic' | 'openai' = format === 'anthropic' ? 'anthropic' : 'openai';
      const bodyToSend = cacheKeys.length > 0
        ? injectCcrTool(newBody, ccrProvider)
        : newBody;
      const newBodyStr = JSON.stringify(bodyToSend);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      // Store state for response phase
      this.compressionState.set(context.requestId, {
        originalTokens,
        compressedTokens,
        model: modelStr,
        cacheKeys,
        stablePrefixHash,
      });

      const tokensSaved = originalTokens - compressedTokens;
      const ratio = originalTokens > 0 ? (compressedTokens / originalTokens).toFixed(2) : '1.00';
      logger.info(
        `[${this.name}] ${context.requestId}: ${originalTokens} → ${compressedTokens} tokens` +
        ` (saved ${tokensSaved}, ratio ${ratio}, ccr=${cacheKeys.length}, model: ${modelStr})`,
      );
      logger.debug(`[${this.name}] Compressed messages for ${context.requestId}`, {
        model,
        originalTokens,
        compressedTokens,
        tokensSaved,
        ccrKeys: cacheKeys.length,
        stablePrefixHash,
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
    headers['x-codemie-ccr-keys'] = String(state.cacheKeys.length);
    headers['x-codemie-prefix-hash'] = state.stablePrefixHash;
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
