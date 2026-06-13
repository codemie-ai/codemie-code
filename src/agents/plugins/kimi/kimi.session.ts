/**
 * Kimi Session Adapter
 *
 * Parses Kimi Code `wire.jsonl` session transcripts into the unified
 * ParsedSession format used by CodeMie processors.
 *
 * Wire file path:
 *   ${KIMI_CODE_HOME}/sessions/{workDirKey}/{sessionId}/agents/main/wire.jsonl
 */

import type {
  SessionAdapter,
  ParsedSession,
  AggregatedResult,
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { readJSONLTolerant } from '../../core/session/utils/jsonl-reader.js';
import { logger } from '../../../utils/logger.js';
import { ToolExecutionError } from '../../../utils/errors.js';
import { KimiMetricsProcessor } from './session/processors/kimi.metrics-processor.js';

interface KimiWireEvent {
  type: string;
  time?: number;
  // metadata
  protocol_version?: string;
  created_at?: number;
  app_version?: string;
  // config.update
  profileName?: string;
  systemPrompt?: string;
  modelAlias?: string;
  thinkingLevel?: string;
  // usage.record
  model?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  usageScope?: string;
  // context.append_loop_event
  event?: {
    type?: string;
    uuid?: string;
    turnId?: string;
    step?: number;
    toolCallId?: string;
    parentUuid?: string;
    name?: string;
    args?: Record<string, unknown>;
    description?: string;
    result?: {
      output?: string;
      isError?: boolean;
    };
    usage?: {
      inputOther?: number;
      output?: number;
      inputCacheRead?: number;
      inputCacheCreation?: number;
    };
    finishReason?: string;
  };
  display?: {
    kind?: string;
    operation?: string;
    path?: string;
    content?: string;
    before?: string;
    after?: string;
  };
}

export class KimiSessionAdapter implements SessionAdapter {
  readonly agentName = 'kimi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new KimiMetricsProcessor());
    logger.debug(`[kimi-adapter] Initialized ${this.processors.length} processors`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[kimi-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Discover native Kimi sessions (placeholder).
   */
  async discoverSessions(_options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    logger.debug('[kimi-adapter] discoverSessions is not implemented yet');
    return [];
  }

  /**
   * Parse a Kimi `wire.jsonl` file into the unified ParsedSession format.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const events = await readJSONLTolerant<KimiWireEvent>(filePath, '[kimi-adapter]');

      if (events.length === 0) {
        logger.debug(`[kimi-adapter] Session file is empty or unreadable: ${filePath}`);
        return this.createMinimalSession(sessionId);
      }

      const model = this.extractModel(events);
      const { createdAt, updatedAt } = this.extractTimestamps(events);

      logger.debug(
        `[kimi-adapter] Parsed session ${sessionId}: ${events.length} events, ` +
        `model=${model ?? 'unknown'}`
      );

      const metadata = {
        projectPath: filePath,
        createdAt,
        updatedAt,
        model,
      };

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Kimi Code',
        metadata,
        messages: events,
      };
    } catch (error) {
      logger.warn(`[kimi-adapter] Failed to parse session file ${filePath}:`, error);
      return this.createMinimalSession(sessionId);
    }
  }

  /**
   * Process a Kimi session file with all registered processors.
   *
   * Not yet implemented — Kimi metrics are currently extracted directly
   * by parseSessionFile for analytics consumption.
   */
  async processSession(
    _filePath: string,
    _sessionId: string,
    _context: ProcessingContext
  ): Promise<AggregatedResult> {
    throw new ToolExecutionError('processSession', 'Kimi session processing is not implemented yet');
  }

  private createMinimalSession(sessionId: string): ParsedSession {
    const metadata = {
      createdAt: undefined,
      updatedAt: undefined,
      model: undefined,
    };

    return {
      sessionId,
      agentName: this.metadata.displayName || 'Kimi Code',
      metadata,
      messages: [],
    };
  }

  private extractModel(events: KimiWireEvent[]): string | undefined {
    for (const event of events) {
      if (event.type === 'config.update' && event.modelAlias) {
        return event.modelAlias;
      }
    }

    for (const event of events) {
      if (event.type === 'usage.record' && event.model) {
        return event.model;
      }
    }

    return undefined;
  }

  private extractTimestamps(events: KimiWireEvent[]): {
    createdAt: string | undefined;
    updatedAt: string | undefined;
  } {
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    for (const event of events) {
      if (typeof event.time === 'number') {
        createdAt = new Date(event.time).toISOString();
        break;
      }
      if (typeof event.created_at === 'number') {
        createdAt = new Date(event.created_at).toISOString();
        break;
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (typeof event.time === 'number') {
        updatedAt = new Date(event.time).toISOString();
        break;
      }
    }

    return { createdAt, updatedAt };
  }

}
