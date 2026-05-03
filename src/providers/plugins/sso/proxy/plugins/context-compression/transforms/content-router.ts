import { Tokenizer } from '../tokenizer/tiktoken.js';
import { detectContentType, ContentType } from '../detection/content-detector.js';
import { CompressionResult } from '../compressors/types.js';
import { createDiffCompressor } from '../compressors/diff-compressor.js';
import { createLogCompressor } from '../compressors/log-compressor.js';
import { createSearchCompressor } from '../compressors/search-compressor.js';
import { createSmartCrusher } from '../compressors/smart-crusher/index.js';

export interface ContentRouterConfig {
  minConfidence: number;
  enableMixedContent: boolean;
}

const DEFAULT_CONFIG: ContentRouterConfig = {
  minConfidence: 0.5,
  enableMixedContent: false,
};

export class ContentRouter {
  private readonly config: ContentRouterConfig;
  private readonly diffCompressor: ReturnType<typeof createDiffCompressor>;
  private readonly logCompressor: ReturnType<typeof createLogCompressor>;
  private readonly searchCompressor: ReturnType<typeof createSearchCompressor>;
  private readonly smartCrusher: ReturnType<typeof createSmartCrusher>;

  constructor(tokenizer: Tokenizer, config?: Partial<ContentRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.diffCompressor = createDiffCompressor(tokenizer);
    this.logCompressor = createLogCompressor(tokenizer);
    this.searchCompressor = createSearchCompressor(tokenizer);
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

  async routeAll(segments: string[], contextHint?: string): Promise<CompressionResult[]> {
    return Promise.all(segments.map(segment => this.route(segment, contextHint)));
  }
}

export function createContentRouter(tokenizer: Tokenizer, config?: Partial<ContentRouterConfig>): ContentRouter {
  return new ContentRouter(tokenizer, config);
}
