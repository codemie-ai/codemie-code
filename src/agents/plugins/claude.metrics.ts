/**
 * Claude Metrics Adapter
 *
 * Implements metrics support for Claude Code agent.
 * Handles Claude-specific file formats and parsing logic.
 */

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { BaseMetricsAdapter } from '../core/BaseMetricsAdapter.js';
import type {
  MetricSnapshot,
  MetricDelta,
  ToolCallMetric,
  FileOperation,
  FileOperationType,
  UserPrompt
} from '../core/metrics/types.js';
import { logger } from '../../utils/logger.js';
import { parseMultiLineJSON } from '../../utils/parsers.js';
import { HistoryParser } from './history-parser.js';
import {
  getFilename,
  matchesPathStructure,
  validatePathDepth,
  isValidUuidFilename
} from '../../utils/paths.js';

export class ClaudeMetricsAdapter extends BaseMetricsAdapter {
  // Note: dataPaths now comes from ClaudePluginMetadata passed via constructor

  /**
   * Check if file matches Claude session pattern
   * Pattern: ~/.claude/projects/{hash}/{session-id}.jsonl
   * Note: Claude uses JSONL (JSON Lines) format, not regular JSON
   * Matches UUID format but EXCLUDES agent-* files (those are sub-agents)
   *
   * Cross-platform implementation using reusable path utilities
   */
  matchesSessionPattern(filePath: string): boolean {
    // Get constants from metadata (dataPaths passed via constructor)
    if (!this.metadata?.dataPaths?.home || !this.metadata?.dataPaths?.sessions) {
      return false;
    }

    const claudeDir = this.metadata.dataPaths.home; // '.claude'
    const projectsDir = this.metadata.dataPaths.sessions; // 'projects'
    const sessionExt = '.jsonl';

    // Check structure: .claude/projects/{hash}/{uuid}.jsonl
    // Uses cross-platform path utilities that normalize separators
    if (!matchesPathStructure(filePath, claudeDir, [projectsDir])) {
      return false;
    }

    // Validate depth: .claude + projects + hash + filename = 3 segments after .claude
    if (!validatePathDepth(filePath, claudeDir, 3)) {
      return false;
    }

    // Get the filename (last part)
    const filename = getFilename(filePath);

    // Explicitly reject agent-* files (sub-agents/sidechains)
    if (filename.startsWith('agent-')) {
      return false;
    }

    // Validate UUID format in filename
    return isValidUuidFilename(filename, sessionExt);
  }

  /**
   * Find all agent-*.jsonl files in the same directory as the session file
   * that belong to the same Claude sessionId (filters by sessionId)
   *
   * Agent files contain sub-agent/tool execution data with potentially different models
   *
   * @param sessionFilePath - Path to the main session file
   * @returns Array of agent file paths matching the same sessionId
   */
  private async findAgentFiles(sessionFilePath: string): Promise<string[]> {
    try {
      const dir = dirname(sessionFilePath);
      if (!existsSync(dir)) {
        return [];
      }

      // Read the sessionId from the file (may not be on first line)
      // First line is often file-history-snapshot without sessionId
      const mainContent = await readFile(sessionFilePath, 'utf-8');
      const lines = mainContent.split('\n').filter(l => l.trim());

      let targetSessionId: string | undefined;
      for (const line of lines.slice(0, 10)) { // Check first 10 lines
        try {
          const event = JSON.parse(line);
          if (event.sessionId) {
            targetSessionId = event.sessionId;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!targetSessionId) {
        logger.debug(`[ClaudeMetrics] No sessionId found in ${sessionFilePath}`);
        return [];
      }

      // Find all agent files in the directory
      const files = await readdir(dir);
      const agentFileCandidates = files
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(f => join(dir, f));

      // Filter agent files by matching sessionId
      const matchingAgentFiles: string[] = [];
      for (const agentFile of agentFileCandidates) {
        try {
          const content = await readFile(agentFile, 'utf-8');
          const firstLine = content.split('\n')[0];
          if (firstLine) {
            const firstEvent = JSON.parse(firstLine);
            if (firstEvent.sessionId === targetSessionId) {
              matchingAgentFiles.push(agentFile);
            }
          }
        } catch {
          // Skip files that can't be parsed
          continue;
        }
      }

      logger.debug(`[ClaudeMetrics] Found ${matchingAgentFiles.length} agent files for session ${targetSessionId}`);
      return matchingAgentFiles;
    } catch (error) {
      logger.debug(`[ClaudeMetrics] Failed to find agent files:`, error);
      return [];
    }
  }

  /**
   * Parse all models from agent files
   * Agent files may contain different models used by sub-agents/tools
   *
   * @param agentFilePaths - Array of agent file paths
   * @returns Map of model names to call counts
   */
  private async parseModelsFromAgentFiles(agentFilePaths: string[]): Promise<Map<string, number>> {
    const modelCalls = new Map<string, number>();

    for (const filePath of agentFilePaths) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const jsonObjects = parseMultiLineJSON(content);

        for (const obj of jsonObjects) {
          if (obj.message?.model) {
            const model = obj.message.model;
            modelCalls.set(model, (modelCalls.get(model) || 0) + 1);
          }
        }
      } catch (error) {
        logger.debug(`[ClaudeMetrics] Failed to parse agent file ${filePath}:`, error);
      }
    }

    return modelCalls;
  }

