/**
 * Conversation Transformer (Refactored)
 *
 * Stateless transformer that uses sync state to determine incremental updates
 *
 * Key Improvements:
 * - Accepts sync state (lastSyncedMessageUuid, lastSyncedHistoryIndex)
 * - Returns structured result with continuation flag
 * - Tool results trigger turn continuation (not filtered)
 * - Skips messages without uuid (snapshots, summaries)
 * - Deterministic and testable
 */

import type {
  ClaudeMessage,
  CodemieHistoryEntry,
  Thought,
  ToolUse,
  ContentItem
} from './claude.conversations-types.js';
import { shouldFilterMessage, isToolResult, extractCommand } from './claude.conversations-filters.js';

/**
 * Result of message transformation with state updates
 */
export interface TransformResult {
  history: CodemieHistoryEntry[];
  isTurnContinuation: boolean;
  lastProcessedMessageUuid: string;
  currentHistoryIndex: number;
}

/**
 * Sync state input for transformer
 */
export interface SyncState {
  lastSyncedMessageUuid?: string;
  lastSyncedHistoryIndex: number;
}

/**
 * Transform Claude messages to Codemie history format (stateless)
 *
 * @param messages - ALL Claude session messages
 * @param syncState - Current sync state (where we left off)
 * @param assistantId - Assistant ID for assistant messages
 * @param agentName - Agent display name (e.g., 'Claude Code')
 * @returns Transform result with history and updated state
 */
