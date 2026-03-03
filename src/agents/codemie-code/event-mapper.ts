/**
 * Event mapper between OpenCode streaming format and CodeMie events
 */

import type { AgentEvent, OpenCodeStreamChunk } from './types.js';
import { EVENT_TYPES } from './types.js';

/**
 * Maps OpenCode streaming chunks to CodeMie AgentEvent format
 */
export class EventMapper {
  private activeToolCalls = new Map<string, { name: string; args: Record<string, any> }>();

  /**
   * Map an OpenCode stream chunk to CodeMie event format
   *
   * @param chunk - OpenCode streaming chunk
   * @returns Mapped AgentEvent or null if no mapping needed
   */
  mapStreamChunk(chunk: OpenCodeStreamChunk): AgentEvent | null {
    switch (chunk.type) {
      case 'text-delta':
        return {
          type: EVENT_TYPES.CONTENT_CHUNK,
          content: chunk.textDelta,
        };

      case 'tool-call':
        // Store tool call info for later result mapping
        this.activeToolCalls.set(chunk.toolCallId, {
          name: chunk.toolName,
          args: chunk.args,
        });

        return {
          type: EVENT_TYPES.TOOL_CALL_START,
          toolName: chunk.toolName,
          toolArgs: chunk.args,
        };

      case 'tool-result': {
        // Retrieve tool info from active calls
        const toolInfo = this.activeToolCalls.get(chunk.toolCallId);
        if (toolInfo) {
          this.activeToolCalls.delete(chunk.toolCallId);
          return {
            type: EVENT_TYPES.TOOL_CALL_RESULT,
            toolName: toolInfo.name,
            result: chunk.result,
          };
        }
        return null;
      }

      case 'error':
        return {
          type: EVENT_TYPES.ERROR,
          error: chunk.error,
        };

      case 'finish':
        return {
          type: EVENT_TYPES.COMPLETE,
        };

      default:
        // Unknown chunk type, ignore
        return null;
    }
  }

  /**
   * Reset the mapper state (clear active tool calls)
   */
  reset(): void {
    this.activeToolCalls.clear();
  }
}
