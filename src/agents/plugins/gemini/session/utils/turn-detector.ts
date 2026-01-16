/**
 * Turn detection for Gemini conversations
 *
 * Detects turn boundaries in Gemini message history:
 * - Turn starts with: type === 'user'
 * - Turn ends at: next 'user' OR 'error'/'info'/'warning' OR EOF
 */

export interface GeminiMessage {
  id: string;
  type: 'user' | 'gemini' | 'error' | 'info' | 'warning';
  timestamp: string; // ISO format
  content: string;
  toolCalls?: GeminiToolCall[];
  tokens?: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
  };
  model?: string;
}

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: Array<{
    functionResponse?: {
      response?: {
        output?: string | Record<string, unknown>;
      };
    };
  }>;
  status: 'success' | 'error';
  timestamp: string;
  displayName?: string;
}

export interface TurnBoundary {
  startIndex: number;
  endIndex: number;
  userMessage: GeminiMessage;
  geminiMessages: GeminiMessage[];
  systemMessages: GeminiMessage[];
}

/**
 * Checks if a message is a system message (error, info, warning)
 */
function isSystemMessage(msg: GeminiMessage): boolean {
  return msg.type === 'error' || msg.type === 'info' || msg.type === 'warning';
}

/**
 * Extracts a single turn from a range of messages
 */
function extractTurn(messages: GeminiMessage[], startIndex: number, endIndex: number): TurnBoundary {
  const turnMessages = messages.slice(startIndex, endIndex + 1);

  return {
    startIndex,
    endIndex,
    userMessage: turnMessages[0], // Must be user
    geminiMessages: turnMessages.filter(m => m.type === 'gemini'),
    systemMessages: turnMessages.filter(m => isSystemMessage(m))
  };
}

/**
 * Detects turn boundaries in Gemini message history
 *
 * Algorithm:
 * 1. Iterate through messages
 * 2. When encountering 'user' message:
 *    - Close previous turn (if exists)
 *    - Start new turn
 * 3. When encountering system message:
 *    - Close current turn (if exists)
 *    - Don't start new turn (system messages are standalone)
 * 4. At EOF, close any open turn
 *
 * @param messages - Array of Gemini messages
 * @returns Array of turn boundaries
 */
export function detectTurns(messages: GeminiMessage[]): TurnBoundary[] {
  const turns: TurnBoundary[] = [];
  let currentTurnStart: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Turn start: user message
    if (msg.type === 'user') {
      // Close previous turn if exists
      if (currentTurnStart !== null) {
        turns.push(extractTurn(messages, currentTurnStart, i - 1));
      }
      currentTurnStart = i;
    }

    // Turn end: system message
    if (isSystemMessage(msg) && currentTurnStart !== null) {
      turns.push(extractTurn(messages, currentTurnStart, i));
      currentTurnStart = null;
    }
  }

  // Close final turn if exists
  if (currentTurnStart !== null) {
    turns.push(extractTurn(messages, currentTurnStart, messages.length - 1));
  }

  return turns;
}

/**
 * Filters messages to only include those after the last synced message
 *
 * @param messages - All messages
 * @param lastSyncedId - ID of last processed message (null for first sync)
 * @returns Messages that haven't been processed yet
 */
export function filterNewMessages(
  messages: GeminiMessage[],
  lastSyncedId: string | null
): GeminiMessage[] {
  if (!lastSyncedId) {
    return messages; // First sync, process all
  }

  const lastSyncedIndex = messages.findIndex(m => m.id === lastSyncedId);

  if (lastSyncedIndex === -1) {
    // Last synced message not found, process all (with warning logged by caller)
    return messages;
  }

  return messages.slice(lastSyncedIndex + 1);
}
