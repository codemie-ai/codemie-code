/**
 * Assistant Invocation Tool
 *
 * Allows the agent to invoke registered CodeMie assistants for specialized help.
 * Supports optional conversation history passing for context-aware responses.
 */

import { z } from 'zod';
import { StructuredTool } from '@langchain/core/tools';
import type { CodeMieClient } from 'codemie-sdk';
import type { BaseMessage } from '@langchain/core/messages';
import { ConfigLoader, loadRegisteredAssistants } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { logger } from '@/utils/logger.js';
import type { CodemieAssistant } from '@/env/types.js';

interface HistoryMessage {
  role: 'User' | 'Assistant';
  message?: string;
}

/**
 * Find assistant by slug
 */
function findAssistantBySlug(
  assistants: CodemieAssistant[],
  slug: string
): CodemieAssistant | undefined {
  return assistants.find(a => a.slug === slug);
}

/**
 * Convert LangChain conversation history to CodeMie assistant format
 */
function convertConversationHistory(messages: BaseMessage[]): HistoryMessage[] {
  return messages
    .filter(m => {
      const type = m._getType();
      return type === 'human' || type === 'ai';
    })
    .map(m => ({
      role: m._getType() === 'human' ? 'User' : 'Assistant',
      message: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));
}

/**
 * Invoke a CodeMie assistant via SDK
 */
async function invokeAssistantViaSdk(
  client: CodeMieClient,
  assistantId: string,
  message: string,
  history?: HistoryMessage[]
): Promise<string> {
  try {
    // Use session ID to maintain conversation context across multiple assistant calls
    const sessionId = logger.getSessionId();

    const params: any = {
      conversation_id: sessionId, // Pass session ID to maintain conversation context
      text: message,
      history: history && history.length > 0 ? history : [], // Always provide array, empty if no history
      stream: false
    };

    logger.debug('Calling assistants.chat', {
      assistantId,
      conversationId: sessionId,
      historyLength: Array.isArray(params.history) ? params.history.length : 'string'
    });

    const response = await client.assistants.chat(assistantId, params);

    // Handle different types of generated content
    if (typeof response.generated === 'string') {
      return response.generated;
    } else if (response.generated) {
      return JSON.stringify(response.generated);
    }

    return 'No response from assistant';
  } catch (error) {
    logger.error('Assistant invocation failed', { assistantId, error });
    throw error;
  }
}

/**
 * Tool for invoking registered CodeMie assistants
 */
export class InvokeAssistantTool extends StructuredTool {
  name = 'invoke_assistant';
  description = 'Invoke a registered CodeMie assistant for specialized help. Use this when you need expert assistance on specific topics like architecture, code review, or domain-specific questions. Available assistants are registered via "codemie assistants list" command.';

  schema = z.object({
    assistantSlug: z.string().describe('The slug identifier of the assistant to invoke (e.g., "solution-architect", "code-reviewer")'),
    message: z.string().describe('The message or question to send to the assistant'),
    includeHistory: z.boolean().optional().default(false).describe('Whether to include conversation history for context. Set to true if the assistant needs to understand the conversation context.')
  });

  private getConversationHistory: () => BaseMessage[];

  constructor(getConversationHistory: () => BaseMessage[]) {
    super();
    this.getConversationHistory = getConversationHistory;
  }

  async _call({ assistantSlug, message, includeHistory }: z.infer<typeof this.schema>): Promise<string> {
    logger.debug('Invoking assistant via tool', { assistantSlug, includeHistory });

    try {
      // Load registered assistants
      const assistants = await loadRegisteredAssistants();

      if (assistants.length === 0) {
        return 'No assistants are currently registered. Register assistants using "codemie assistants list" command.';
      }

      // Find assistant by slug
      const assistant = findAssistantBySlug(assistants, assistantSlug);

      if (!assistant) {
        const availableSlugs = assistants.map(a => a.slug).join(', ');
        return `Assistant "${assistantSlug}" not found. Available assistants: ${availableSlugs}`;
      }

      // Get authenticated client
      const config = await ConfigLoader.load();
      const client = await getAuthenticatedClient(config);

      // Convert history if requested
      let history: HistoryMessage[] | undefined;
      if (includeHistory) {
        const conversationHistory = this.getConversationHistory();
        history = convertConversationHistory(conversationHistory);
        logger.debug('Including conversation history', { historyLength: history.length });
      }

      // Invoke assistant
      const response = await invokeAssistantViaSdk(client, assistant.id, message, history);

      logger.debug('Assistant invocation successful', {
        assistantSlug,
        responseLength: response.length
      });

      return `[Assistant @${assistantSlug}] ${response}`;

    } catch (error) {
      logger.error('Assistant invocation tool failed', { assistantSlug, error });

      if (error instanceof Error) {
        if (error.message.includes('401') || error.message.includes('403')) {
          return `Authentication failed. Please run "codemie setup" to configure your credentials.`;
        }
        return `Failed to invoke assistant: ${error.message}`;
      }

      return 'Failed to invoke assistant due to an unknown error.';
    }
  }
}

/**
 * Export helper functions for testing and direct use
 */
export {
  findAssistantBySlug,
  convertConversationHistory,
  invokeAssistantViaSdk
};
