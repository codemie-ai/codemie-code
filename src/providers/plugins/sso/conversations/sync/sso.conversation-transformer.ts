/**
 * Conversation Transformer
 *
 * Transforms Claude session messages to Codemie conversation format
 *
 * Key Transformations:
 * - Message pairing: User → Assistant with tool calls
 * - Tool call → Thought mapping (with observation)
 * - Token aggregation across message pairs
 * - Duration calculation (user → final assistant)
 */

import type {
  ClaudeMessage,
  CodemieHistoryEntry,
  Thought,
  ToolUse,
  ContentItem
} from './sso.conversation-types.js';
import { shouldFilterMessage, isToolResult, extractCommand } from './sso.message-filters.js';

/**
 * Transform Claude messages to Codemie history format
 * @param messages - Claude session messages
 * @param assistantId - Assistant ID to use for assistant messages (optional)
 * @param agentName - Agent display name for intermediate thoughts (e.g., 'Claude Code')
 */
export function transformMessages(messages: ClaudeMessage[], assistantId?: string, agentName?: string): CodemieHistoryEntry[] {
  const history: CodemieHistoryEntry[] = [];
  let historyIndex = 0;

  // Build tool results map (tool_use_id → result content)
  const toolResultsMap = buildToolResultsMap(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip non-conversation messages
    if (msg.type !== 'user' && msg.type !== 'assistant') {
      continue;
    }

    // Skip filtered messages (conversation splitters, system messages, tool results)
    if (shouldFilterMessage(msg)) {
      continue;
    }

    // User message followed by assistant response
    if (msg.type === 'user') {
      const userText = extractUserMessage(msg);

      // Collect ALL assistant messages, meta messages, and system errors in this turn
      const assistantMessages: ClaudeMessage[] = [];
      const metaMessages: ClaudeMessage[] = [];
      const systemErrors: ClaudeMessage[] = [];
      let j = i + 1;

      // Look ahead to find all assistant messages, meta messages, and system errors in this turn
      while (j < messages.length) {
        const nextMsg = messages[j];

        if (nextMsg.type === 'assistant') {
          assistantMessages.push(nextMsg);
        } else if (nextMsg.type === 'user' && (nextMsg as any).isMeta) {
          // Collect meta messages (skill prompts, system-injected content)
          metaMessages.push(nextMsg);
        } else if (nextMsg.type === 'system' && nextMsg.subtype === 'api_error') {
          // Collect system API errors (403, 429, etc.)
          systemErrors.push(nextMsg);
        } else if (nextMsg.type === 'user' && !isToolResult(nextMsg)) {
          // Hit next user prompt - stop
          break;
        }

        j++;
      }

      // Always add the user message first
      history.push({
        role: 'User',
        message: userText,
        history_index: historyIndex,
        date: msg.timestamp,
        message_raw: userText,  // Raw user input
        file_names: []
      });

      if (assistantMessages.length > 0) {
        const finalAssistantMsg = assistantMessages[assistantMessages.length - 1];

        // Collect thoughts: Meta messages + Tool calls + Intermediate assistant messages
        const allThoughts: Thought[] = [];

        // Process meta messages first (skill prompts, system-injected content)
        for (const metaMsg of metaMessages) {
          const metaText = extractTextContent(metaMsg);
          if (metaText.trim()) {
            allThoughts.push(createCodemieThought(
              metaMsg.uuid,
              metaText,
              agentName || 'Claude Code',
              metaMsg.timestamp
            ));
          }
        }

        // Process each assistant message
        for (let k = 0; k < assistantMessages.length; k++) {
          const assistantMsg = assistantMessages[k];
          const isIntermediateMsg = k < assistantMessages.length - 1;

          // Check if assistant message contains error (like UnknownOperationException)
          const hasError = assistantMsg.message?.Output?.__type || assistantMsg.message?.error;
          if (hasError) {
            const errorType = assistantMsg.message?.Output?.__type || 'Error';
            const errorMsg = assistantMsg.message?.error?.message || errorType;
            allThoughts.push({
              id: assistantMsg.uuid,
              parent_id: undefined,
              metadata: {
                timestamp: assistantMsg.timestamp,
                error_type: errorType
              },
              in_progress: false,
              author_type: 'Agent',
              author_name: agentName || assistantMsg.message?.model || 'claude',
              message: `Error: ${errorMsg}`,
              input_text: '',  // Empty to avoid duplication with user message
              output_format: 'error',
              error: true,
              children: []
            });
            continue; // Skip normal processing for error messages
          }

          // Extract tool calls from this assistant message
          const toolCalls = extractToolCalls(assistantMsg);
          for (const toolCall of toolCalls) {
            allThoughts.push(createToolThought(toolCall, toolResultsMap.get(toolCall.id)));
          }

          // If this is an intermediate assistant message (not the final one),
          // convert it to a Codemie thought to preserve the intermediate response
          // IMPORTANT: Preserve ALL intermediate messages (zero-tolerance)
          if (isIntermediateMsg) {
            const intermediateText = extractTextContent(assistantMsg);
            // Only create agent thought if there's actual text content
            // Tool-only messages are already captured as Tool thoughts above
            if (intermediateText.trim()) {
              allThoughts.push(createCodemieThought(
                assistantMsg.uuid,
                intermediateText,
                agentName || assistantMsg.message?.model || 'claude',
                assistantMsg.timestamp
              ));
            }
          }
        }

        // Aggregate tokens from ALL assistant messages
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;

        for (const assistantMsg of assistantMessages) {
          const usage = assistantMsg.message?.usage;
          if (usage) {
            totalInputTokens += usage.input_tokens || 0;
            totalOutputTokens += usage.output_tokens || 0;
            totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
            totalCacheReadTokens += usage.cache_read_input_tokens || 0;
          }
        }

        // Assistant response (use final assistant message text)
        const assistantText = extractTextContent(finalAssistantMsg);

        // Check if final message has error
        const finalHasError = finalAssistantMsg.message?.Output?.__type || finalAssistantMsg.message?.error;
        const errorMessage = finalHasError
          ? `Error: ${finalAssistantMsg.message?.Output?.__type || finalAssistantMsg.message?.error?.message || 'Unknown error'}`
          : assistantText;

        // Skip empty assistant messages only if no text, no thoughts, and no errors
        // Error responses are valuable and should be synced as assistant messages with error thoughts
        if (!errorMessage.trim() && allThoughts.length === 0) {
          // Don't sync empty assistant response
          historyIndex++;
          i = j - 1;
          continue;
        }

        // Calculate response_time (user message → FINAL assistant response)
        const response_time = calculateDuration(msg.timestamp, finalAssistantMsg.timestamp);

        history.push({
          role: 'Assistant',
          message: errorMessage,  // Use error message if present, otherwise assistant text
          message_raw: finalHasError ? errorMessage : assistantText,
          history_index: historyIndex,
          date: finalAssistantMsg.timestamp,
          response_time,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cache_creation_input_tokens: totalCacheCreationTokens,
          cache_read_input_tokens: totalCacheReadTokens,
          assistant_id: assistantId,
          thoughts: allThoughts.length > 0 ? allThoughts : undefined
        });

        historyIndex++;
        i = j - 1; // Skip to end of this turn
      } else if (systemErrors.length > 0) {
        // No successful assistant response, but have system errors
        // Create assistant message with error thoughts
        const errorThoughts: Thought[] = systemErrors.map(error => {
          const errorMsg = error.error?.error?.Message || error.error?.error?.message || 'Unknown error';
          const errorStatus = error.error?.status || 'unknown';
          return {
            id: error.uuid,
            parent_id: undefined,
            metadata: {
              timestamp: error.timestamp,
              error_status: errorStatus
            },
            in_progress: false,
            author_type: 'Agent',
            author_name: agentName || 'claude',
            message: `API Error (${errorStatus}): ${errorMsg}`,
            input_text: '',  // Empty to avoid duplication with user message
            output_format: 'error',
            error: true,
            children: []
          };
        });

        // Use last error timestamp for assistant message
        const lastError = systemErrors[systemErrors.length - 1];
        const response_time = calculateDuration(msg.timestamp, lastError.timestamp);

        history.push({
          role: 'Assistant',
          message: `Failed after ${systemErrors.length} error(s): ${errorThoughts[0].message}`,
          message_raw: `Failed after ${systemErrors.length} error(s)`,
          history_index: historyIndex,
          date: lastError.timestamp,
          response_time,
          assistant_id: assistantId,
          thoughts: errorThoughts
        });

        historyIndex++;
        i = j - 1;
      } else {
        // No assistant response and no errors - incomplete session
        // Still increment history index for the user message
        historyIndex++;
        i = j - 1; // Skip ahead to avoid double-processing
      }
    }
  }

  return history;
}

