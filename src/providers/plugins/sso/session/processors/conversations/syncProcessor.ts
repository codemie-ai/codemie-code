/**
 * Conversation Sync Processor (Factory Pattern)
 *
 * Lightweight processor that syncs conversation payloads to CodeMie API.
 *
 * Responsibilities:
 * - Read pending conversation payloads from JSONL (written by agent adapters)
 * - Send payloads to CodeMie API
 * - Mark payloads as 'success' or 'failed' atomically
 *
 * Note: Message transformation is handled by agent adapters (e.g., Claude's ConversationsProcessor)
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '@/providers/plugins/sso/session/BaseProcessor.js';
import { shouldStopSync, SyncStoppedError } from '@/agents/core/session/BaseProcessor.js';
import type { ParsedSession } from '@/providers/plugins/sso/session/BaseSessionAdapter.js';
import type { ConversationPayloadRecord } from './types.js';
import { CONVERSATION_SYNC_STATUS } from './types.js';
import {
  collapseSupersededPayloads,
  getPayloadId,
  healSyncedDuplicates,
  isSendCandidate
} from './payload-queue.js';
import { logger } from '@/utils/logger.js';
import { createApiClient as createConversationApiClient } from './apiClient.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { rewriteSessionFile } from '../../utils/locked-jsonl.js';
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  CODEMIE_ASSISTANT_ID,
  DEFAULT_CONVERSATION_FOLDER,
  CONVERSATION_PROCESSOR_PRIORITY,
  CONVERSATION_PROCESSOR_NAME,
  MAX_CONVERSATION_PAYLOADS_PER_RUN
} from './constants.js';

/**
 * Create a conversation sync processor instance
 * @returns SessionProcessor instance
 */
