import { logger } from '../../../../../../../utils/logger.js';
import { CcrStore } from './types.js';
import { parseToolCall, CCR_TOOL_NAME } from './tool_injection.js';

export interface ResponseHandlerConfig {
  enabled: boolean;
  maxRetrievalRounds: number;
  stripCcrFromResponse: boolean;
  continuationTimeoutMs: number;
}

const DEFAULT_CONFIG: ResponseHandlerConfig = {
  enabled: true,
  maxRetrievalRounds: 3,
  stripCcrFromResponse: true,
  continuationTimeoutMs: 120_000,
};

type AnyRecord = Record<string, any>;

type ApiCallFn = (messages: AnyRecord[], tools: AnyRecord[]) => Promise<AnyRecord>;

export class CCRResponseHandler {
  private readonly config: ResponseHandlerConfig;
  private readonly store: CcrStore;

  constructor(config?: Partial<ResponseHandlerConfig>, store?: CcrStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!store) throw new Error('CCRResponseHandler requires a CcrStore');
    this.store = store;
  }

  hasCcrToolCalls(response: AnyRecord, provider: 'anthropic' | 'openai'): boolean {
    return parseToolCall(response, provider).length > 0;
  }

  async handleResponse(
    response: AnyRecord,
    messages: AnyRecord[],
    tools: AnyRecord[],
    apiCallFn: ApiCallFn,
    provider: 'anthropic' | 'openai',
  ): Promise<AnyRecord> {
    if (!this.config.enabled) return response;

    let current = response;
    let conversationMessages = [...messages];

    for (let round = 0; round < this.config.maxRetrievalRounds; round++) {
      const toolCalls = parseToolCall(current, provider);
      if (toolCalls.length === 0) break;

      if (provider === 'anthropic') {
        conversationMessages = [
          ...conversationMessages,
          { role: 'assistant', content: current['content'] },
        ];

        const toolResults: AnyRecord[] = [];
        for (const tc of toolCalls) {
          const result = this._retrieve(tc.hashKey, tc.query);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.toolCallId,
            content: result,
          });
        }
        conversationMessages.push({ role: 'user', content: toolResults });
      } else {
        conversationMessages = [
          ...conversationMessages,
          { role: 'assistant', content: null, tool_calls: (current['choices'] as AnyRecord[])?.[0]?.['message']?.['tool_calls'] },
        ];
        for (const tc of toolCalls) {
          const result = this._retrieve(tc.hashKey, tc.query);
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.toolCallId,
            name: CCR_TOOL_NAME,
            content: result,
          });
        }
      }

      current = await apiCallFn(conversationMessages, tools);
    }

    return current;
  }

  private _retrieve(hashKey: string, _query?: string): string {
    try {
      const entry = this.store.retrieve(hashKey);
      if (entry === null) {
        logger.warn(`[ccr-response-handler] hash not found: ${hashKey}`);
        return `[CCR not found: hash=${hashKey}]`;
      }
      return entry.originalContent;
    } catch (err) {
      logger.warn(`[ccr-response-handler] retrieval error for ${hashKey}`, err);
      return `[CCR retrieval error: hash=${hashKey}]`;
    }
  }
}

export function createCcrResponseHandler(
  config?: Partial<ResponseHandlerConfig>,
  store?: CcrStore,
): CCRResponseHandler {
  return new CCRResponseHandler(config, store);
}
