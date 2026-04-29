import type { AggregatedResult, ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext, SessionProcessor } from '@/agents/core/session/BaseProcessor.js';
import { ConversationsProcessor } from '@/agents/plugins/claude/session/processors/claude.conversations-processor.js';
import { MetricsProcessor } from '@/agents/plugins/claude/session/processors/claude.metrics-processor.js';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { logger } from '@/utils/logger.js';
import type { LocalTelemetryAdapter, LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import { discoverClaudeDesktopSessions } from './claude-desktop.discovery.js';
import { parseClaudeDesktopSession } from './claude-desktop.parser.js';

export class ClaudeDesktopTelemetryAdapter implements LocalTelemetryAdapter {
  readonly clientType = 'claude-desktop';
  private readonly processors: SessionProcessor[] = [];
  private readonly sessionStore = new SessionStore();

  constructor() {
    this.registerProcessor(new MetricsProcessor());
    this.registerProcessor(new ConversationsProcessor());
  }

  async discoverSessions(sinceMs: number): Promise<LocalTelemetryDiscoveredSession[]> {
    return discoverClaudeDesktopSessions(sinceMs);
  }

  async parseSession(
    discovered: LocalTelemetryDiscoveredSession,
    codemieSessionId: string
  ): Promise<ParsedSession> {
    return parseClaudeDesktopSession(discovered, codemieSessionId);
  }

  private registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
  }

  private async applySyncUpdates(
    sessionId: string,
    results: Array<{ metadata?: Record<string, unknown> }>
  ): Promise<void> {
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session) {
      logger.warn(`[claude-desktop-adapter] Session not found for sync updates: ${sessionId}`);
      return;
    }

    for (const result of results) {
      const syncUpdates = (result.metadata as { syncUpdates?: any } | undefined)?.syncUpdates;
      if (!syncUpdates) continue;

      if (syncUpdates.metrics) {
        session.sync ??= {};
        session.sync.metrics ??= {
          lastProcessedTimestamp: Date.now(),
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0
        };

        if (syncUpdates.metrics.processedRecordIds) {
          const existing = new Set(session.sync.metrics.processedRecordIds || []);
          for (const id of syncUpdates.metrics.processedRecordIds) {
            existing.add(id);
          }
          session.sync.metrics.processedRecordIds = Array.from(existing);
        }

        if (syncUpdates.metrics.totalDeltas !== undefined) {
          session.sync.metrics.totalDeltas =
            (session.sync.metrics.totalDeltas || 0) + syncUpdates.metrics.totalDeltas;
        }
        if (syncUpdates.metrics.lastProcessedTimestamp !== undefined) {
          session.sync.metrics.lastProcessedTimestamp = syncUpdates.metrics.lastProcessedTimestamp;
        }
      }

      if (syncUpdates.conversations) {
        session.sync ??= {};
        session.sync.conversations ??= {
          lastSyncedMessageUuid: undefined,
          lastSyncedHistoryIndex: -1,
          totalMessagesSynced: 0,
          totalSyncAttempts: 0
        };

        if (syncUpdates.conversations.lastSyncedMessageUuid !== undefined) {
          session.sync.conversations.lastSyncedMessageUuid =
            syncUpdates.conversations.lastSyncedMessageUuid;
        }
        if (syncUpdates.conversations.lastSyncedHistoryIndex !== undefined) {
          session.sync.conversations.lastSyncedHistoryIndex = Math.max(
            session.sync.conversations.lastSyncedHistoryIndex ?? -1,
            syncUpdates.conversations.lastSyncedHistoryIndex
          );
        }
      }
    }

    await this.sessionStore.saveSession(session);
  }

  async processParsedSession(
    parsedSession: ParsedSession,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    const processorResults: AggregatedResult['processors'] = {};
    const failedProcessors: string[] = [];
    const allResults: Array<{ metadata?: Record<string, unknown> }> = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      if (!processor.shouldProcess(parsedSession)) {
        continue;
      }

      try {
        const result = await processor.process(parsedSession, context);
        allResults.push(result);
        processorResults[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed: result.metadata?.recordsProcessed as number | undefined
        };

        if (!result.success) {
          failedProcessors.push(processor.name);
        }

        if (typeof result.metadata?.recordsProcessed === 'number') {
          totalRecords += result.metadata.recordsProcessed;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        processorResults[processor.name] = { success: false, message };
        failedProcessors.push(processor.name);
      }
    }

    await this.applySyncUpdates(parsedSession.sessionId, allResults);

    return {
      success: failedProcessors.length === 0,
      processors: processorResults,
      totalRecords,
      failedProcessors
    };
  }
}
