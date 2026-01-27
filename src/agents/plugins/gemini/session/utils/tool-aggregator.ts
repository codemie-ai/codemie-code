/**
 * Tool call extraction for Gemini conversations
 *
 * Extracts tool calls from Gemini's nested structure and transforms them
 * into the standard thought format used by conversation history.
 *
 * Gemini Tool Structure:
 * toolCall.result[0].functionResponse.response.output
 */

import type { GeminiMessage, GeminiToolCall } from './turn-detector.js';

export interface ToolThought {
  id: string;
  metadata: {
    timestamp: string;
    displayName?: string;
  };
  in_progress: boolean;
  input_text: string;
  message: string;
  author_type: 'Tool';
  author_name: string;
  output_format: 'text';
  error: boolean;
  children: unknown[];
}

/**
 * Extracts the result from a tool call's nested structure
 *
 * @param toolCall - Gemini tool call with nested result
 * @returns Extracted result as string
 */
function extractToolResult(toolCall: GeminiToolCall): string {
  const output = toolCall.result?.[0]?.functionResponse?.response?.output;

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output === 'object' && output !== null) {
    return JSON.stringify(output, null, 2);
  }

  return ''; // No result available
}

/**
 * Extracts tool thoughts from Gemini messages in a turn
 *
 * @param geminiMessages - All Gemini messages in the turn
 * @returns Array of tool thoughts in standard format
 */
export function extractToolThoughts(geminiMessages: GeminiMessage[]): ToolThought[] {
  const thoughts: ToolThought[] = [];

  for (const msg of geminiMessages) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }

    for (const toolCall of msg.toolCalls) {
      thoughts.push({
        id: toolCall.id,
        metadata: {
          timestamp: toolCall.timestamp,
          displayName: toolCall.displayName
        },
        in_progress: false,
        input_text: JSON.stringify(toolCall.args),
        message: extractToolResult(toolCall),
        author_type: 'Tool',
        author_name: toolCall.name,
        output_format: 'text',
        error: toolCall.status === 'error',
        children: []
      });
    }
  }

  return thoughts;
}
