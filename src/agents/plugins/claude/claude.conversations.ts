/**
 * Claude Conversations Adapter (Refactored)
 *
 * Implements conversation sync support for Claude Code agent.
 * Handles Claude-specific message transformation logic.
 *
 * Updated to use new stateless transformer with sync state.
 */

import type { SyncState, TransformResult } from './claude.conversations-types.js';
import { transformMessages } from './claude.conversations-transformer.js';

/**
 * Agent Conversations Support Interface
 * Defines contract for agent-specific conversation transformation
 *
 * Updated to accept sync state and return structured result
 */
export interface AgentConversationsSupport {
  /**
   * Transform agent-specific messages to Codemie conversation format
   *
   * @param messages - ALL raw session messages
   * @param syncState - Current sync state (where we left off)
   * @param assistantId - Assistant ID for the conversation
   * @param agentName - Agent display name
   * @returns Transform result with history and updated state
   */
  transformMessages(
    messages: any[],
    syncState: SyncState,
    assistantId?: string,
    agentName?: string
  ): TransformResult;
}

/**
 * Claude Conversations Adapter
 * Implements conversation transformation for Claude Code sessions
 */
export class ClaudeConversationsAdapter implements AgentConversationsSupport {
  /**
   * Transform Claude messages to Codemie history format
   * Delegates to Claude-specific stateless transformer
   */
  transformMessages(
    messages: any[],
    syncState: SyncState,
    assistantId?: string,
    agentName?: string
  ): TransformResult {
    return transformMessages(messages, syncState, assistantId, agentName);
  }
}
