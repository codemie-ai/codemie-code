// src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts
/**
 * OpenCode Metrics Processor
 *
 * Transforms OpenCode session messages into MetricDelta records and writes
 * them to JSONL for eventual sync to CodeMie API.
 *
 * Per tech spec "Fix OpenCode Metrics Sync":
 * - Loads parts from storage/part/{messageID}/
 * - Extracts tool usage, file operations, user prompts
 * - Creates MetricDelta records per assistant message (ADR-16)
 * - Writes to JSONL via MetricsWriter with status: 'pending'
 * - Implements deduplication to prevent duplicate deltas
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta, FileOperationType } from '../../../../core/metrics/types.js';
import type {
  OpenCodeMessage,
  OpenCodeAssistantMessage,
  OpenCodePart,
  OpenCodeToolPart,
  OpenCodeMetadata,
} from '../../opencode-message-types.js';
import { isToolPart } from '../../opencode-message-types.js';
import { readJsonlTolerant, loadPartsForMessage } from '../../opencode.storage-utils.js';
import { logger } from '../../../../../utils/logger.js';
import { existsSync } from 'fs';
import { join } from 'path';

// NOTE: the former 60s REPROCESS_COOLDOWN_MS gate was removed deliberately.
// It predated incremental sync and would swallow every timer tick, stranding
// deltas on disk. Deduplication on `recordId` already makes process()
// idempotent, and the sync timer holds its own in-flight guard.

/**
 * Map an apply_patch/patch per-file operation kind to a MetricDelta file
 * operation type. The aggregator counts 'write' as files_created, 'edit' as
 * files_modified and 'delete' as files_deleted.
 */
function mapPatchFileType(type: unknown): FileOperationType {
  switch (type) {
    case 'add': return 'write';
    case 'delete': return 'delete';
    case 'update': return 'edit';
    default: return 'edit';
  }
}

/** Emitted delta shape before MetricsWriter stamps sync bookkeeping onto it. */
type PendingDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;

/** File operation entry as carried on a MetricDelta. */
type DeltaFileOperation = NonNullable<MetricDelta['fileOperations']>[number];

/**
 * Count added/removed lines in a unified diff.
 *
 * OpenCode reports edits as patch text (`state.metadata.filediff.patch`,
 * `state.metadata.diff`, `apply_patch` per-file `patch`); unlike Claude it never
 * emits numeric additions/deletions, so the counts have to come from the diff.
 */
export function countDiffLines(patch: unknown): { linesAdded: number; linesRemoved: number } {
  if (typeof patch !== 'string' || patch.length === 0) {
    return { linesAdded: 0, linesRemoved: 0 };
  }

  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of patch.split('\n')) {
    // Skip hunk headers and the ---/+++ file header pair, which are not content.
    // The header test requires the trailing space git always emits ("--- a/x"),
    // so a *content* line that merely starts with --- or +++ (a markdown rule, a
    // YAML document separator) is still counted instead of silently dropped.
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }

  return { linesAdded, linesRemoved };
}

/**
 * OpenCode Metrics Processor
 *
 * Aggregates token usage, extracts tool/file metrics from parts,
 * and writes MetricDelta records to JSONL.
 */
export class OpenCodeMetricsProcessor implements SessionProcessor {
  readonly name = 'opencode-metrics';
  readonly priority = 1;  // Run first (before conversations)

  /**
   * Check if session has data to process
   */
  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  /**
   * Process session to aggregate metrics and write JSONL deltas
   *
   * Per tech spec ADR-1/G2: Validate metadata at START before any processing
   */
  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      // MANDATORY: Validate metadata has required fields (ADR-1, Review 13 G2)
      const metadata = session.metadata as Record<string, unknown>;
      if (!metadata.storagePath || typeof metadata.storagePath !== 'string') {
        return {
          success: false,
          message: 'Missing storagePath in session.metadata (adapter not updated)',
          metadata: { failureReason: 'NO_STORAGE_PATH' }
        };
      }
      if (!metadata.openCodeSessionId || typeof metadata.openCodeSessionId !== 'string') {
        logger.warn('[opencode-metrics] Missing openCodeSessionId, using fallback');
      }