/**
 * Build map of tool results by tool_use_id
 * Allows matching tool calls with their results and error status
 */
function buildToolResultsMap(messages: ClaudeMessage[]): Map<string, { content: string; isError: boolean }> {
  const map = new Map<string, { content: string; isError: boolean }>();

  for (const msg of messages) {
    if (isToolResult(msg)) {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'tool_result') {
            // Check both is_error (API format) and isError (type format)
            const isError = (item as any).is_error === true || item.isError === true;
            map.set(item.tool_use_id || '', {
              content: item.content || '',
              isError
            });
          }
        }
      }
    }
  }

  return map;
}

/**
 * Extract user message with proper handling of slash commands
 * Uses common pattern: <command-name>/memory-refresh</command-name>
 */
function extractUserMessage(msg: ClaudeMessage): string {
  const content = msg.message?.content;

  if (typeof content === 'string') {
    // Check for XML-wrapped slash command using shared utility
    const command = extractCommand(content);
    if (command) {
      return command; // Return just the slash command
    }
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((item: ContentItem) => item.type === 'text')
      .map((item: ContentItem) => {
        const text = item.text || '';
        // Check for XML-wrapped slash command using shared utility
        const command = extractCommand(text);
        if (command) {
          return command; // Return just the slash command
        }
        return text;
      });
    return textParts.join('\n\n');
  }

  return '';
}