export function createSyncProcessor(): SessionProcessor {
  // Private state (closure)
  let isSyncing = false; // Concurrency guard

  /**
   * Process conversations for sync
   */
  async function processConversations(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') {
      logger.debug('[conv-sync] Conversation sync disabled for this session (CODEMIE_CONV_SYNC_DISABLED=1)');
      return { success: true, message: 'Conversation sync disabled for external session resume' };
    }
    if (isSyncing) {
      return { success: true, message: 'Sync in progress' };
    }
    isSyncing = true;

    try {
      // Read conversation payloads from JSONL
      const conversationsFile = getSessionConversationPath(session.sessionId);
      const allPayloads = await readJSONLTolerant<ConversationPayloadRecord>(conversationsFile, `[${CONVERSATION_PROCESSOR_NAME}]`);
      const pendingPayloads = await prepareSendList(allPayloads, session.sessionId, context);
      if (pendingPayloads === undefined) {
        return { success: true, message: 'Sync deferred: conversation file gone' };
      }

      // EPMCDME-17142: the same session-frozen work-consent boundary as the legacy /v1/metrics path (anthropic-subscription only)
      const withheld = await consentGateWithholds(session.sessionId, pendingPayloads, context);
      if (withheld) return withheld;

      if (pendingPayloads.length === 0) {
        logger.debug(`[${CONVERSATION_PROCESSOR_NAME}] No pending conversation payloads for session ${session.sessionId}`);
        return { success: true, message: 'No pending payloads' };
      }

      logger.info(`[${CONVERSATION_PROCESSOR_NAME}] Syncing ${pendingPayloads.length} conversation payload${pendingPayloads.length !== 1 ? 's' : ''}`);

      // Initialize API client
      const apiClient = createConversationApiClient({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        apiKey: context.apiKey,
        timeout: DEFAULT_API_TIMEOUT_MS,
        retryAttempts: DEFAULT_RETRY_ATTEMPTS,
        version: context.version,
        clientType: context.clientType,
        dryRun: context.dryRun,
        deadlineMs: context.syncDeadlineMs,
        abortSignal: context.abortSignal,
        credentialsSuperseded: context.credentialsSuperseded
      });

      // Send each pending payload to API
      let successCount = 0;
      let totalMessages = 0;
      let deferred = false;
      let consumedCount = 0;
      let lastSentConversationId: string | undefined;
      const successfulPayloadIds = new Set<string>();
      const failedByPayloadId = new Map<string, string>();
      // payloadId -> syncError of the payloads sent this run whose outcome is not on disk yet, in send order;
      // a persisted outcome is never applied again, so a failed send counts one attempt
      const unpersistedOutcomes = new Map<string, string | undefined>();

      for (const pendingPayload of pendingPayloads) {
        // Stop BEFORE sending the next payload when the caller's sync deadline
        // expired or an abort was signaled (the SessionEnd hook can be killed at
        // any moment; leftovers stay pending for the next run).
        if (shouldStopSync(context)) {
          deferred = true;
          break;
        }
        consumedCount++;

        const payloadId = getPayloadId(pendingPayload);
        // Each payloadId is sent at most once per run: its outcome was already
        // applied to every record sharing the id.
        if (successfulPayloadIds.has(payloadId) || failedByPayloadId.has(payloadId)) {
          continue;
        }
        const { conversationId, history, assistantId, folder, llmModel } = pendingPayload.payload;
        const resolvedAssistantId = assistantId || CODEMIE_ASSISTANT_ID;
        const resolvedFolder = folder || resolveConversationFolder(context.clientType, session.agentName);

        logger.debug(
          `[${CONVERSATION_PROCESSOR_NAME}] Sending payload: conversationId=${conversationId}, ` +
          `messages=${history.length}, folder=${resolvedFolder}, llmModel=${llmModel || 'unknown'}, ` +
          `isTurnContinuation=${pendingPayload.isTurnContinuation}`
        );

        let syncError: string | undefined;
        try {

          // Send to API
          const response = await apiClient.upsertConversation(
            conversationId,
            history,
            resolvedAssistantId,
            resolvedFolder,
            llmModel
          );

          if (!response.success) {
            logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to sync conversation ${conversationId}: ${response.message}`);
            syncError = response.message;
          } else {
            logger.info(`[${CONVERSATION_PROCESSOR_NAME}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);
            successCount++;
            totalMessages += history.length;
            successfulPayloadIds.add(payloadId);
            lastSentConversationId = conversationId;
          }

        } catch (error: any) {
          if (error instanceof SyncStoppedError) {
            // Stopped by the caller's abort / deadline: this payload stays pending
            deferred = true;
            consumedCount--;
            break;
          }
          logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Error syncing conversation ${conversationId}:`, error.message);
          syncError = error.message || 'Unknown error';
        }

        if (syncError) {
          failedByPayloadId.set(payloadId, syncError);
        }

        // Persist the outcomes immediately (atomic full-file rewrite).
        // A kill mid-loop must never lose progress made so far. The file is re-read under its lock and
        // every outcome of this run applied by payloadId, so a payload appended during the network wait is kept.
        applyPayloadOutcome(allPayloads, payloadId, syncError);
        unpersistedOutcomes.set(payloadId, syncError);
        let rewritten: boolean;
        try {
          rewritten = await rewriteSessionFile<ConversationPayloadRecord>('conversation', session.sessionId, (current) => {
            for (const [outcomeId, outcomeError] of unpersistedOutcomes) {
              applyPayloadOutcome(current, outcomeId, outcomeError);
            }
            return current;
          }, context);
        } catch (writeError) {
          // Keep going: the next payload's rewrite applies this outcome; after the last one it stays pending on disk
          logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to persist payload outcome:`, writeError);
          continue;
        }
        if (!rewritten) {
          logger.warn(`[${CONVERSATION_PROCESSOR_NAME}] Conversation file of session ${session.sessionId} is gone, sync outcome dropped; run stopped`);
          deferred = true;
          break;
        }
        unpersistedOutcomes.clear();
      }

      const syncedAt = Date.now();
      const remainingCount = pendingPayloads.length - consumedCount;

      const message = deferred
        ? `Sync deferred: ${remainingCount} items remaining (deadline/abort)`
        : `Synced ${successCount}/${pendingPayloads.length} conversations`;

      if (deferred) {
        logger.info(`[${CONVERSATION_PROCESSOR_NAME}] ${message} (${successCount} synced before stop)`);
      } else {
        logger.info(
          `[${CONVERSATION_PROCESSOR_NAME}] Successfully synced ${successCount}/${pendingPayloads.length} conversations (${totalMessages} messages)`
        );
      }

      // Calculate sync updates for the adapter to persist. lastSyncedMessageUuid is
      // deliberately not reported: each transform processor owns its own pointer, and
      // rewriting it here from the latest *successful* payload rewound it past turns
      // that were queued but not yet synced, re-queueing them as duplicates.
      let maxHistoryIndex = -1;
      const historyIndexByConversation: Record<string, number> = {};
      for (const payload of pendingPayloads) {
        if (!successfulPayloadIds.has(getPayloadId(payload))) continue;
        const { conversationId } = payload.payload;
        for (const historyIndex of payload.historyIndices || []) {
          maxHistoryIndex = Math.max(maxHistoryIndex, historyIndex);
          historyIndexByConversation[conversationId] = Math.max(historyIndexByConversation[conversationId] ?? -1, historyIndex);
        }
      }

      // Debug: Log which payloads were marked as synced
      logger.debug(`[${CONVERSATION_PROCESSOR_NAME}] Marked payloads as synced:`, {
        syncedAt: new Date(syncedAt).toISOString(),
        payloadIds: Array.from(successfulPayloadIds),
        failedPayloadIds: Array.from(failedByPayloadId.keys()),
        totalPayloadsInFile: allPayloads.length,
        syncedCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).length,
        failedCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.FAILED).length,
        pendingCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.PENDING).length
      });

      return {
        success: true,
        message,
        metadata: {
          conversationId: session.sessionId,
          messagesProcessed: totalMessages,
          payloadsSynced: successCount,
          syncUpdates: successCount > 0 ? {
            conversations: {
              lastSyncedHistoryIndex: maxHistoryIndex,
              historyIndexByConversation,
              conversationId: lastSentConversationId,
              totalMessagesSynced: totalMessages,
              totalSyncAttempts: 1,
              lastSyncAt: syncedAt
            }
          } : undefined
        }
      };

    } catch (error) {
      logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Processing failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      isSyncing = false;
    }
  }

  // Public interface (SessionProcessor)
  return {
    name: CONVERSATION_PROCESSOR_NAME,
    priority: CONVERSATION_PROCESSOR_PRIORITY,
    shouldProcess(_session: ParsedSession): boolean {
      // Always try to process - will check for pending payloads inside
      return true;
    },
    async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
      return processConversations(session, context);
    }
  };
}