  /**
   * Extract session ID from Claude file path
   * Examples:
   *   ~/.claude/projects/abc123/session-def-456.jsonl → session-def-456
   *   ~/.claude/projects/abc123/agent-abc123de.jsonl → agent-abc123de
   */
  extractSessionId(path: string): string {
    const match = path.match(/([a-z0-9-]+)\.jsonl$/);
    return match?.[1] || '';
  }

  /**
   * Parse Claude session file (multi-line JSON objects) and extract metrics
   * Each object contains a conversation turn with message data
   */
  async parseSessionFile(path: string): Promise<MetricSnapshot> {
    try {
      const content = await readFile(path, 'utf-8');
      const jsonObjects = parseMultiLineJSON(content);

      if (jsonObjects.length === 0) {
        throw new Error('Empty session file');
      }

      // Parse first object to get session metadata
      const firstObject = jsonObjects[0];
      const sessionId = firstObject.sessionId || '';
      const workingDirectory = firstObject.cwd || '';
      const gitBranch = firstObject.gitBranch;

      // Aggregate metrics from all objects
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;

      // Track all models (not just first)
      const modelCalls = new Map<string, number>();

      // Tool tracking maps
      const toolCalls: ToolCallMetric[] = [];
      const toolUseMap = new Map<string, { name: string; timestamp: number; input?: any }>();

      for (const turn of jsonObjects) {

        // Track all models with call counts
        if (turn.message?.model) {
          const model = turn.message.model;
          modelCalls.set(model, (modelCalls.get(model) || 0) + 1);
        }

        // Aggregate token usage
        if (turn.message?.usage) {
          const usage = turn.message.usage;
          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
          cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
        }

        // Extract tool use events (from assistant messages)
        if (turn.message?.role === 'assistant' && Array.isArray(turn.message.content)) {
          for (const block of turn.message.content) {
            if (block.type === 'tool_use') {
              // Store tool_use for later correlation
              toolUseMap.set(block.id, {
                name: block.name,
                timestamp: turn.timestamp || Date.now(),
                input: block.input
              });
            }
          }
        }

        // Extract tool result events (from user messages)
        if (turn.message?.role === 'user' && Array.isArray(turn.message.content)) {
          for (const block of turn.message.content) {
            if (block.type === 'tool_result') {
              const toolUse = toolUseMap.get(block.tool_use_id);
              if (toolUse) {
                const toolCall: ToolCallMetric = {
                  id: block.tool_use_id,
                  name: toolUse.name, // Use raw tool name
                  timestamp: toolUse.timestamp,
                  status: block.is_error ? 'error' : 'success',
                  input: toolUse.input,
                  error: block.is_error ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : undefined
                };

                // Extract file operation details
                const fileOp = this.extractFileOperation(toolUse.name, toolUse.input);
                if (fileOp) {
                  toolCall.fileOperation = fileOp;
                }

                toolCalls.push(toolCall);
              }
            }
          }
        }
      }

      // Parse agent files to get models from sub-agents/tools
      const agentFiles = await this.findAgentFiles(path);
      const agentModels = await this.parseModelsFromAgentFiles(agentFiles);

      // Merge agent models with session models
      for (const [model, count] of agentModels) {
        modelCalls.set(model, (modelCalls.get(model) || 0) + count);
      }

      // Build aggregated tool usage summary
      const toolUsageSummary = this.buildToolUsageSummary(toolCalls);

      // Get all models (raw, unnormalized)
      const allModels = Array.from(modelCalls.keys());

      const snapshot: MetricSnapshot = {
        sessionId,
        timestamp: Date.now(),

        tokens: {
          input: inputTokens,
          output: outputTokens,
          cacheCreation: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
          cacheRead: cacheReadTokens > 0 ? cacheReadTokens : undefined
        },

        toolCalls,
        toolUsageSummary,

        turnCount: jsonObjects.length,
        model: allModels.length > 0 ? allModels[0] : undefined, // Primary model for backward compat

        metadata: {
          workingDirectory,
          gitBranch,
          totalInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
          models: allModels, // All raw model names (unnormalized)
          modelCalls: Object.fromEntries(modelCalls) // Map of model -> call count
        }
      };

      logger.debug(
        `[ClaudeMetrics] Parsed session ${sessionId}: ${inputTokens} input, ${outputTokens} output, ` +
        `${cacheReadTokens} cache read, ${toolCalls.length} tool calls, ${allModels.length} models`
      );

      return snapshot;
    } catch (error) {
      logger.error(`[ClaudeMetrics] Failed to parse session file: ${path}`, error);
      throw error;
    }
  }