export function transformMessages(
  messages: ClaudeMessage[],
  syncState: SyncState,
  assistantId?: string,
  agentName?: string
): TransformResult {
  // ============================================================
  // STEP 1: Find starting point based on last synced message
  // ============================================================
  let startIndex = 0;
  if (syncState.lastSyncedMessageUuid) {
    const lastSyncedIndex = messages.findIndex(
      m => m.uuid === syncState.lastSyncedMessageUuid
    );
    if (lastSyncedIndex >= 0) {
      startIndex = lastSyncedIndex + 1; // Start AFTER last synced
    }
  }

  const newMessages = messages.slice(startIndex);

  // No new messages - return early
  if (newMessages.length === 0) {
    return {
      history: [],
      isTurnContinuation: false,
      lastProcessedMessageUuid: syncState.lastSyncedMessageUuid || '',
      currentHistoryIndex: syncState.lastSyncedHistoryIndex
    };
  }

  // ============================================================
  // STEP 2: Find first relevant message
  // ✅ CRITICAL FIX: Tool results trigger turn continuation!
  // ============================================================
  let firstRealMessage: ClaudeMessage | null = null;

  for (const msg of newMessages) {
    // Skip messages without uuid (snapshots, summaries)
    if (!msg.uuid) continue;

    // ✅ FIX: Tool results are NOT filtered here - they trigger continuation!
    if (msg.type === 'user' && isToolResult(msg)) {
      firstRealMessage = msg;
      break;
    }

    // Filter system messages (but not tool results)
    if (shouldFilterMessage(msg)) continue;

    // Found first real message
    firstRealMessage = msg;
    break;
  }

  // All new messages are filtered - update UUID and return
  if (!firstRealMessage) {
    let lastUuid = syncState.lastSyncedMessageUuid || '';
    for (let i = newMessages.length - 1; i >= 0; i--) {
      if (newMessages[i].uuid) {
        lastUuid = newMessages[i].uuid;
        break;
      }
    }

    return {
      history: [],
      isTurnContinuation: false,
      lastProcessedMessageUuid: lastUuid,
      currentHistoryIndex: syncState.lastSyncedHistoryIndex
    };
  }

  // ============================================================
  // STEP 3: Determine if turn continuation or new turn
  // ============================================================
  const isNewUserMessage = firstRealMessage.type === 'user' &&
                          !isToolResult(firstRealMessage);
  const isTurnContinuation = !isNewUserMessage;

  // ============================================================
  // STEP 4: Determine history index for this batch
  // ============================================================
  let currentHistoryIndex = syncState.lastSyncedHistoryIndex;
  if (!isTurnContinuation) {
    // New turn - increment history index
    currentHistoryIndex++;
  }

  // ============================================================
  // STEP 5: Build turn messages and transform
  // ============================================================
  let history: CodemieHistoryEntry[];
  let lastProcessedMessageUuid = '';

  if (isTurnContinuation) {
    // --------------------------------------------------------
    // TURN CONTINUATION: Re-transform entire turn from start
    // --------------------------------------------------------

    // Find turn start (walk backwards from last synced message)
    const lastSyncedIndex = syncState.lastSyncedMessageUuid
      ? messages.findIndex(m => m.uuid === syncState.lastSyncedMessageUuid)
      : -1;

    let turnStartIndex = 0;
    if (lastSyncedIndex >= 0) {
      for (let i = lastSyncedIndex; i >= 0; i--) {
        const msg = messages[i];
        if (!msg.uuid) continue;
        if (msg.type === 'user' && !shouldFilterMessage(msg) && !isToolResult(msg)) {
          turnStartIndex = i;
          break;
        }
      }
    }

    // Find turn end (first real user message after current position)
    let turnEndIndex = messages.length;
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.uuid) continue;
      if (msg.type === 'user' && !shouldFilterMessage(msg) && !isToolResult(msg)) {
        turnEndIndex = i;
        break;
      }
    }

    // Extract turn messages
    const turnMessages = messages.slice(turnStartIndex, turnEndIndex);

    // Transform the entire turn
    const turnHistory = transformTurn(
      turnMessages,
      currentHistoryIndex,
      assistantId,
      agentName
    );

    // Return only Assistant entry (User already synced in previous sync)
    history = turnHistory.filter(entry => entry.role === 'Assistant');

    // Find last processed message UUID in this batch
    for (let i = turnEndIndex - 1; i >= turnStartIndex; i--) {
      if (messages[i].uuid) {
        lastProcessedMessageUuid = messages[i].uuid;
        break;
      }
    }

  } else {
    // --------------------------------------------------------
    // NEW TURN: Transform from first user message onwards
    // --------------------------------------------------------

    // Find the index of the first user message in original messages array
    let firstUserIndex = startIndex;
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.uuid) continue;
      if (msg.type === 'user' && !shouldFilterMessage(msg) && !isToolResult(msg)) {
        firstUserIndex = i;
        break;
      }
    }

    // Find turn end (start scanning AFTER the first user message)
    let turnEndIndex = messages.length;
    for (let i = firstUserIndex + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.uuid) continue;
      if (msg.type === 'user' && !shouldFilterMessage(msg) && !isToolResult(msg)) {
        turnEndIndex = i;
        break;
      }
    }

    // Extract turn messages (from first user message to turn end)
    const turnMessages = messages.slice(firstUserIndex, turnEndIndex);

    // Transform the turn
    history = transformTurn(
      turnMessages,
      currentHistoryIndex,
      assistantId,
      agentName
    );

    // Find last processed message UUID
    for (let i = turnEndIndex - 1; i >= firstUserIndex; i--) {
      if (messages[i].uuid) {
        lastProcessedMessageUuid = messages[i].uuid;
        break;
      }
    }
  }

  // ============================================================
  // STEP 6: Return result
  // ============================================================
  return {
    history,
    isTurnContinuation,
    lastProcessedMessageUuid,
    currentHistoryIndex
  };
}

/**
 * Transform a single turn (user message + assistant responses)
 * Extracted from original transformer for reuse
 */