function resolveConversationFolder(clientType?: string, agentName?: string): string {
  if (clientType === 'codemie-codex' || clientType === 'codemie-codex-acp' || agentName === 'codex' || agentName === 'codex-acp') {
    return 'codex';
  }
  if (clientType === 'codemie-copilot' || agentName === 'copilot-cli') {
    return 'copilot-cli';
  }
  if (clientType === 'codemie-gemini' || clientType === 'codemie-gemini-acp' || agentName === 'gemini' || agentName === 'gemini-acp') {
    return 'gemini';
  }
  if (clientType === 'codemie-claude' || agentName === 'claude') {
    return 'claude';
  }
  if (clientType === 'codemie-opencode' || clientType === 'codemie-opencode-acp' || agentName === 'opencode' || agentName === 'opencode-acp') {
    return 'opencode';
  }
  if (clientType === 'codemie-pi' || agentName === 'pi') {
    return 'pi';
  }
  return DEFAULT_CONVERSATION_FOLDER;
}

/**
 * Prepare the queue for sending: heal → collapse → persist → cap.
 * Mutates `allPayloads` in place and persists healed/superseded statuses before
 * anything is sent, so even a run that defers immediately keeps them.
 *
 * The per-run cap applies only to unbounded runs (proxy timer, onProxyStop). A
 * deadline-bounded run (SessionEnd, the wrapper's exit) defers only on the deadline;
 * whatever it leaves stays pending and keeps the session undelivered — its record
 * is not renamed `completed_` — until a later run delivers it.
 *
 * @returns the payloads to send this run, in queue order; undefined when the live file is gone
 */
