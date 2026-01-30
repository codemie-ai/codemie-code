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
  OpenCodeStepFinishPart,
  OpenCodeMetadata
} from '../../opencode-message-types.js';
import { isToolPart, isStepFinishPart } from '../../opencode-message-types.js';
import { readJsonWithRetry, readJsonlTolerant } from '../../opencode.storage-utils.js';
import { logger } from '../../../../../utils/logger.js';
import { getCodemiePath } from '../../../../../utils/paths.js';
import { readdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Cooldown to prevent concurrent processing of same session (ADR-18)
const REPROCESS_COOLDOWN_MS = 60_000; // 60 seconds

/**
 * Token source tracking for observability
 */
interface TokenSource {
  source: 'message' | 'step-finish' | 'none';
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read: number; write: number };
  };
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

  private readonly cacheDir: string;

  constructor() {
    this.cacheDir = getCodemiePath('cache', 'opencode');
  }

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
  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
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

      // Check concurrent processing prevention (ADR-18)
      if (!await this.shouldProcessSession(session.sessionId)) {
        return {
          success: true,
          message: 'Session recently processed, skipping',
          metadata: { skippedReason: 'RECENTLY_PROCESSED' }
        };
      }

      const messages = session.messages as OpenCodeMessage[];

      // Transform messages to deltas
      // Cast metadata to OpenCodeMetadata (validated above)
      const openCodeMetadata: OpenCodeMetadata = {
        projectPath: metadata.projectPath as string | undefined,
        createdAt: metadata.createdAt as string | undefined,
        updatedAt: metadata.updatedAt as string | undefined,
        storagePath,
        openCodeSessionId,
        openCodeVersion: metadata.openCodeVersion as string | undefined
      };

      const { deltas, stats } = await this.transformMessagesToDeltas(
        messages,
        session.sessionId,
        openCodeSessionId,
        storagePath,
        openCodeMetadata
      );

      if (deltas.length === 0) {
        logger.debug(`[opencode-metrics] No new deltas to write for session ${session.sessionId}`);

        // Still update session.metrics for backward compat
        this.updateSessionMetrics(session, messages);

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
          tokens: delta.tokens,
          tools: Object.keys(delta.tools || {}),
          toolStatus: delta.toolStatus ? Object.keys(delta.toolStatus) : [],
          fileOps: (delta.fileOperations || []).length,
          models: delta.models,
          userPrompts: (delta as any).userPrompts?.length || 0
        });

        await writer.appendDelta(delta);
      }

      // Mark session as processed (ADR-18)
      await this.markSessionProcessed(session.sessionId);

      // Update session.metrics for backward compat
      this.updateSessionMetrics(session, messages);

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
   * Check if session should be processed (cooldown check per ADR-18)
   */
  private async shouldProcessSession(sessionId: string): Promise<boolean> {
    try {
      const lastProcessedPath = join(this.cacheDir, `${sessionId}_last_processed`);

      if (existsSync(lastProcessedPath)) {
        const lastProcessed = parseInt(await readFile(lastProcessedPath, 'utf-8'), 10);
        if (Date.now() - lastProcessed < REPROCESS_COOLDOWN_MS) {
          logger.debug(`[opencode-metrics] Session ${sessionId} processed recently, skipping`);
          return false;
        }
      }
    } catch {
      // File corrupt or missing, proceed with processing
    }

    return true;
  }

  /**
   * Mark session as processed (ADR-18)
   */
  private async markSessionProcessed(sessionId: string): Promise<void> {
    try {
      const { mkdir } = await import('fs/promises');
      if (!existsSync(this.cacheDir)) {
        await mkdir(this.cacheDir, { recursive: true });
      }
      const lastProcessedPath = join(this.cacheDir, `${sessionId}_last_processed`);
      await writeFile(lastProcessedPath, Date.now().toString());
    } catch (error) {
      logger.debug(`[opencode-metrics] Failed to mark session processed: ${error}`);
    }
  }

  /**
   * Transform messages to MetricDelta records
   *
   * Per ADR-16: One delta per assistant message with tokens
   */
  private async transformMessagesToDeltas(
    messages: OpenCodeMessage[],
    codemieSessionId: string,
    openCodeSessionId: string,
    storagePath: string,
    sessionMetadata: OpenCodeMetadata
  ): Promise<{
    deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>>;
    stats: {
      messagesWithTokens: number;
      messagesWithoutTokens: number;
      tokensFromMessage: number;
      tokensFromStepFinish: number;
      skippedDueToDedup: number;
      tokenCoverageRate: number;
    };
  }> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const stats = {
      messagesWithTokens: 0,
      messagesWithoutTokens: 0,
      tokensFromMessage: 0,
      tokensFromStepFinish: 0,
      skippedDueToDedup: 0,
      tokenCoverageRate: 0
    };

    // Get existing record IDs for deduplication (ADR-5)
    const existingRecordIds = await this.getExistingRecordIds(codemieSessionId);
    const existingDeltas = await this.readExistingDeltas(codemieSessionId);

    // Track already-attached user prompts (ADR-21)
    const alreadyAttachedPrompts = new Set<string>();
    for (const delta of existingDeltas) {
      if (delta.userPrompts) {
        for (const prompt of delta.userPrompts) {
          if (prompt.text) alreadyAttachedPrompts.add(prompt.text);
        }
      }
    }

    // Extract all user prompts
    const allUserPrompts = await this.extractUserPrompts(messages, storagePath, openCodeSessionId);

    // Filter to only NEW prompts
    const newPrompts = allUserPrompts.filter(p => !alreadyAttachedPrompts.has(p.text));
    let promptsAttached = false;

    let totalAssistantMessages = 0;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      totalAssistantMessages++;

      const assistantMsg = msg as OpenCodeAssistantMessage;

      // Check deduplication (ADR-5, ADR-15)
      if (existingRecordIds.has(assistantMsg.id)) {
        stats.skippedDueToDedup++;
        continue;
      }

      // Load parts for this message
      const parts = await this.loadPartsForMessage(storagePath, assistantMsg.id, openCodeSessionId);

      // Resolve token source (ADR-13)
      const tokenSource = await this.resolveTokenSource(assistantMsg, parts);

      if (tokenSource.source === 'none') {
        stats.messagesWithoutTokens++;
        continue;
      }

      if (tokenSource.source === 'message') {
        stats.tokensFromMessage++;
      } else {
        stats.tokensFromStepFinish++;
      }
      stats.messagesWithTokens++;

      // Extract tool metrics
      const { tools, toolStatus, fileOperations } = this.extractToolMetrics(parts);

      // Build delta (ADR-15: recordId is message.id)
      const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
        recordId: assistantMsg.id,
        sessionId: codemieSessionId,
        agentSessionId: openCodeSessionId,
        timestamp: this.resolveTimestamp(assistantMsg, sessionMetadata),
        tokens: {
          input: tokenSource.tokens!.input,
          output: tokenSource.tokens!.output,
          ...(tokenSource.tokens!.cache?.write && { cacheCreation: tokenSource.tokens!.cache.write }),
          ...(tokenSource.tokens!.cache?.read && { cacheRead: tokenSource.tokens!.cache.read })
        },
        tools,
        ...(Object.keys(toolStatus).length > 0 && { toolStatus }),
        ...(fileOperations.length > 0 && { fileOperations })
      };

      // Add model if present (ADR-6)
      const modelString = this.getValidModelString(assistantMsg.providerID, assistantMsg.modelID);
      if (modelString) {
        delta.models = [modelString];
      }

      // Attach user prompts to first NEW delta only (ADR-21)
      if (!promptsAttached && newPrompts.length > 0) {
        (delta as any).userPrompts = newPrompts;
        promptsAttached = true;
      }

      deltas.push(delta);
    }

    // Calculate coverage rate
    stats.tokenCoverageRate = totalAssistantMessages > 0
      ? stats.messagesWithTokens / totalAssistantMessages
      : 0;

    return { deltas, stats };
  }

  /**
   * Resolve token source with fallback (ADR-13)
   */
  private async resolveTokenSource(
    assistantMsg: OpenCodeAssistantMessage,
    parts: OpenCodePart[]
  ): Promise<TokenSource> {
    // Primary: message.tokens (both input AND output must be valid numbers)
    if (
      typeof assistantMsg.tokens?.input === 'number' && !isNaN(assistantMsg.tokens.input) &&
      typeof assistantMsg.tokens?.output === 'number' && !isNaN(assistantMsg.tokens.output)
    ) {
      return { source: 'message', tokens: assistantMsg.tokens };
    }

    // Fallback: step-finish parts (sorted for deterministic selection per ADR-13 G6)
    const stepFinishParts = parts
      .filter(isStepFinishPart)
      .sort((a, b) => a.id.localeCompare(b.id)) as OpenCodeStepFinishPart[];

    for (const part of stepFinishParts) {
      const tokens = part.tokens;
      if (
        typeof tokens?.input === 'number' && !isNaN(tokens.input) &&
        typeof tokens?.output === 'number' && !isNaN(tokens.output)
      ) {
        logger.debug(`[opencode-metrics] Using step-finish tokens for message ${assistantMsg.id}`);
        return { source: 'step-finish', tokens };
      }
    }

    // Neither available
    logger.warn(`[opencode-metrics] No valid tokens found for message ${assistantMsg.id}`);
    return { source: 'none' };
  }

  /**
   * Resolve timestamp with fallback chain (ADR-13 G4)
   */
  private resolveTimestamp(
    msg: OpenCodeAssistantMessage,
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
   * Load parts for a message (ADR-11 - part-message validation)
   */
  private async loadPartsForMessage(
    storagePath: string,
    messageId: string,
    expectedSessionId?: string
  ): Promise<OpenCodePart[]> {
    const partsDir = join(storagePath, 'part', messageId);

    if (!existsSync(partsDir)) {
      return [];
    }

    const parts: OpenCodePart[] = [];

    try {
      const files = await readdir(partsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const part = await readJsonWithRetry<OpenCodePart>(join(partsDir, file));
        if (!part) continue;

        // Validate part belongs to this message (ADR-11)
        if (part.messageID !== messageId) {
          logger.debug(`[opencode-metrics] Skipping orphaned part ${part.id}: messageID mismatch`);
          continue;
        }

        // Optionally validate session correlation
        if (expectedSessionId && part.sessionID !== expectedSessionId) {
          logger.debug(`[opencode-metrics] Skipping part ${part.id}: sessionID mismatch`);
          continue;
        }

        parts.push(part);
      }
    } catch (error) {
      logger.debug(`[opencode-metrics] Error loading parts from ${partsDir}:`, error);
    }

    return parts.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Extract tool metrics from parts (ADR-8, ADR-14)
   */
  private extractToolMetrics(parts: OpenCodePart[]): {
    tools: Record<string, number>;
    toolStatus: Record<string, { success: number; failure: number }>;
    fileOperations: Array<{
      type: FileOperationType;
      path?: string;
      pattern?: string;
      linesAdded?: number;
      linesRemoved?: number;
    }>;
  } {
    const tools: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: Array<{
      type: FileOperationType;
      path?: string;
      pattern?: string;
      linesAdded?: number;
      linesRemoved?: number;
    }> = [];

    const toolParts = parts.filter(isToolPart) as OpenCodeToolPart[];

    for (const part of toolParts) {
      const toolName = part.tool.toLowerCase();
      tools[toolName] = (tools[toolName] || 0) + 1;

      const statusResult = this.mapToolStatus(part.state.status);
      if (statusResult !== 'skip') {
        if (!toolStatus[toolName]) {
          toolStatus[toolName] = { success: 0, failure: 0 };
        }
        toolStatus[toolName][statusResult]++;

        // Extract file operations only for completed tools (ADR-8)
        if (statusResult === 'success') {
          const ops = this.extractFileOperation(
            part.tool,
            part.state.input,
            part.state.metadata
          );
          fileOperations.push(...ops);
        }
      }
    }

    return { tools, toolStatus, fileOperations };
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
  ): Array<{
    type: FileOperationType;
    path?: string;
    pattern?: string;
    linesAdded?: number;
    linesRemoved?: number;
  }> {
    const toolLower = toolName.toLowerCase();
    const operations: Array<{
      type: FileOperationType;
      path?: string;
      pattern?: string;
      linesAdded?: number;
      linesRemoved?: number;
    }> = [];

    // Map tools to allowed types (ADR-8)
    const typeMapping: Record<string, FileOperationType> = {
      'read': 'read',
      'write': 'write',
      'edit': 'edit',
      'glob': 'glob',
      'grep': 'grep',
      'apply_patch': 'edit',  // Map to edit, not patch
      'multiedit': 'edit',    // Map to edit, not multiedit
    };

    const mappedType = typeMapping[toolLower];
    if (!mappedType) return [];

    // Handle apply_patch - extract from state.metadata.files (ADR-17)
    if (toolLower === 'apply_patch') {
      const files = metadata?.files as Array<{
        filePath?: string;
        relativePath?: string;
        type?: string;
        additions?: number;
        deletions?: number;
      }> | undefined;

      if (Array.isArray(files)) {
        for (const file of files) {
          const path = file.filePath || file.relativePath;
          if (typeof path === 'string') {
            const op: any = { type: 'edit', path };

            // Add line metrics from apply_patch (ADR-8)
            if (typeof file.additions === 'number') {
              op.linesAdded = file.additions;
            }
            if (typeof file.deletions === 'number') {
              op.linesRemoved = file.deletions;
            }

            operations.push(op);
          }
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

    // Standard file operations
    const fileOp: any = { type: mappedType };

    // Per ADR-17: field names are camelCase (filePath, not file_path)
    const filePath = input?.filePath || input?.path;
    if (typeof filePath === 'string') {
      fileOp.path = filePath;
    }

    if (typeof input?.pattern === 'string') {
      fileOp.pattern = input.pattern;
    }

    operations.push(fileOp);
    return operations;
  }

  /**
   * Extract user prompts from messages (ADR-10, ADR-20)
   */
  private async extractUserPrompts(
    messages: OpenCodeMessage[],
    storagePath: string,
    sessionId?: string
  ): Promise<Array<{ count: number; text: string }>> {
    const prompts: Array<{ count: number; text: string }> = [];

    for (const msg of messages) {
      if (msg.role !== 'user') continue;

      const text = await this.extractUserPromptText(msg, storagePath, sessionId);
      if (text) {
        prompts.push({ count: 1, text });
      }
    }

    return prompts;
  }

  /**
   * Extract user prompt text from message (ADR-10, ADR-20)
   */
  private async extractUserPromptText(
    msg: OpenCodeMessage,
    storagePath: string,
    sessionId?: string
  ): Promise<string | undefined> {
    // Try parts first (ADR-20)
    const partsDir = join(storagePath, 'part', msg.id);
    if (existsSync(partsDir)) {
      const parts = await this.loadPartsForMessage(storagePath, msg.id, sessionId);
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
   * Get existing record IDs for deduplication (ADR-5)
   * Uses tolerant JSONL reading to handle corrupted lines.
   */
  private async getExistingRecordIds(sessionId: string): Promise<Set<string>> {
    try {
      const existingDeltas = await this.readExistingDeltas(sessionId);
      return new Set(existingDeltas.map(d => d.recordId));
    } catch (error) {
      logger.warn('[opencode-metrics] Could not read existing deltas:', error);
      return new Set();
    }
  }

  /**
   * Read existing deltas from JSONL file (ADR-5, ADR-21)
   */
  private async readExistingDeltas(sessionId: string): Promise<MetricDelta[]> {
    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);

      if (!writer.exists()) {
        return [];
      }

      // Use tolerant read that skips corrupted lines
      return await readJsonlTolerant<MetricDelta>(writer.getFilePath());
    } catch (error) {
      logger.debug('[opencode-metrics] Could not read existing deltas:', error);
      return [];
    }
  }

  /**
   * Get valid model string (ADR-6)
   */
  private getValidModelString(providerID?: string, modelID?: string): string | undefined {
    const model = modelID?.trim();
    if (!model) return undefined;

    const provider = providerID?.toLowerCase().trim();
    return provider ? `${provider}/${model}` : model;
  }

  /**
   * Update session.metrics for backward compatibility
   */
  private updateSessionMetrics(session: ParsedSession, messages: OpenCodeMessage[]): void {
    let totalInput = 0;
    let totalOutput = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const assistantMsg = msg as OpenCodeAssistantMessage;
        if (assistantMsg.tokens) {
          totalInput += assistantMsg.tokens.input || 0;
          totalOutput += assistantMsg.tokens.output || 0;
          cacheRead += assistantMsg.tokens.cache?.read || 0;
          cacheWrite += assistantMsg.tokens.cache?.write || 0;
        }
      }
    }

    // Ensure session.metrics exists before mutating
    if (!session.metrics) {
      (session as { metrics: ParsedSession['metrics'] }).metrics = {
        tokens: { input: 0, output: 0 },
        tools: {},
        toolStatus: {},
        fileOperations: []
      };
    }

    session.metrics!.tokens = {
      input: totalInput,
      output: totalOutput,
      cacheRead,
      cacheWrite
    };
  }
}
