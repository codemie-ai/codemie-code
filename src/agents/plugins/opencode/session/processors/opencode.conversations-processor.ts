// src/agents/plugins/opencode/session/processors/opencode.conversations-processor.ts
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
// FIXED (GPT-5.10/5.11): Import type guards from opencode-message-types.js instead of redefining
// This removes duplicate function definitions that shadowed the imports
import type {
  OpenCodeMessage,
  OpenCodeAssistantMessage,
  OpenCodePart
} from '../../opencode-message-types.js';
import {
  isTextPart,
  isToolPart,
  isFilePart,
  isReasoningPart
} from '../../opencode-message-types.js';
import { logger } from '../../../../../utils/logger.js';

// NOTE (GPT-5.10/5.11): Type guards are now imported from opencode-message-types.js
// DO NOT redefine them here - the original code had duplicate definitions that shadowed the imports

/**
 * Normalized conversation message format
 * Aligns with CodeMie's conversation sync API
 */
interface NormalizedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  agent?: string;
  toolUse?: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: string;
  }>;
  fileReferences?: string[];
  thinking?: string;
}

/**
 * OpenCode Conversations Processor
 *
 * Normalizes OpenCode messages and parts into unified conversation format.
 * Implements SessionProcessor interface for processor chain.
 */
export class OpenCodeConversationsProcessor implements SessionProcessor {
  readonly name = 'opencode-conversations';
  readonly priority = 2;  // Run after metrics

  /**
   * Check if session has data to process
   */
  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  /**
   * Process session to normalize conversations
   */
  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const messages = session.messages as OpenCodeMessage[];
      const normalizedMessages: NormalizedMessage[] = [];

      for (const message of messages) {
        // UPDATED (GPT-5.9): Use time.created (numeric) instead of createdAt (string)
        // For full implementation, parts would be loaded from part/{messageId}/*.json
        // For now, create basic normalized message from message data
        const normalized: NormalizedMessage = {
          id: message.id,
          role: message.role,
          content: '',  // Would be populated from text parts (AC-EXT-1)
          // UPDATED (GPT-5.9): Convert numeric timestamp to ISO string
          timestamp: message.time?.created
            ? new Date(message.time.created).toISOString()
            : new Date().toISOString(),
          // UPDATED (GPT-5.9): modelID is on assistant messages only
          model: message.role === 'assistant'
            ? (message as OpenCodeAssistantMessage).modelID
            : undefined,
          agent: message.role === 'assistant'
            ? (message as OpenCodeAssistantMessage).agent
            : undefined
        };

        normalizedMessages.push(normalized);
      }

      logger.debug(
        `[opencode-conversations] Normalized ${normalizedMessages.length} messages`
      );

      return {
        success: true,
        message: `Normalized ${normalizedMessages.length} messages`,
        metadata: {
          recordsProcessed: normalizedMessages.length,
          userMessages: normalizedMessages.filter(m => m.role === 'user').length,
          assistantMessages: normalizedMessages.filter(m => m.role === 'assistant').length
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[opencode-conversations] Processing failed:`, error);
      return {
        success: false,
        message: `Conversations processing failed: ${errorMessage}`
      };
    }
  }

  /**
   * Process parts for a message (helper for full implementation)
   * Parts are loaded from part/{messageID}/*.json
   *
   * UPDATED (GPT-5.9): Use new part schema:
   * - Tool parts: callID, tool, state.input, state (not toolName, toolInput, toolOutput)
   * - File parts: mime, url, source, filename (not filePath, content)
   */
  private processParts(parts: OpenCodePart[]): {
    content: string;
    toolUse: NormalizedMessage['toolUse'];
    fileReferences: string[];
    thinking: string;
  } {
    const textParts: string[] = [];
    const toolUse: NonNullable<NormalizedMessage['toolUse']> = [];
    const fileReferences: string[] = [];
    const thinkingParts: string[] = [];

    for (const part of parts) {
      // Use type guards for safe narrowing
      if (isTextPart(part)) {
        textParts.push(part.text);
      } else if (isToolPart(part)) {
        // UPDATED (GPT-5.9): New tool part schema
        toolUse.push({
          name: part.tool,  // Was: part.toolName
          input: part.state.input || {},  // Input is inside state
          output: part.state?.output  // Was: part.toolOutput
        });
      } else if (isFilePart(part)) {
        // UPDATED (GPT-5.9): New file part schema
        // Use url or construct reference from filename
        if (part.url) {
          fileReferences.push(part.url);
        } else if (part.filename) {
          fileReferences.push(part.filename);
        }
      } else if (isReasoningPart(part)) {
        thinkingParts.push(part.text);
      }
      // step-finish parts are skipped (metadata only - tokens/cost handled by metrics)
    }

    return {
      content: textParts.join('\n'),
      toolUse: toolUse.length > 0 ? toolUse : undefined,
      fileReferences: fileReferences.length > 0 ? fileReferences : [],
      thinking: thinkingParts.join('\n')
    };
  }
}
