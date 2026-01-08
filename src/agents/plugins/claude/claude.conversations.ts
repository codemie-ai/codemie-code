/**
 * Claude Conversations Adapter
 *
 * Implements conversation sync support for Claude Code agent.
 * Handles Claude-specific message transformation logic.
 */

import type { CodemieHistoryEntry } from './claude.conversations-types.js';
import { transformMessages } from './claude.conversations-transformer.js';

/**
 * Agent Conversations Support Interface
 * Defines contract for agent-specific conversation transformation
 */
export interface AgentConversationsSupport {
  /**
   * Transform agent-specific messages to Codemie conversation format
   * @param messages - Raw session messages
   * @param assistantId - Assistant ID for the conversation
   * @param agentName - Agent display name
   * @returns Transformed conversation history
   */
  transformMessages(messages: any[], assistantId: string, agentName: string): CodemieHistoryEntry[];
}

/**
 * Claude Conversations Adapter
 * Implements conversation transformation for Claude Code sessions
 */
export class ClaudeConversationsAdapter implements AgentConversationsSupport {
  /**
   * Transform Claude messages to Codemie history format
   * Delegates to Claude-specific transformer
   */
  transformMessages(messages: any[], assistantId: string, agentName: string): CodemieHistoryEntry[] {
    return transformMessages(messages, assistantId, agentName);
  }
}
