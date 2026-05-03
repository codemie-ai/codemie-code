import { Tokenizer } from '../tokenizer/tiktoken.js';
import { detectContentType, ContentType } from '../detection/content-detector.js';
import type { CcrStore } from '../ccr/types.js';
import { CompressionResult } from '../compressors/types.js';
import { createDiffCompressor } from '../compressors/diff-compressor.js';
import { createLogCompressor } from '../compressors/log-compressor.js';
import { createSearchCompressor } from '../compressors/search-compressor.js';
import { createSmartCrusher } from '../compressors/smart-crusher/index.js';

export function computePressureMinRatio(
  fillFraction: number,
  relaxed = 0.85,
  aggressive = 0.65,
): number {
  const f = Math.max(0, Math.min(1, fillFraction));
  return relaxed + (aggressive - relaxed) * f;
}

export interface ContentRouterConfig {
  minConfidence: number;
  enableMixedContent: boolean;
  minRatioRelaxed: number;
  minRatioAggressive: number;
  skipUserMessages: boolean;
}

const DEFAULT_CONFIG: ContentRouterConfig = {
  minConfidence: 0.5,
  enableMixedContent: false,
  minRatioRelaxed: 0.85,
  minRatioAggressive: 0.65,
  skipUserMessages: false,
};

export class ContentRouter {
  private readonly config: ContentRouterConfig;
  private readonly diffCompressor: ReturnType<typeof createDiffCompressor>;
  private readonly logCompressor: ReturnType<typeof createLogCompressor>;
  private readonly searchCompressor: ReturnType<typeof createSearchCompressor>;
  private readonly smartCrusher: ReturnType<typeof createSmartCrusher>;
  private readonly store?: CcrStore;

  constructor(tokenizer: Tokenizer, config?: Partial<ContentRouterConfig>, store?: CcrStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store;
    this.diffCompressor = createDiffCompressor(tokenizer, undefined, store);
    this.logCompressor = createLogCompressor(tokenizer, undefined, store);
    this.searchCompressor = createSearchCompressor(tokenizer, undefined, store);
    this.smartCrusher = createSmartCrusher(tokenizer);
  }

  async route(content: string, contextHint?: string): Promise<CompressionResult> {
    const detection = detectContentType(content);

    if (detection.confidence < this.config.minConfidence) {
      return this.smartCrusher.compress(content, contextHint);
    }

    switch (detection.contentType) {
      case ContentType.GIT_DIFF:
        return this.diffCompressor.compress(content, contextHint);
      case ContentType.BUILD_OUTPUT:
        return this.logCompressor.compress(content, contextHint);
      case ContentType.SEARCH_RESULTS:
        return this.searchCompressor.compress(content, contextHint);
      case ContentType.JSON_ARRAY:
      case ContentType.SOURCE_CODE:
      case ContentType.HTML:
      case ContentType.PLAIN_TEXT:
      default:
        return this.smartCrusher.compress(content, contextHint);
    }
  }

  async routeWithPressure(
    content: string,
    fillFraction: number,
    contextHint?: string,
  ): Promise<CompressionResult> {
    const pressureRatio = computePressureMinRatio(
      fillFraction,
      this.config.minRatioRelaxed,
      this.config.minRatioAggressive,
    );
    const result = await this.route(content, contextHint);
    if (result.compressionRatio > pressureRatio) {
      return { ...result, compressed: content, compressionRatio: 1.0 };
    }
    return result;
  }

  async routeAll(segments: string[], contextHint?: string): Promise<CompressionResult[]> {
    return Promise.all(segments.map(segment => this.route(segment, contextHint)));
  }
}

export function createContentRouter(tokenizer: Tokenizer, config?: Partial<ContentRouterConfig>, store?: CcrStore): ContentRouter {
  return new ContentRouter(tokenizer, config, store);
}
