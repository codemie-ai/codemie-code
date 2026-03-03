/**
 * Session adapter using Vercel AI SDK
 *
 * This adapter provides a simplified session management layer
 * using the Vercel AI SDK instead of OpenCode's full session system.
 */

import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { OpenCodeConfig, AgentEvent } from './types.js';
import { EventMapper } from './event-mapper.js';
import { logger } from '../../utils/logger.js';

/**
 * Simple session adapter for managing AI interactions
 */
export class OpenCodeSessionAdapter {
  private config: OpenCodeConfig;
  private eventMapper: EventMapper;
  private provider: any;
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.eventMapper = new EventMapper();
    this.provider = this.createProvider();
  }

  /**
   * Create AI provider based on configuration
   */
  private createProvider(): any {
    const { provider, model, apiKey, baseUrl } = this.config;

    try {
      switch (provider) {
        case 'anthropic':
          return createAnthropic({
            apiKey,
            baseURL: baseUrl,
          })(model);

        case 'openai':
          // Check if this is an SSO provider (has cookies in global scope)
          if ((global as any).codemieSSOCookies && baseUrl) {
            return this.createSSOProvider(model, baseUrl);
          }
          return createOpenAI({
            apiKey,
            baseURL: baseUrl,
          })(model);

        case 'azure':
          return createAzure({
            apiKey,
            baseURL: baseUrl,
          })(model);

        case 'amazon-bedrock':
          return createAmazonBedrock({
            // Bedrock uses AWS credentials from environment
          })(model);

        case 'google':
          return createGoogleGenerativeAI({
            apiKey,
            baseURL: baseUrl,
          })(model);

        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      logger.error('Failed to create provider', { provider, model, error });
      throw error;
    }
  }

  /**
   * Create OpenAI-compatible provider with cookie-based auth for SSO
   */
  private createSSOProvider(model: string, baseUrl: string): any {
    const cookies = (global as any).codemieSSOCookies;

    if (!cookies) {
      throw new Error('SSO cookies not found in global scope');
    }

    // Convert cookies object to Cookie header string
    const cookieHeader = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    logger.debug('Creating SSO provider', { baseUrl, model, hasCookies: !!cookieHeader });

    return createOpenAICompatible({
      name: 'codemie-sso',
      apiKey: 'not-used', // SSO uses cookies, not API key
      baseURL: baseUrl,
      headers: {
        Cookie: cookieHeader,
      },
    })(model);
  }

  /**
   * Process a message with streaming
   */
  async processMessage(
    message: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<string> {
    // Add user message to history
    this.messages.push({ role: 'user', content: message });

    let fullResponse = '';

    try {
      // Reset event mapper for this turn
      this.eventMapper.reset();

      const result = await streamText({
        model: this.provider,
        messages: this.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      });

      // Stream the response
      for await (const chunk of result.textStream) {
        fullResponse += chunk;

        // Map to CodeMie event format
        const event = this.eventMapper.mapStreamChunk({
          type: 'text-delta',
          textDelta: chunk,
        });

        if (event) {
          onEvent(event);
        }
      }

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: fullResponse });

      // Send completion event
      onEvent(this.eventMapper.mapStreamChunk({ type: 'finish', finishReason: 'stop' })!);

      return fullResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error processing message', { error: errorMessage });

      // Send error event
      const errorEvent = this.eventMapper.mapStreamChunk({
        type: 'error',
        error: errorMessage,
      });
      if (errorEvent) {
        onEvent(errorEvent);
      }

      throw error;
    }
  }

  /**
   * Execute a single task without streaming
   */
  async executeTask(task: string): Promise<string> {
    // Add user message to history
    this.messages.push({ role: 'user', content: task });

    try {
      const result = await generateText({
        model: this.provider,
        messages: this.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      });

      const response = result.text;

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: response });

      return response;
    } catch (error) {
      logger.error('Error executing task', { error });
      throw error;
    }
  }

  /**
   * Get conversation history
   */
  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [...this.messages];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.messages = [];
  }

  /**
   * Get session statistics
   */
  getStats() {
    return {
      messageCount: this.messages.length,
      userMessages: this.messages.filter((m) => m.role === 'user').length,
      assistantMessages: this.messages.filter((m) => m.role === 'assistant').length,
    };
  }
}