async function prepareSendList(
  allPayloads: ConversationPayloadRecord[],
  sessionId: string,
  context: ProcessingContext
): Promise<ConversationPayloadRecord[] | undefined> {
  // Heal: a candidate whose payloadId already has a success record was synced.
  const healedCount = healSyncedDuplicates(allPayloads);

  // Collapse: an older candidate whose every entry a newer candidate re-sends is
  // superseded (terminal, never sent). Candidates share object identity with
  // allPayloads, so the in-place status change is what gets persisted.
  const sendCandidates = allPayloads.filter(isSendCandidate);
  const supersededCount = collapseSupersededPayloads(sendCandidates);

  if (healedCount > 0 || supersededCount > 0) {
    logger.debug(
      `[${CONVERSATION_PROCESSOR_NAME}] Healed ${healedCount} already-synced and superseded ` +
      `${supersededCount} fully covered payload(s)`
    );
    try {
      const rewritten = await rewriteSessionFile<ConversationPayloadRecord>('conversation', sessionId, (current) => {
        healSyncedDuplicates(current);
        collapseSupersededPayloads(current.filter(isSendCandidate));
        return current;
      }, context);
      if (!rewritten) {
        logger.warn(`[${CONVERSATION_PROCESSOR_NAME}] Conversation file of session ${sessionId} is gone; nothing sent`);
        return undefined;
      }
    } catch (writeError) {
      logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to persist healed/superseded payloads:`, writeError);
    }
  }

  const unsentPayloads = sendCandidates.filter(p => p.status !== CONVERSATION_SYNC_STATUS.SUPERSEDED);
  if (context.syncDeadlineMs !== undefined || unsentPayloads.length <= MAX_CONVERSATION_PAYLOADS_PER_RUN) {
    return unsentPayloads;
  }

  // Cap: send oldest first, at most MAX_CONVERSATION_PAYLOADS_PER_RUN; the rest wait as they are.
  logger.debug(
    `[${CONVERSATION_PROCESSOR_NAME}] Per-run cap reached: deferring ` +
    `${unsentPayloads.length - MAX_CONVERSATION_PAYLOADS_PER_RUN} payload(s) to the next run`
  );
  return unsentPayloads.slice(0, MAX_CONVERSATION_PAYLOADS_PER_RUN);
}

/**
 * Apply a payload's sync outcome to the in-memory records (in place).
 * Every not-yet-terminal (pending/failed) record sharing the sent payloadId gets
 * the outcome, so a duplicate of the sent turn is never left pending and re-sent.
 * The file can then be rewritten after every payload instead of only at the end.
 */
function applyPayloadOutcome(
  allPayloads: ConversationPayloadRecord[],
  payloadId: string,
  syncError: string | undefined
): void {
  allPayloads.forEach((p, index) => {
    if (getPayloadId(p) !== payloadId) {
      return;
    }
    if (p.status !== CONVERSATION_SYNC_STATUS.PENDING && p.status !== CONVERSATION_SYNC_STATUS.FAILED) {
      return;
    }

    allPayloads[index] = syncError
      ? {
        ...p,
        status: CONVERSATION_SYNC_STATUS.FAILED,
        syncAttempts: (p.syncAttempts ?? 0) + 1,
        error: syncError,
      }
      : {
        ...p,
        status: CONVERSATION_SYNC_STATUS.SUCCESS,
        syncAttempts: (p.syncAttempts ?? 0) + 1,
        error: undefined,
        response: {
          syncedCount: p.payload.history.length
        }
      };
  });
}

/**
 * The legacy work-consent gate (`legacyMetricsVerdict`: frozen consent, still held, destination accepted) for sessions of a gated
 * provider; every other provider is unchanged. A final verdict marks the queued payloads `withheld` (terminal: not sent, not a failed
 * attempt, the session counts as delivered) and persists the verdict so the metric senders agree. A transient verdict sends nothing and
 * changes nothing; a destination still awaited is not counted as a reconciliation attempt. Returns the result to report, or undefined to send.
 */
async function consentGateWithholds(
  sessionId: string,
  pending: ConversationPayloadRecord[],
  context: ProcessingContext
): Promise<ProcessingResult | undefined> {
  if (pending.length === 0) return undefined;
  const gate = await import('@/agents/core/session/legacy-metrics-gate.js');
  const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
  const record = await new SessionStore().loadSession(sessionId);
  if (!record || !gate.isLegacyGatedProvider(record.provider)) return undefined;
  const verdict = await gate.legacyMetricsVerdict(record);
  if (verdict.publish) return undefined;
  logger.debug(`[${CONVERSATION_PROCESSOR_NAME}] Conversations withheld: ${verdict.reason}`);
  if (!('transient' in verdict)) {
    await gate.persistLegacyMetricsWithheld(sessionId, verdict.reason);
    try {
      await rewriteSessionFile<ConversationPayloadRecord>('conversation', sessionId, (current) => {
        for (const p of current) {
          if (isSendCandidate(p)) {
            p.status = CONVERSATION_SYNC_STATUS.WITHHELD;
            p.error = verdict.reason;
          }
        }
        return current;
      }, context);
    } catch (writeError) {
      logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to mark withheld payloads (nothing was sent):`, writeError);
    }
  } else if (gate.awaitsDestination(verdict)) {
    const { noteAwaitingDestination } = await import('../../bounded-request.js');
    noteAwaitingDestination(context.abortSignal);
  }
  return { success: true, message: `conversations withheld: ${verdict.reason}` };
}
