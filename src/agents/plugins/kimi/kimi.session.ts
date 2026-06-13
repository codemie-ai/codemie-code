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
import { KimiMetricsProcessor } from './session/processors/kimi.metrics-processor.js';
import type { KimiWireEvent } from './session/types.js';

export class KimiSessionAdapter implements SessionAdapter {
  readonly agentName = 'kimi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    // Register processors now, but execution is currently orchestrated externally
    // until processSession is implemented.
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
   * Parses the wire.jsonl file once, runs each registered processor in priority
   * order, and returns an aggregated result. This is the entry point used by
   * `codemie hook` during incremental sync.
   */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    try {
      logger.debug(
        `[kimi-adapter] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`
      );

      const parsedSession = await this.parseSessionFile(filePath, sessionId);

      const processorResults: Record<string, {
        success: boolean;
        message?: string;
        recordsProcessed?: number;
      }> = {};
      const failedProcessors: string[] = [];
      let totalRecords = 0;

      for (const processor of this.processors) {
        try {
          if (!processor.shouldProcess(parsedSession)) {
            logger.debug(`[kimi-adapter] Processor ${processor.name} skipped (shouldProcess returned false)`);
            continue;
          }

          logger.debug(`[kimi-adapter] Running processor: ${processor.name}`);

          const result = await processor.process(parsedSession, context);

          processorResults[processor.name] = {
            success: result.success,
            message: result.message,
            recordsProcessed: result.metadata?.recordsProcessed as number | undefined,
          };

          if (!result.success) {
            failedProcessors.push(processor.name);
            logger.warn(`[kimi-adapter] Processor ${processor.name} failed: ${result.message}`);
          } else {
            logger.debug(`[kimi-adapter] Processor ${processor.name} succeeded: ${result.message}`);
          }

          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[kimi-adapter] Processor ${processor.name} threw error:`, error);

          processorResults[processor.name] = {
            success: false,
            message: errorMessage,
          };
          failedProcessors.push(processor.name);
        }
      }

      const result: AggregatedResult = {
        success: failedProcessors.length === 0,
        processors: processorResults,
        totalRecords,
        failedProcessors,
      };

      logger.debug(
        `[kimi-adapter] Processing complete: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
        `(${totalRecords} records, ${failedProcessors.length} failed processors)`
      );

      return result;
    } catch (error) {
      logger.error(`[kimi-adapter] Session processing failed:`, error);
      throw error;
    }
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