/**
 * Extract text content from message
 */
function extractTextContent(msg: ClaudeMessage): string {
  const content = msg.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((item: ContentItem) => item.type === 'text' || item.type === 'thinking')
      .map((item: ContentItem) => {
        if (item.type === 'thinking') {
          return item.thinking || '';
        }
        return item.text || '';
      });
    return textParts.join('\n\n');
  }

  return '';
}

/**
 * Extract tool calls from assistant message
 */
function extractToolCalls(msg: ClaudeMessage): ToolUse[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];

  return content.filter((item: ContentItem) => item.type === 'tool_use') as ToolUse[];
}

/**
 * Create Thought object from tool call and result
 * Maps to API schema from codemie-sdk
 */
function createToolThought(
  toolCall: ToolUse,
  toolResult?: { content: string; isError: boolean }
): Thought {
  return {
    id: toolCall.id,
    parent_id: undefined,
    metadata: {},
    in_progress: false,
    input_text: JSON.stringify(toolCall.input),      // Tool input as JSON string
    message: toolResult?.content || '',              // Tool result/observation
    author_type: 'Tool',                             // Tool type
    author_name: toolCall.name,                      // Tool name (e.g., "Read", "Edit")
    output_format: 'text',                           // Default output format
    error: toolResult?.isError || false,             // Error flag from tool result
    children: []
  };
}

/**
 * Create Thought object for intermediate assistant message
 * Preserves intermediate responses as Agent thoughts
 * @param id - Unique ID for the thought (use message UUID)
 * @param message - The intermediate assistant response text
 * @param agentName - Agent display name (e.g., "Claude Code")
 * @param timestamp - Timestamp of the intermediate response
 */
function createCodemieThought(
  id: string,
  message: string,
  agentName: string,
  timestamp: string
): Thought {
  return {
    id,
    parent_id: undefined,
    metadata: {
      timestamp,
      type: 'intermediate_response'
    },
    in_progress: false,
    input_text: '',                               // No input for intermediate responses
    message,                                       // The intermediate assistant response text
    author_type: 'Agent',                         // Agent type for intermediate responses
    author_name: agentName,                       // Agent display name (e.g., "Claude Code")
    output_format: 'text',                        // Text output
    error: false,                                 // No error
    children: []
  };
}

/**
 * Calculate processing response_time in seconds
 * @param startTimestamp - User message timestamp (ISO string)
 * @param endTimestamp - Final assistant message timestamp (ISO string)
 * @returns Response time in seconds (rounded to 2 decimals) or undefined if invalid
 */
function calculateDuration(startTimestamp: string, endTimestamp: string): number | undefined {
  try {
    const startMs = new Date(startTimestamp).getTime();
    const endMs = new Date(endTimestamp).getTime();

    if (isNaN(startMs) || isNaN(endMs)) {
      return undefined;  // Invalid timestamps
    }

    const durationMs = endMs - startMs;

    if (durationMs < 0) {
      console.warn('Negative duration detected (clock skew?):', { startTimestamp, endTimestamp });
      return 0;
    }

    const durationSec = durationMs / 1000;
    return Math.round(durationSec * 100) / 100;
  } catch (error) {
    console.error('Error calculating duration:', error);
    return undefined;
  }
}