function transformTurn(
  turnMessages: ClaudeMessage[],
  historyIndex: number,
  assistantId?: string,
  agentName?: string
): CodemieHistoryEntry[] {
  const history: CodemieHistoryEntry[] = [];

  // Build tool results map
  const toolResultsMap = buildToolResultsMap(turnMessages);

  // Find user message (should be first non-filtered message)
  let userMessage: ClaudeMessage | null = null;
  for (const msg of turnMessages) {
    if (msg.type === 'user' && !shouldFilterMessage(msg) && !isToolResult(msg)) {
      userMessage = msg;
      break;
    }
  }

  if (!userMessage) {
    // No user message found - incomplete turn
    return [];
  }

  // Add user message
  const userText = extractUserMessage(userMessage);
  history.push({
    role: 'User',
    message: userText,
    history_index: historyIndex,
    date: userMessage.timestamp,
    message_raw: userText,
    file_names: []
  });

  // Collect assistant messages, meta messages, system errors
  const assistantMessages: ClaudeMessage[] = [];
  const metaMessages: ClaudeMessage[] = [];
  const systemErrors: ClaudeMessage[] = [];

  for (const msg of turnMessages) {
    if (msg.type === 'assistant') {
      assistantMessages.push(msg);
    } else if (msg.type === 'user' && (msg as any).isMeta) {
      metaMessages.push(msg);
    } else if (msg.type === 'system' && msg.subtype === 'api_error') {
      systemErrors.push(msg);
    }
  }

  if (assistantMessages.length > 0) {
    const finalAssistantMsg = assistantMessages[assistantMessages.length - 1];

    // Collect all thoughts
    const allThoughts: Thought[] = [];

    // Process meta messages
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

      // Check for errors
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
          input_text: '',
          output_format: 'error',
          error: true,
          children: []
        });
        continue;
      }

      // Extract tool calls
      const toolCalls = extractToolCalls(assistantMsg);
      for (const toolCall of toolCalls) {
        const toolResult = toolResultsMap.get(toolCall.id);

        // ✅ IMPORTANT: Add tool if it has result OR is in intermediate message
        const shouldAddTool = toolResult !== undefined || isIntermediateMsg;

        if (shouldAddTool) {
          allThoughts.push(createToolThought(toolCall, toolResult));
        }
      }

      // Add intermediate text as thoughts
      if (isIntermediateMsg) {
        const intermediateText = extractTextContent(assistantMsg);
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

    // Aggregate tokens
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

    // Extract final assistant text
    const assistantText = extractTextContent(finalAssistantMsg);
    const finalHasError = finalAssistantMsg.message?.Output?.__type ||
                         finalAssistantMsg.message?.error;
    let errorMessage = finalHasError
      ? `Error: ${finalAssistantMsg.message?.Output?.__type ||
                  finalAssistantMsg.message?.error?.message || 'Unknown error'}`
      : assistantText;

    // Skip empty responses with no thoughts
    if (!errorMessage.trim() && allThoughts.length === 0) {
      return history; // Just User entry
    }

    // Calculate response time
    const response_time = calculateDuration(userMessage.timestamp, finalAssistantMsg.timestamp);

    // Add assistant entry
    history.push({
      role: 'Assistant',
      message: errorMessage,
      message_raw: finalHasError ? errorMessage : (assistantText || errorMessage),
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

  } else if (systemErrors.length > 0) {
    // Handle system errors
    const errorThoughts: Thought[] = systemErrors.map(error => {
      const errorMsg = error.error?.error?.Message ||
                      error.error?.error?.message || 'Unknown error';
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
        input_text: '',
        output_format: 'error',
        error: true,
        children: []
      };
    });

    const lastError = systemErrors[systemErrors.length - 1];
    const response_time = calculateDuration(userMessage.timestamp, lastError.timestamp);

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

            // Extract text from content (can be string or array of content items)
            let textContent = '';
            if (typeof item.content === 'string') {
              textContent = item.content;
            } else if (Array.isArray(item.content)) {
              // Tool result content can be array (e.g., Task tool returns full response with content array)
              textContent = item.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n\n');
            }

            map.set(item.tool_use_id || '', {
              content: textContent,
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
 * @param toolCall - The tool_use from Claude message
 * @param toolResult - The tool result/observation (if available)
 */
function createToolThought(
  toolCall: ToolUse,
  toolResult?: { content: string; isError: boolean }
): Thought {
  return {
    id: toolCall.id,                                 // Use tool_use_id as unique identifier
    parent_id: undefined,
    metadata: {},                                    // Empty metadata (tool_use_id is now primary ID)
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