      const storagePath = metadata.storagePath;
      const openCodeSessionId = (metadata.openCodeSessionId as string) || 'unknown';

      const messages = session.messages as OpenCodeMessage[];

      // Transform messages to deltas
      // Cast metadata to OpenCodeMetadata (validated above)
      const openCodeMetadata: OpenCodeMetadata = {
        projectPath: metadata.projectPath as string | undefined,
        createdAt: metadata.createdAt as string | undefined,
        updatedAt: metadata.updatedAt as string | undefined,
        storagePath,
        openCodeSessionId,
        openCodeVersion: metadata.openCodeVersion as string | undefined,
        partsMap: metadata.partsMap as Record<string, OpenCodePart[]> | undefined,
        storageType: metadata.storageType as 'sqlite' | 'file' | undefined,
      };

      // Branch attribution: the aggregator groups deltas by gitBranch and emits
      // one codemie_cli_tool_usage_total per branch. Without this every delta
      // lands in the empty-string bucket.
      const gitBranch = await this.resolveBranch(context, openCodeMetadata);

      const { deltas, stats } = await this.transformMessagesToDeltas(
        messages,
        session.sessionId,
        openCodeSessionId,
        storagePath,
        openCodeMetadata,
        gitBranch
      );

      if (deltas.length === 0) {
        logger.debug(`[opencode-metrics] No new deltas to write for session ${session.sessionId}`);

        return {
          success: true,
          message: `No new deltas (${stats.skippedDueToDedup} already processed)`,
          metadata: {
            recordsProcessed: messages.length,
            deltasWritten: 0,
            deltasSkipped: stats.skippedDueToDedup,
            ...stats
          }
        };
      }