  /**
   * Extract file operation details from tool input and result
   * Uses raw tool names (provider-specific, e.g., "Write", "Edit", "Read")
   *
   * @param toolName - Tool name (Read, Write, Edit, etc.)
   * @param input - Tool input parameters
   * @param toolUseResult - Tool execution result with structured data (optional)
   */
  private extractFileOperation(
    toolName: string,
    input: any,
    toolUseResult?: any
  ): FileOperation | undefined {
    // Map raw tool names to operation types
    const typeMap: Record<string, FileOperationType> = {
      'Read': 'read',
      'Write': 'write',
      'Edit': 'edit',
      // Note: Bash excluded - too varied to categorize reliably
      'Grep': 'grep',
      'Glob': 'glob'
    };

    const type = typeMap[toolName];
    if (!type) return undefined;

    const fileOp: FileOperation = { type };

    // Extract file path from toolUseResult (most accurate) or input
    const filePath = toolUseResult?.filePath || toolUseResult?.file?.filePath || input?.file_path || input?.path;

    if (filePath) {
      fileOp.path = filePath;
      fileOp.format = this.extractFormat(filePath);
      fileOp.language = this.detectLanguage(filePath);
    } else if (input?.pattern) {
      // For Grep/Glob operations
      fileOp.pattern = input.pattern;
    }

    // Extract line changes from toolUseResult (most accurate source)
    if (toolName === 'Write') {
      // Write tool: calculate from toolUseResult.content or toolUseResult.file or input.content
      const content = toolUseResult?.content || toolUseResult?.file?.content || input?.content;
      if (content) {
        const lines = content.split('\n');
        fileOp.linesAdded = lines.length;
      } else if (toolUseResult?.file?.numLines) {
        fileOp.linesAdded = toolUseResult.file.numLines;
      } else if (toolUseResult?.file?.totalLines) {
        fileOp.linesAdded = toolUseResult.file.totalLines;
      }
    } else if (toolName === 'Edit' && toolUseResult?.structuredPatch) {
      // Edit tool: use structured patch to get accurate line counts
      let added = 0;
      let removed = 0;

      for (const patch of toolUseResult.structuredPatch) {
        // Parse patch.lines array: "+line" = added, "-line" = removed, " line" = unchanged
        for (const line of patch.lines || []) {
          if (line.startsWith('+')) {
            added++;
          } else if (line.startsWith('-')) {
            removed++;
          }
          // Lines starting with space are unchanged (context)
        }
      }

      if (added > 0) fileOp.linesAdded = added;
      if (removed > 0) fileOp.linesRemoved = removed;
      // If no adds/removes but edit happened, count as modified
      if (added === 0 && removed === 0 && toolUseResult.structuredPatch.length > 0) {
        fileOp.linesModified = toolUseResult.structuredPatch[0].oldLines || 0;
      }
    } else if (toolName === 'Read' && toolUseResult?.file) {
      // Read tool: no line changes, but we have file info
      // numLines already captured above
    }

    return fileOp;
  }

