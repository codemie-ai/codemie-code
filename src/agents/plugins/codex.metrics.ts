/**
 * Codex Metrics Adapter
 *
 * Implements metrics support for Codex agent.
 * Handles Codex-specific file formats (JSONL) and parsing logic.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { BaseMetricsAdapter } from '../core/BaseMetricsAdapter.js';
import type {
  MetricSnapshot,
  MetricDelta,
  UserPrompt,
  ToolCallMetric,
  FileOperation,
  FileOperationType
} from '../core/metrics/types.js';
import { logger } from '../../utils/logger.js';
import { parseMultiLineJSON } from '../../utils/json-parser.js';
import { getFilename } from '../../utils/path-utils.js';
import type { AgentMetadata } from '../core/types.js';

export class CodexMetricsAdapter extends BaseMetricsAdapter {
  constructor(metadata: AgentMetadata) {
    super('codex', metadata);
  }

  /**
   * Check if file matches Codex session pattern with date filtering
   * Pattern: ~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{date}T{time}-{uuid}.jsonl
   *
   * Performance optimization: Only matches current date by default
   *
   * @param path - File path to check
   * @param dateFilter - Optional date filter (YYYY-MM-DD). Defaults to today.
   *                     Pass null to match all dates.
   */
  matchesSessionPattern(path: string, dateFilter?: string | null): boolean {
    // Check path contains required directories
    // Pattern: ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl
    const pathLower = path.toLowerCase();
    if (!pathLower.includes('.codex') || !pathLower.includes('sessions')) {
      return false;
    }

    const filename = getFilename(path);

    // Check filename pattern: rollout-YYYY-MM-DDTHH-MM-SS-{uuid}.jsonl
    // Real example: rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl
    if (!/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/.test(filename)) {
      return false;
    }

    // Validate directory structure: must have year/month/day folders
    // Extract path segments after "sessions/"
    const sessionsIndex = path.search(/sessions[\\/]/i);
    if (sessionsIndex === -1) {
      return false;
    }

    const afterSessions = path.substring(sessionsIndex + 9); // Skip "sessions/"
    const parts = afterSessions.split(/[\\/]/);

    // Must have at least 4 parts: year, month, day, filename
    // Example: ['2026', '01', '02', 'rollout-2026-01-02T14-40-09-abc.jsonl']
    if (parts.length < 4) {
      return false;
    }

    // Validate year/month/day format
    const [year, month, day] = parts;
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
      return false;
    }

    // Apply date filter for performance (default: today only)
    if (dateFilter !== null) {
      const filterDate = dateFilter || new Date().toISOString().split('T')[0]; // Default: today
      const pathDate = `${year}-${month}-${day}`;
      if (pathDate !== filterDate) {
        return false; // Not the target date, skip
      }
    }

    return true;
  }

  /**
   * Extract session ID from Codex file path
   * Prefers session_meta.payload.id but falls back to filename UUID
   */
  extractSessionId(path: string): string {
    const filename = getFilename(path);
    const match = filename.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([a-f0-9-]+)\.jsonl$/);
    return match?.[1] || filename.replace('.jsonl', '');
  }

  /**
   * Parse Codex session file and extract metrics
   */
  async parseSessionFile(path: string): Promise<MetricSnapshot> {
    try {
      const content = await readFile(path, 'utf-8');
      const events = parseMultiLineJSON(content);

      if (events.length === 0) {
        throw new Error('Empty session file');
      }

      // Extract session metadata from session_meta
      const sessionMeta = events.find((e: any) => e.type === 'session_meta');
      const sessionId = sessionMeta?.payload?.id || this.extractSessionId(path);
      const workingDirectory = sessionMeta?.payload?.cwd || '';
      const gitBranch = sessionMeta?.payload?.git?.branch;
      const modelProvider = sessionMeta?.payload?.model_provider;

      // Aggregate metrics from all events
      // Note: total_token_usage is cumulative, so we take the maximum value
      let maxInputTokens = 0;
      let maxOutputTokens = 0;
      let maxCachedTokens = 0;
      let maxReasoningTokens = 0;
      const modelCalls = new Map<string, number>();

      // Parse token_count events (only those with data - after agent responses)
      for (const event of events) {
        if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
          const info = event.payload.info;

          // Skip events without token data (user messages, local providers)
          if (!info || !info.total_token_usage) {
            continue;
          }

          const usage = info.total_token_usage;
          // total_token_usage is cumulative - track maximum values
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cache = usage.cached_input_tokens || 0;
          const reasoning = usage.reasoning_output_tokens || 0;

          if (input > maxInputTokens) maxInputTokens = input;
          if (output > maxOutputTokens) maxOutputTokens = output;
          if (cache > maxCachedTokens) maxCachedTokens = cache;
          if (reasoning > maxReasoningTokens) maxReasoningTokens = reasoning;
        }

        // Track models from turn_context
        if (event.type === 'turn_context' && event.payload?.model) {
          const model = event.payload.model;
          modelCalls.set(model, (modelCalls.get(model) || 0) + 1);
        }
      }

      // Extract tool calls from function_call/function_call_output pairs
      const toolCalls: ToolCallMetric[] = [];
      const toolCallMap = new Map<string, { name: string; timestamp: number; arguments: string }>();

      // FIRST PASS: Build map of tool requests
      for (const event of events) {
        if (event.type === 'response_item' && event.payload?.type === 'function_call') {
          toolCallMap.set(event.payload.call_id, {
            name: event.payload.name,
            timestamp: new Date(event.timestamp).getTime(),
            arguments: event.payload.arguments
          });
        }
      }

      // SECOND PASS: Match with tool responses and create metrics
      for (const event of events) {
        if (event.type === 'response_item' && event.payload?.type === 'function_call_output') {
          const callId = event.payload.call_id;
          const request = toolCallMap.get(callId);

          if (!request) continue;

          // Parse output JSON (double-encoded)
          let exitCode = 0;
          let durationMs: number | undefined;
          let errorMessage: string | undefined;

          try {
            const output = JSON.parse(event.payload.output);
            exitCode = output.metadata?.exit_code ?? 0;
            durationMs = output.metadata?.duration_seconds
              ? Math.round(output.metadata.duration_seconds * 1000)
              : undefined;

            if (exitCode !== 0) {
              errorMessage = output.output || 'Command failed';
            }
          } catch {
            // Failed to parse output, assume success
          }

          const toolCall: ToolCallMetric = {
            id: callId,
            name: request.name,
            timestamp: request.timestamp,
            status: exitCode === 0 ? 'success' : 'error',
            input: request.arguments ? JSON.parse(request.arguments) : undefined,
            error: errorMessage
          };

          // Extract file operation if applicable
          const fileOp = this.extractFileOperation(request.name, toolCall.input);
          if (fileOp && durationMs) {
            fileOp.durationMs = durationMs;
          }
          if (fileOp) {
            toolCall.fileOperation = fileOp;
          }

          toolCalls.push(toolCall);
        }
      }

      const toolUsageSummary = this.buildToolUsageSummary(toolCalls);

      const allModels = Array.from(modelCalls.keys());

      const snapshot: MetricSnapshot = {
        sessionId,
        timestamp: Date.now(),
        tokens: {
          input: maxInputTokens,
          output: maxOutputTokens + maxReasoningTokens, // Include reasoning in output
          cacheRead: maxCachedTokens > 0 ? maxCachedTokens : undefined
        },
        toolCalls,
        toolUsageSummary,
        turnCount: events.filter((e: any) => e.type === 'turn_context').length,
        model: allModels.length > 0 ? allModels[0] : undefined,
        metadata: {
          workingDirectory,
          gitBranch,
          totalInputTokens: maxInputTokens + maxCachedTokens,
          models: allModels,
          modelCalls: Object.fromEntries(modelCalls),
          modelProvider // Add provider for debugging
        }
      };

      logger.debug(
        `[CodexMetrics] Parsed session ${sessionId}: ${maxInputTokens} input, ${maxOutputTokens} output, ` +
        `${maxCachedTokens} cached, ${maxReasoningTokens} reasoning`
      );

      return snapshot;
    } catch (error) {
      logger.error(`[CodexMetrics] Failed to parse session file: ${path}`, error);
      throw error;
    }
  }

  /**
   * Parse incremental metrics from session file
   * Returns only new deltas since last processing
   */
  async parseIncrementalMetrics(
    path: string,
    processedRecordIds: Set<string>,
    attachedUserPromptTexts: Set<string>
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
    newlyAttachedPrompts: string[];
  }> {
    try {
      const content = await readFile(path, 'utf-8');
      const events = parseMultiLineJSON(content);

      const deltas: MetricDelta[] = [];
      const newlyAttachedPrompts: string[] = [];

      // Extract session metadata
      const sessionMeta = events.find((e: any) => e.type === 'session_meta');
      const sessionId = sessionMeta?.payload?.id || this.extractSessionId(path);
      const gitBranch = sessionMeta?.payload?.git?.branch;

      // Track current model from turn_context events
      let currentModel: string | undefined;

      // Track tool calls by call_id for this parsing
      const toolCallMap = new Map<string, { name: string; timestamp: number; arguments: string }>();

      // Track previous cumulative token counts to calculate deltas
      let prevInputTokens = 0;
      let prevOutputTokens = 0;
      let prevCachedTokens = 0;

      // Process events sequentially to create deltas
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const recordId = `${sessionId}:${event.timestamp}:${i}`;

        // Skip already processed events
        if (processedRecordIds.has(recordId)) {
          continue;
        }

        // Mark as processed
        processedRecordIds.add(recordId);

        // Track model from turn_context
        if (event.type === 'turn_context' && event.payload?.model) {
          currentModel = event.payload.model;
        }

        // Process token_count events
        if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
          const info = event.payload.info;

          // Skip events without token data
          if (!info || !info.total_token_usage) {
            continue;
          }

          // Use total_token_usage (cumulative) and calculate delta from previous
          const usage = info.total_token_usage;
          const currInput = usage.input_tokens || 0;
          const currOutput = (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0);
          const currCache = usage.cached_input_tokens || 0;

          // Calculate delta (new tokens since last event)
          const deltaInput = Math.max(0, currInput - prevInputTokens);
          const deltaOutput = Math.max(0, currOutput - prevOutputTokens);
          const deltaCache = Math.max(0, currCache - prevCachedTokens);

          // Only create delta if there are new tokens
          if (deltaInput > 0 || deltaOutput > 0 || deltaCache > 0) {
            const timestamp = new Date(event.timestamp).getTime();

            const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
              recordId,
              sessionId: '', // Will be set by caller
              agentSessionId: sessionId,
              timestamp,
              tokens: {
                input: deltaInput,
                output: deltaOutput,
                cacheRead: deltaCache > 0 ? deltaCache : undefined
              },
              tools: {}, // No tools for token_count events
              models: currentModel ? [currentModel] : undefined,
              gitBranch
            };

            deltas.push(delta as MetricDelta);

            // Update previous counts
            prevInputTokens = currInput;
            prevOutputTokens = currOutput;
            prevCachedTokens = currCache;
          }
        }

        // Collect tool call requests
        if (event.type === 'response_item' && event.payload?.type === 'function_call') {
          toolCallMap.set(event.payload.call_id, {
            name: event.payload.name,
            timestamp: new Date(event.timestamp).getTime(),
            arguments: event.payload.arguments
          });
        }

        // Process tool call responses
        if (event.type === 'response_item' && event.payload?.type === 'function_call_output') {
          const callId = event.payload.call_id;
          const request = toolCallMap.get(callId);

          if (!request) continue;

          // Parse output
          let exitCode = 0;
          let durationMs: number | undefined;

          try {
            const output = JSON.parse(event.payload.output);
            exitCode = output.metadata?.exit_code ?? 0;
            durationMs = output.metadata?.duration_seconds
              ? Math.round(output.metadata.duration_seconds * 1000)
              : undefined;
          } catch {
            // Failed to parse, use defaults
          }

          // Extract file operation if applicable
          let fileOp: FileOperation | undefined;
          try {
            const input = JSON.parse(request.arguments);
            fileOp = this.extractFileOperation(request.name, input);
            if (fileOp && durationMs) {
              fileOp.durationMs = durationMs;
            }
          } catch {
            // Failed to parse arguments, skip file operation
          }

          const toolCall: ToolCallMetric = {
            id: callId,
            name: request.name,
            timestamp: request.timestamp,
            status: exitCode === 0 ? 'success' : 'error'
          };

          if (fileOp) {
            toolCall.fileOperation = fileOp;
          }

          // Create delta for tool call
          const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
            recordId,
            sessionId: '', // Will be set by caller
            agentSessionId: sessionId,
            timestamp: new Date(event.timestamp).getTime(),
            tokens: { input: 0, output: 0 }, // No tokens for tool call events
            tools: { [request.name]: 1 },
            toolStatus: {
              [request.name]: exitCode === 0 ? { success: 1, failure: 0 } : { success: 0, failure: 1 }
            },
            fileOperations: fileOp ? [fileOp] : undefined,
            models: currentModel ? [currentModel] : undefined,
            gitBranch
          };

          deltas.push(delta as MetricDelta);
        }

        // Attach user prompts (from history.jsonl, not session file)
        if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
          const promptText = event.payload.message;

          if (promptText && !attachedUserPromptTexts.has(promptText)) {
            attachedUserPromptTexts.add(promptText);
            newlyAttachedPrompts.push(promptText);
          }
        }
      }

      return {
        deltas,
        lastLine: events.length,
        newlyAttachedPrompts
      };
    } catch (error) {
      logger.error(`[CodexMetrics] Failed to parse incremental metrics: ${path}`, error);
      throw error;
    }
  }

  /**
   * Get user prompts for a specific session
   * Parses ~/.codex/history.jsonl and correlates by session_id
   */
  async getUserPrompts(
    sessionId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<UserPrompt[]> {
    const historyPath = this.getUserPromptsPath();
    const prompts: UserPrompt[] = [];

    try {
      const content = await readFile(historyPath, 'utf-8');
      const entries = parseMultiLineJSON(content);

      for (const entry of entries) {
        // Filter by session_id
        if (entry.session_id !== sessionId) {
          continue;
        }

        // Convert unix seconds to milliseconds
        const timestamp = entry.ts * 1000;

        // Filter by timestamp range
        if (fromTimestamp && timestamp < fromTimestamp) {
          continue;
        }
        if (toTimestamp && timestamp > toTimestamp) {
          continue;
        }

        prompts.push({
          display: entry.text || '',
          timestamp,
          project: '', // Populated from MetricsSession workingDirectory
          sessionId: entry.session_id
        });
      }
    } catch (error) {
      // History file might not exist or be empty - not an error
      logger.debug(`[CodexMetrics] Could not read history file: ${(error as Error).message}`);
    }

    return prompts.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Extract file operation from tool arguments
   * Codex-specific tool mapping
   */
  private extractFileOperation(
    toolName: string,
    input: any
  ): FileOperation | undefined {
    // Map Codex tool names to operation types
    const typeMap: Record<string, FileOperationType | undefined> = {
      'read_file': 'read',
      'write_file': 'write',
      'edit_file': 'edit',
      'shell': undefined // Shell commands vary - skip for now
    };

    const type = typeMap[toolName];
    if (!type) return undefined;

    const fileOp: FileOperation = { type };

    // Extract file path from tool arguments
    if (input?.file_path || input?.path) {
      const path = input.file_path || input.path;
      fileOp.path = path;
      fileOp.format = this.extractFormat(path);
      fileOp.language = this.detectLanguage(path);
    }

    // Extract line changes for write operations
    if (toolName === 'write_file' && input?.content) {
      fileOp.linesAdded = input.content.split('\n').length;
    }

    return fileOp;
  }

  /**
   * Codex uses object-based watermark (record ID tracking)
   */
  getWatermarkStrategy(): 'hash' | 'line' | 'object' {
    return 'object';
  }

  /**
   * Codex initialization delay: 500ms
   */
  getInitDelay(): number {
    return 500;
  }

  /**
   * Override getDataPaths to handle dynamic date-based structure
   * Pattern: ~/.codex/sessions/{year}/{month}/{day}/
   * Returns base directory for FileSnapshotter to scan subdirectories
   */
  getDataPaths(): { sessionsDir: string; settingsDir?: string } {
    const home = this.getHomeDir();

    // Parse sessions template to extract directory structure
    // Template: 'sessions/{year}/{month}/{day}' → ['sessions', '{year}', '{month}', '{day}']
    const sessionsParts = this.parseSessionsTemplate();

    // Build path by taking segments before first placeholder
    const staticSegments: string[] = [];
    for (const segment of sessionsParts) {
      if (this.isDynamicSegment(segment)) {
        break;
      }
      staticSegments.push(segment);
    }

    // Return base directory - FileSnapshotter will scan subdirectories
    // Pattern matching in matchesSessionPattern() handles the rest
    return {
      sessionsDir: staticSegments.length > 0 ? join(home, ...staticSegments) : home,
      settingsDir: home
    };
  }
}