      // Write deltas to JSONL
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);

      logger.debug(`[opencode-metrics] Writing to: ${writer.getFilePath()}`);

      for (const delta of deltas) {
        // Log delta details for debugging
        logger.debug(`[opencode-metrics] Delta ${delta.recordId}:`, {
          tools: Object.keys(delta.tools || {}),
          toolStatus: delta.toolStatus ? Object.keys(delta.toolStatus) : [],
          fileOps: (delta.fileOperations || []).length,
          models: delta.models,
          userPrompts: (delta as any).userPrompts?.length || 0
        });

        await writer.appendDelta(delta);
      }

      logger.info(`[opencode-metrics] Wrote ${deltas.length} deltas for session ${session.sessionId}`);
      logger.info(`[opencode-metrics] Metrics file: ${writer.getFilePath()}`);

      return {
        success: true,
        message: `Generated ${deltas.length} deltas`,
        metadata: {
          recordsProcessed: messages.length,
          deltasWritten: deltas.length,
          deltasSkipped: stats.skippedDueToDedup,
          ...stats
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[opencode-metrics] Processing failed:`, error);
      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`,
        metadata: { failureReason: 'PROCESSING_ERROR' }
      };
    }
  }

  /**
   * Resolve the git branch every delta in this batch is attributed to.
   *
   * Mirrors codex.metrics-processor's resolveBranch: prefer the branch the CLI
   * already resolved (BaseAgentAdapter sets CODEMIE_GIT_BRANCH before spawning),
   * then the value the adapter overlaid onto session metadata, then detect it.
   */
  private async resolveBranch(
    context: ProcessingContext,
    sessionMetadata: OpenCodeMetadata & { gitBranch?: string }
  ): Promise<string | undefined> {
    if (context.gitBranch) return context.gitBranch;
    if (sessionMetadata.gitBranch) return sessionMetadata.gitBranch;
    if (!sessionMetadata.projectPath) return undefined;

    try {
      const { detectGitBranch } = await import('../../../../../utils/processes.js');
      return (await detectGitBranch(sessionMetadata.projectPath)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Transform messages to MetricDelta records.
   *
   * One delta per tool call (`{messageId}:{callID}`), per user prompt
   * (`{messageId}:prompt`) and per failed turn (`{messageId}:error`).
   *
   * Granularity matters: when the recordId was the bare assistant message id,
   * the first incremental tick claimed the message and every tool that message
   * accumulated afterwards was deduped away and never reported.
   */
  private async transformMessagesToDeltas(
    messages: OpenCodeMessage[],
    codemieSessionId: string,
    openCodeSessionId: string,
    storagePath: string,
    sessionMetadata: OpenCodeMetadata,
    gitBranch: string | undefined
  ): Promise<{
    deltas: PendingDelta[];
    stats: { skippedDueToDedup: number };
  }> {
    const deltas: PendingDelta[] = [];
    const stats = { skippedDueToDedup: 0 };

    // Single read of the existing JSONL — recordId dedup is the only state needed.
    const existingRecordIds = await this.getExistingRecordIds(codemieSessionId);

    const base = (recordId: string, timestamp: number): PendingDelta => ({
      recordId,
      sessionId: codemieSessionId,
      agentSessionId: openCodeSessionId,
      timestamp,
      ...(gitBranch && { gitBranch }),
    });

    for (const msg of messages) {
      const timestamp = this.resolveTimestamp(msg, sessionMetadata);

      if (msg.role === 'user') {
        const recordId = `${msg.id}:prompt`;
        if (existingRecordIds.has(recordId)) {
          stats.skippedDueToDedup++;
          continue;
        }

        const text = await this.extractUserPromptText(
          msg, storagePath, openCodeSessionId, sessionMetadata.partsMap
        );
        if (!text) continue;

        deltas.push({ ...base(recordId, timestamp), userPrompts: [{ count: 1, text }] });
        continue;
      }

      const assistantMsg = msg as OpenCodeAssistantMessage;
      const modelString = this.getValidModelString(assistantMsg.modelID);

      const parts = await loadPartsForMessage(
        storagePath, assistantMsg.id, openCodeSessionId, sessionMetadata.partsMap
      );

      for (const part of parts.filter(isToolPart) as OpenCodeToolPart[]) {
        // callID is the semantically meaningful key, but older sessions and
        // some tools omit it; part.id is the storage primary key and is always
        // present, so it guarantees the recordId stays collision-free.
        const recordId = `${assistantMsg.id}:${part.callID || part.id}`;
        if (existingRecordIds.has(recordId)) {
          stats.skippedDueToDedup++;
          continue;
        }

        const toolDelta = this.buildToolDelta(part, base(recordId, timestamp), modelString);
        if (toolDelta) deltas.push(toolDelta);
      }

      // Turn-level failure. This is OpenCode's analogue of Claude's
      // isApiErrorMessage entries and the ONLY source of apiErrorMessage —
      // tool failures stay in toolStatus, exactly as codemie-claude does, so
      // raw tool output never reaches the error_messages wire field.
      if (assistantMsg.error) {
        const recordId = `${assistantMsg.id}:error`;
        if (existingRecordIds.has(recordId)) {
          stats.skippedDueToDedup++;
          continue;
        }

        const detail = assistantMsg.error.data?.message;
        deltas.push({
          ...base(recordId, timestamp),
          apiErrorMessage: detail
            ? `${assistantMsg.error.name}: ${detail}`
            : assistantMsg.error.name,
          ...(modelString && { models: [modelString] }),
        });
      }
    }

    return { deltas, stats };
  }

  /**
   * Build a single-tool delta, or undefined when the tool is still in flight.
   */
  private buildToolDelta(
    part: OpenCodeToolPart,
    delta: PendingDelta,
    modelString: string | undefined
  ): PendingDelta | undefined {
    const toolName = part.tool.toLowerCase();
    const statusResult = this.mapToolStatus(part.state.status);

    // pending/running tools are not counted at all — a later tick picks them up
    // once they settle, and the recordId keeps that second visit idempotent.
    if (statusResult === 'skip') return undefined;

    const fileOperations = statusResult === 'success'
      ? this.extractFileOperation(part.tool, part.state.input, part.state.metadata)
      : [];

    return {
      ...delta,
      tools: { [toolName]: 1 },
      toolStatus: {
        [toolName]: {
          success: statusResult === 'success' ? 1 : 0,
          failure: statusResult === 'failure' ? 1 : 0,
        },
      },
      ...(fileOperations.length > 0 && { fileOperations }),
      ...(modelString && { models: [modelString] }),
    };
  }

  /**
   * Resolve timestamp with fallback chain (ADR-13 G4)
   */
  private resolveTimestamp(
    msg: OpenCodeMessage,
    sessionMetadata: OpenCodeMetadata
  ): number {
    // Primary: message timestamp
    if (msg.time?.created && typeof msg.time.created === 'number') {
      return msg.time.created;
    }

    // Fallback: session updated time
    if (sessionMetadata.updatedAt) {
      const parsed = new Date(sessionMetadata.updatedAt).getTime();
      if (!isNaN(parsed)) {
        logger.debug(`[opencode-metrics] Using session updatedAt for message ${msg.id}`);
        return parsed;
      }
    }

    // Last resort: current time
    logger.warn(`[opencode-metrics] Missing timestamp for message ${msg.id}, using Date.now()`);
    return Date.now();
  }

  /**
   * Map tool status to success/failure/skip (ADR-14)
   */
  private mapToolStatus(status: string): 'success' | 'failure' | 'skip' {
    switch (status.toLowerCase()) {
      case 'completed':
        return 'success';
      case 'error':
        return 'failure';
      case 'pending':
      case 'running':
        return 'skip';  // Don't count incomplete tools
      default:
        logger.debug(`[opencode-metrics] Unknown tool status: ${status}`);
        return 'skip';
    }
  }

  /**
   * Extract file operation from tool call (ADR-8, ADR-17)
   * Only emits allowed file operation types.
   */
  private extractFileOperation(
    toolName: string,
    input: Record<string, unknown> | undefined,
    metadata?: Record<string, unknown>
  ): DeltaFileOperation[] {
    const toolLower = toolName.toLowerCase();
    const operations: DeltaFileOperation[] = [];

    // Map tools to allowed types (ADR-8)
    const typeMapping: Record<string, FileOperationType> = {
      'read': 'read',
      'write': 'write',
      'edit': 'edit',
      'glob': 'glob',
      'grep': 'grep',
      'apply_patch': 'edit',  // per-file type refines this below
      'patch': 'edit',        // per-file type refines this below
      'multiedit': 'edit',    // Map to edit, not multiedit
    };

    const mappedType = typeMapping[toolLower];
    if (!mappedType) return [];

    // apply_patch / patch — state.metadata.files carries one entry per touched
    // file with its own operation kind and diff (ADR-17). The per-file `type` is
    // what makes files_deleted reachable; mapping every entry to 'edit' left it
    // permanently 0.
    if (toolLower === 'apply_patch' || toolLower === 'patch') {
      const files = metadata?.files as Array<{
        filePath?: string;
        relativePath?: string;
        type?: string;
        patch?: string;
      }> | undefined;

      if (Array.isArray(files)) {
        for (const file of files) {
          const path = file.filePath || file.relativePath;
          if (typeof path !== 'string') continue;

          const { linesAdded, linesRemoved } = countDiffLines(file.patch);
          operations.push({
            type: mapPatchFileType(file.type),
            path,
            ...(linesAdded > 0 && { linesAdded }),
            ...(linesRemoved > 0 && { linesRemoved }),
          });
        }
      }
      return operations;
    }

    // Handle multiedit (ADR-17)
    if (toolLower === 'multiedit') {
      const edits = input?.edits as Array<{ filePath: string }> | undefined;
      if (Array.isArray(edits)) {
        for (const edit of edits) {
          if (typeof edit.filePath === 'string') {
            operations.push({ type: 'edit', path: edit.filePath });
          }
        }
      }
      return operations;
    }

    const fileOp: DeltaFileOperation = { type: mappedType };

    // Per ADR-17: field names are camelCase (filePath, not file_path)
    const filePath = input?.filePath || input?.path;
    if (typeof filePath === 'string') {
      fileOp.path = filePath;
    }

    if (typeof input?.pattern === 'string') {
      fileOp.pattern = input.pattern;
    }

    if (toolLower === 'write') {
      // A write creates the whole file, so every line is an addition. Matches
      // claude-file-operation.ts, which counts Write content lines the same way.
      const content = input?.content;
      if (typeof content === 'string' && content.length > 0) {
        fileOp.linesAdded = content.split('\n').length;
      }
    }

    if (toolLower === 'edit') {
      // OpenCode reports the edit as diff text; there is no numeric count.
      const filediff = metadata?.filediff as { patch?: string } | undefined;
      const { linesAdded, linesRemoved } = countDiffLines(filediff?.patch ?? metadata?.diff);
      if (linesAdded > 0) fileOp.linesAdded = linesAdded;
      if (linesRemoved > 0) fileOp.linesRemoved = linesRemoved;
    }

    operations.push(fileOp);
    return operations;
  }

  /**
   * Extract user prompt text from message (ADR-10, ADR-20)
   */
  private async extractUserPromptText(
    msg: OpenCodeMessage,
    storagePath: string,
    sessionId?: string,
    partsMap?: Record<string, OpenCodePart[]>
  ): Promise<string | undefined> {
    // Try pre-loaded partsMap first (SQLite path), then file-based
    const hasParts = partsMap?.[msg.id] || existsSync(join(storagePath, 'part', msg.id));
    if (hasParts) {
      const parts = await loadPartsForMessage(storagePath, msg.id, sessionId, partsMap);
      // Filter: exclude ignored and synthetic parts (ADR-10)
      const textParts = parts.filter(p =>
        p.type === 'text' &&
        'text' in p &&
        !(p as any).ignored &&
        !(p as any).synthetic
      );

      if (textParts.length > 0) {
        const combinedText = textParts
          .map(p => (p as { type: 'text'; text: string }).text)
          .filter(t => t?.trim())
          .join('\n');

        if (combinedText) {
          return combinedText;
        }
      }
    }

    // Fallback: check message.summary.title (ADR-20)
    if ((msg as any).summary?.title) {
      return (msg as any).summary.title;
    }

    // No text found
    return undefined;
  }

  /**
   * Get existing record IDs for deduplication (ADR-5).
   * Single tolerant read of the JSONL — corrupted lines are skipped.
   */
  private async getExistingRecordIds(sessionId: string): Promise<Set<string>> {
    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);

      if (!writer.exists()) {
        return new Set();
      }

      const existingDeltas = await readJsonlTolerant<MetricDelta>(writer.getFilePath());
      return new Set(existingDeltas.map(d => d.recordId));
    } catch (error) {
      logger.warn('[opencode-metrics] Could not read existing deltas:', error);
      return new Set();
    }
  }

  /**
   * Get valid model string (ADR-6).
   *
   * Returns the BARE model id. codemie-claude reports `llm_model` without a
   * provider prefix, so emitting `codemie-proxy/<model>` here would split the
   * same model into two buckets in backend analytics. The provider stays on
   * session metadata for local traceability.
   */
  private getValidModelString(modelID?: string): string | undefined {
    return modelID?.trim() || undefined;
  }

}