  /**
   * Claude uses hash-based watermark (full file rewrite)
   */
  getWatermarkStrategy(): 'hash' | 'line' | 'object' {
    return 'hash';
  }

  /**
   * Claude initialization delay: 500ms
   */
  getInitDelay(): number {
    return 500;
  }

  /**
   * Get user prompts for a specific session
   * Claude stores user prompts in history file (path from metadata)
   *
   * @param sessionId - Claude session ID
   * @param fromTimestamp - Start timestamp (Unix ms) - optional
   * @param toTimestamp - End timestamp (Unix ms) - optional
   * @returns Array of user prompts
   */
  async getUserPrompts(
    sessionId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<UserPrompt[]> {
    try {
      // Get user prompts file path from metadata
      if (!this.metadata?.dataPaths?.home || !this.metadata?.dataPaths?.user_prompts) {
        logger.debug(`[ClaudeMetrics] No user prompts path configured in metadata`);
        return [];
      }

      const historyPath = this.getUserPromptsPath();
      const parser = new HistoryParser(historyPath);

      // Get prompts for this session within time range
      const prompts = await parser.getPromptsInRange(sessionId, fromTimestamp, toTimestamp);

      logger.debug(`[ClaudeMetrics] Found ${prompts.length} user prompts for session ${sessionId}`);

      return prompts;
    } catch (error) {
      logger.error(`[ClaudeMetrics] Failed to get user prompts for session ${sessionId}:`, error);
      return [];
    }
  }

  /**
   * Parse session file and extract incremental delta records
   * Returns array of delta records for turns with token usage
   *
   * Automatically discovers and parses ALL agent files for the session
   * to capture sub-agents/sidechains that share the same Claude sessionId
   *
   * @param path - Path to agent session file
   * @param processedRecordIds - Set of record IDs already written to metrics
   * @param attachedUserPromptTexts - Set of user prompt texts already attached (persisted from sync state)
   */
  async parseIncrementalMetrics(
    path: string,
    processedRecordIds: Set<string> = new Set(),
    attachedUserPromptTexts: Set<string> = new Set()
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
    newlyAttachedPrompts: string[];
  }> {
    try {
      // Find ALL agent files for this session (including sidechains)
      const agentFiles = await this.findAgentFiles(path);
      // Add the main file to the list if not already included
      if (!agentFiles.includes(path)) {
        agentFiles.unshift(path);
      }

      logger.debug(`[ClaudeMetrics] Analyzing ${agentFiles.length} session file${agentFiles.length !== 1 ? 's' : ''} (including sidechains)`);

      // Track initial size to determine newly attached prompts
      const initialAttachedCount = attachedUserPromptTexts.size;

      // Parse all agent files and merge deltas
      const allDeltas: MetricDelta[] = [];
      let maxLastLine = 0;

      for (const agentFile of agentFiles) {
        const { deltas, lastLine } = await this.parseAgentFileDeltas(agentFile, processedRecordIds, attachedUserPromptTexts);
        if (deltas.length > 0) {
          logger.debug(`[ClaudeMetrics] Found ${deltas.length} new interaction${deltas.length !== 1 ? 's' : ''} in ${agentFile.split('/').pop()}`);
        }
        allDeltas.push(...deltas);
        maxLastLine = Math.max(maxLastLine, lastLine);
      }

      // Calculate newly attached prompts (after processing - before processing)
      const newlyAttachedPrompts = Array.from(attachedUserPromptTexts).slice(initialAttachedCount);

      return {
        deltas: allDeltas,
        lastLine: maxLastLine,
        newlyAttachedPrompts
      };
    } catch (error) {
      logger.error(`[ClaudeMetrics] Failed to parse incremental metrics: ${path}`, error);
      throw error;
    }
  }

  /**
   * Parse a single agent file for deltas
   * Extracted from parseIncrementalMetrics for reuse across multiple files
   *
   * @param path - Path to agent file
   * @param processedRecordIds - Set of record IDs already processed
   * @param attachedUserPrompts - Set of user prompt display texts that have been attached (shared across files)
   */
  private async parseAgentFileDeltas(
    path: string,
    processedRecordIds: Set<string>,
    attachedUserPrompts: Set<string> = new Set()
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
  }> {
    try {
      const content = await readFile(path, 'utf-8');
      const jsonObjects = parseMultiLineJSON(content);

      if (jsonObjects.length === 0) {
        return { deltas: [], lastLine: 0 };
      }

      // FIRST PASS: Build tool_result map from ALL jsonObjects
      // This ensures we can match tool_results that come after tool_use in the file
      const toolResultMap = new Map<string, {
        timestamp: string;
        isError: boolean;
        errorMessage?: string;
        durationMs?: number;
        toolUseResult?: any; // Contains structured patch data for Edit operations
      }>();

      for (const record of jsonObjects) {
        if (record.message?.role === 'user' && Array.isArray(record.message.content)) {
          for (const block of record.message.content) {
            if (block.type === 'tool_result') {
              toolResultMap.set(block.tool_use_id, {
                timestamp: record.timestamp,
                isError: block.is_error || false,
                errorMessage: block.is_error ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : undefined,
                durationMs: block.durationMs,
                toolUseResult: record.toolUseResult // Contains structured patch and file details
              });
            }
          }
        }
      }

      // Extract session ID from first record that has one
      let extractedSessionId = '';
      for (const record of jsonObjects) {
        if (record.sessionId) {
          extractedSessionId = record.sessionId;
          break;
        }
      }
      // ZERO PASS: Get user prompts from history.jsonl and build UUID map
      // Map user prompt UUIDs to prompts for direct correlation
      const userPromptsByUuid = new Map<string, UserPrompt>();
      try {
        const userPrompts = await this.getUserPrompts(extractedSessionId);
        logger.debug(`[ClaudeMetrics] Found ${userPrompts.length} user prompts in history.jsonl for session ${extractedSessionId}`);

        // Build a map of record UUIDs to user prompts
        // We'll correlate by finding user messages that match prompts
        for (const record of jsonObjects) {
          if (record.type === 'user' &&
              record.message?.role === 'user' &&
              typeof record.message.content === 'string') {

            // This is an initial user message (not a tool result)
            const messageContent = record.message.content;
            const recordTime = typeof record.timestamp === 'string'
              ? new Date(record.timestamp).getTime()
              : record.timestamp;

            // Find matching prompt from history.jsonl by content or timestamp
            const matchingPrompt = userPrompts.find(p => {
              // Match by content (most reliable)
              if (p.display === messageContent) {
                return true;
              }

              // Fallback: match by timestamp (±10 seconds window for initial prompts)
              const timeDiff = Math.abs(p.timestamp - recordTime);
              return timeDiff <= 10000; // 10 second window
            });

            if (matchingPrompt && record.uuid) {
              userPromptsByUuid.set(record.uuid, matchingPrompt);
            }
          }
        }

        logger.debug(`[ClaudeMetrics] Matched ${userPromptsByUuid.size} prompts to message UUIDs`);
      } catch (error) {
        logger.debug(`[ClaudeMetrics] Could not load user prompts (non-critical):`, error);
        // Continue without user prompts - non-critical feature
      }

      // SECOND PASS: Create deltas for NEW records with usage (assistant messages)
      // Skip records that have already been processed
      const deltas: MetricDelta[] = [];
      const sessionModels: string[] = []; // Track all unique models
      let lastUserPrompt: UserPrompt | undefined;

      for (const record of jsonObjects) {
        // Track user prompts as we iterate (BEFORE processing/skipping)
        // Only update lastUserPrompt for INITIAL user messages (with string content), not tool_result messages
        if (record.type === 'user' &&
            record.uuid &&
            userPromptsByUuid.has(record.uuid) &&
            record.message?.role === 'user' &&
            typeof record.message.content === 'string') {
          lastUserPrompt = userPromptsByUuid.get(record.uuid);
        }

        // Skip records already processed
        if (processedRecordIds.has(record.uuid)) {
          continue;
        }

        // Collect all unique models from all records (not just first)
        if (record.message?.model && !sessionModels.includes(record.message.model)) {
          sessionModels.push(record.message.model);
        }

        // Create delta for records with token usage
        if (record.message?.usage && record.message?.role === 'assistant') {
          // Check if this record has tool_use blocks waiting for tool_results
          let hasUnresolvedTools = false;
          if (Array.isArray(record.message.content)) {
            for (const block of record.message.content) {
              if (block.type === 'tool_use') {
                if (!toolResultMap.has(block.id)) {
                  hasUnresolvedTools = true;
                  break;
                }
              }
            }
          }

          // Skip records with tool_use blocks that haven't received tool_results yet
          if (hasUnresolvedTools) {
            logger.debug(`[ClaudeMetrics] Skipping record ${record.uuid} - waiting for tool results`);
            continue;
          }

          const usage = record.message.usage;
          const inputTokens = usage.input_tokens || 0;
          const outputTokens = usage.output_tokens || 0;
          const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = usage.cache_read_input_tokens || 0;

          // Extract tool_use IDs from this record
          const tools: Record<string, number> = {};
          const toolStatus: Record<string, { success: number; failure: number }> = {};
          const fileOperations: any[] = [];
          let apiErrorMessage: string | undefined;

          if (Array.isArray(record.message.content)) {
            for (const block of record.message.content) {
              if (block.type === 'tool_use') {
                // block IS the tool_use with name and input
                const toolResult = toolResultMap.get(block.id);

                // Only count if we have tool_result (tool was executed)
                if (toolResult) {
                  // Use raw tool name (provider-specific)
                  const toolName = block.name;
                  tools[toolName] = (tools[toolName] || 0) + 1;

                  // Track success/failure
                  if (!toolStatus[toolName]) {
                    toolStatus[toolName] = { success: 0, failure: 0 };
                  }
                  if (toolResult.isError) {
                    toolStatus[toolName].failure++;
                    // Capture first error message
                    if (!apiErrorMessage && toolResult.errorMessage) {
                      apiErrorMessage = toolResult.errorMessage;
                    }
                  } else {
                    toolStatus[toolName].success++;

                    // Only extract file operations for successful tool calls
                    const fileOp = this.extractFileOperation(toolName, block.input, toolResult.toolUseResult);
                    if (fileOp) {
                      // Add durationMs if available
                      if (toolResult.durationMs) {
                        fileOp.durationMs = toolResult.durationMs;
                      }
                      fileOperations.push(fileOp);
                    }
                  }
                }
              }
            }
          }

          // Include user prompt ONLY for the first assistant response after a user prompt
          // Use shared Set to prevent duplication across ALL agent files
          const userPrompts: Array<{ count: number; text?: string }> = [];
          if (lastUserPrompt && lastUserPrompt.display && !attachedUserPrompts.has(lastUserPrompt.display)) {
            userPrompts.push({
              count: 1,
              text: lastUserPrompt.display
            });
            // Mark as attached to prevent duplicate counting across multiple assistant turns AND agent files
            attachedUserPrompts.add(lastUserPrompt.display);
            // Clear lastUserPrompt so it doesn't attach to subsequent assistant turns
            lastUserPrompt = undefined;
          }

          // Get model and gitBranch for this turn
          const turnModel = record.message?.model;
          const gitBranch = record.gitBranch;

          // Create delta record (use message UUID as recordId for backtracking)
          const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
            recordId: record.uuid, // Use message UUID for backtracking
            sessionId: '',  // Will be set by caller
            agentSessionId: record.sessionId || '',
            timestamp: record.timestamp || new Date().toISOString(),
            gitBranch,
            tokens: {
              input: inputTokens,
              output: outputTokens,
              cacheCreation: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
              cacheRead: cacheReadTokens > 0 ? cacheReadTokens : undefined
            },
            tools,
            toolStatus: Object.keys(toolStatus).length > 0 ? toolStatus : undefined,
            fileOperations: fileOperations.length > 0 ? fileOperations : undefined,
            userPrompts: userPrompts.length > 0 ? userPrompts : undefined,
            apiErrorMessage,
            models: turnModel ? [turnModel] : undefined // Store raw model name(s) for this turn
          };

          deltas.push(delta as MetricDelta);
        }
      }

      return {
        deltas,
        lastLine: jsonObjects.length
      };
    } catch (error) {
      logger.error(`[ClaudeMetrics] Failed to parse incremental metrics: ${path}`, error);
      throw error;
    }
  }
}
