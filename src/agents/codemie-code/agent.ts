/**
 * CodeMie Native Agent Implementation
 *
 * Core LangGraph ReAct agent using LangChain v1.0+ with streaming support
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { CodeMieConfig, EventCallback, AgentStats, ExecutionStep, TokenUsage } from './types.js';
import type { ClipboardImage } from '../../utils/clipboard.js';
import { getSystemPrompt } from './prompts.js';
import { CodeMieAgentError } from './types.js';
import { extractToolMetadata } from './toolMetadata.js';
import { extractTokenUsageFromStreamChunk, extractTokenUsageFromFinalState } from './tokenUtils.js';
import { setGlobalToolEventCallback } from './tools/index.js';
import { logger } from '../../utils/logger.js';
import { sanitizeCookies, sanitizeAuthToken } from '../../utils/security.js';

export class CodeMieAgent {
  private agent: any;
  private config: CodeMieConfig;
  private tools: StructuredTool[];
  private conversationHistory: BaseMessage[] = [];
  private toolCallArgs: Map<string, Record<string, any>> = new Map(); // Store tool args by tool call ID
  private currentExecutionSteps: ExecutionStep[] = [];
  private currentStepNumber = 0;
  private currentLLMTokenUsage: TokenUsage | null = null; // Store token usage for associating with next tool call
  private isFirstLLMCall = true; // Track if this is the initial user input processing
  private stats: AgentStats = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedTotalCost: 0,
    executionTime: 0,
    toolCalls: 0,
    successfulTools: 0,
    failedTools: 0,
    llmCalls: 0,
    executionSteps: []
  };

  constructor(config: CodeMieConfig, tools: StructuredTool[]) {
    this.config = config;
    this.tools = tools;

    // Create the appropriate LLM based on provider
    const llm = this.createLLM();

    // Create LangGraph ReAct agent with system prompt
    this.agent = createReactAgent({
      llm,
      tools: this.tools,
      messageModifier: getSystemPrompt(config.workingDirectory)
    });

    if (config.debug) {
      logger.debug(`CodeMie Agent initialized with ${tools.length} tools`);
    }
  }

  /**
   * Create the appropriate LLM instance based on provider configuration
   */
  private createLLM() {
    const commonConfig = {
      temperature: 0.7,
      maxTokens: 4096,
      timeout: this.config.timeout * 1000
    };

    switch (this.config.provider) {
      case 'openai':
        return new ChatOpenAI({
          model: this.config.model,
          apiKey: this.config.authToken,
          configuration: {
            ...(this.config.baseUrl !== 'https://api.openai.com/v1' && {
              baseURL: this.config.baseUrl
            }),
            // Add client tracking headers to all OpenAI requests
            fetch: async (input: string | URL | Request, init?: RequestInit) => {
              const cliVersion = process.env.CODEMIE_CLI_VERSION || 'unknown';
              const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

              if (this.config.debug) {
                logger.debug(`OpenAI request to: ${url}`);
              }

              const updatedInit = {
                ...init,
                headers: {
                  ...init?.headers,
                  'X-CodeMie-CLI': `codemie-cli/${cliVersion}`,
                  'X-CodeMie-Client': 'codemie-code'
                }
              };

              try {
                return await fetch(input, updatedInit);
              } catch (error) {
                if (this.config.debug) {
                  logger.debug(`Fetch error for ${url}:`, error);
                }
                throw error;
              }
            }
          },
          ...commonConfig
        });

      case 'azure':
        return new ChatOpenAI({
          model: this.config.model,
          apiKey: this.config.authToken,
          configuration: {
            baseURL: this.config.baseUrl,
            defaultQuery: { 'api-version': '2024-02-01' },
            // Add client tracking header to all Azure requests
            fetch: async (input: string | URL | Request, init?: RequestInit) => {
              const updatedInit = {
                ...init,
                headers: {
                  ...init?.headers,
                  'X-CodeMie-Client': 'codemie-code'
                }
              };
              return fetch(input, updatedInit);
            }
          },
          ...commonConfig
        });

      case 'bedrock':
        // For Bedrock, use OpenAI format with AWS Bedrock credentials
        // Bedrock uses OpenAI-compatible API with special model IDs
        return new ChatOpenAI({
          model: this.config.model,
          apiKey: this.config.authToken,
          configuration: {
            baseURL: this.config.baseUrl !== 'bedrock' ? this.config.baseUrl : undefined,
            // Add client tracking header to all Bedrock requests
            fetch: async (input: string | URL | Request, init?: RequestInit) => {
              const updatedInit = {
                ...init,
                headers: {
                  ...init?.headers,
                  'X-CodeMie-Client': 'codemie-code'
                }
              };
              return fetch(input, updatedInit);
            }
          },
          ...commonConfig
        });

      case 'litellm': {
        // LiteLLM proxy - use OpenAI format as it's most compatible
        // For SSO, we need to inject cookies into requests
        // NOTE: ChatOpenAI appends '/chat/completions' directly, not '/v1/chat/completions'
        // So if baseUrl ends with '/v1', use it as is, otherwise append '/v1'
        let baseURL = this.config.baseUrl;
        if (!baseURL.endsWith('/v1')) {
          baseURL = `${baseURL}/v1`;
        }

        const ssoConfig: any = {
          baseURL
        };

        // Check if we have SSO cookies to inject (following codemie-ide-plugin pattern)
        const ssoCookies = (global as any).codemieSSOCookies;
        if (this.config.debug) {
          logger.debug(`SSO Cookies available:`, sanitizeCookies(ssoCookies));
          logger.debug(`Auth token:`, sanitizeAuthToken(this.config.authToken));
        }

        if (ssoCookies && this.config.authToken === 'sso-authenticated') {
          // Create custom fetch function that includes SSO cookies (matches oauth2Proxy.js line 134)
          ssoConfig.fetch = async (input: string | URL | Request, init?: RequestInit) => {
            const cookieString = Object.entries(ssoCookies)
              .map(([key, value]) => `${key}=${value}`)
              .join('; '); // Note: using '; ' separator (semicolon + space) for HTTP standard

            const updatedInit = {
              ...init,
              headers: {
                ...init?.headers,
                'cookie': cookieString, // lowercase 'cookie' header like IDE plugin
                'X-CodeMie-Client': 'codemie-code' // Track client type for request metrics
              }
            };

            // Handle SSL verification consistently with CodeMie Proxy (rejectUnauthorized: false)
            // CodeMie Proxy and SSO HTTP Client allow self-signed certificates for enterprise environments
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

            // Suppress the NODE_TLS_REJECT_UNAUTHORIZED warning since this is expected behavior
            // that matches how codemie-claude works through CodeMie Proxy
            process.removeAllListeners('warning');

            if (this.config.debug) {
              logger.debug('Disabled SSL verification (like CodeMie Proxy and SSO HTTP Client)');
            }

            if (this.config.debug) {
              logger.debug(`SSO request to ${input}`);
              logger.debug(`Cookie string length: ${cookieString.length} characters`);
            }

            try {
              const response = await fetch(input, updatedInit);

              if (this.config.debug && !response.ok) {
                logger.debug(`SSO request failed: ${response.status} ${response.statusText}`);
              }

              return response;
            } catch (error) {
              if (this.config.debug) {
                logger.debug(`SSO request error:`, error);
              }
              throw error;
            }
          };
        } else {
          // Even without SSO cookies, we still want to add the client tracking header
          // Explicitly add Authorization header for non-SSO LiteLLM
          ssoConfig.fetch = async (input: string | URL | Request, init?: RequestInit) => {
            const updatedInit = {
              ...init,
              headers: {
                ...init?.headers,
                'Authorization': `Bearer ${this.config.authToken}`,
                'X-CodeMie-Client': 'codemie-code' // Track client type for request metrics
              }
            };

            if (this.config.debug) {
              logger.debug(`Non-SSO LiteLLM request to ${input}`);
              logger.debug(`Authorization header set with API key`);
            }

            return fetch(input, updatedInit);
          };

          if (this.config.debug) {
            logger.debug(`LiteLLM provider configured with API key authentication`);
          }
        }

        return new ChatOpenAI({
          model: this.config.model,
          apiKey: this.config.authToken,
          configuration: ssoConfig,
          ...commonConfig
        });
      }

      default:
        throw new CodeMieAgentError(
          `Unsupported provider: ${this.config.provider}`,
          'INVALID_PROVIDER',
          { provider: this.config.provider }
        );
    }
  }

  /**
   * Create a HumanMessage with optional image support (multiple images)
   */
  private createHumanMessage(text: string, images: ClipboardImage[] = []): HumanMessage {
    if (images.length === 0) {
      // Text-only message
      return new HumanMessage(text);
    }

    // Multimodal message with images
    const content: any[] = [
      {
        type: "text",
        text: text
      }
    ];

    // Add all images to the content
    for (const image of images) {
      content.push({
        type: "image_url",
        image_url: `data:${image.mimeType};base64,${image.data}`
      });
    }

    return new HumanMessage({
      content: content
    });
  }

  /**
   * Stream a chat interaction with the agent
   */
  async chatStream(message: string, onEvent: EventCallback, images: ClipboardImage[] = []): Promise<void> {
    const startTime = Date.now();
    let currentToolCall: string | null = null;
    let currentStep: ExecutionStep | null = null;
    let streamAborted = false;

    // Reset execution steps for new conversation
    this.currentExecutionSteps = [];
    this.currentStepNumber = 0;
    this.isFirstLLMCall = true;

    // Set up global tool event callback for progress reporting
    setGlobalToolEventCallback((event) => {
      onEvent({
        type: 'tool_call_progress',
        toolName: event.toolName,
        toolProgress: event.progress
      });
    });

    // Create an AbortController for proper stream cancellation
    const abortController = new AbortController();

    // Set up Ctrl+C handler for graceful stream termination
    const originalSigintHandler = process.listeners('SIGINT');
    const sigintHandler = () => {
      if (this.config.debug) {
        logger.debug('\nReceived SIGINT - aborting stream...');
      }
      streamAborted = true;
      abortController.abort();
      onEvent({ type: 'error', error: 'Stream interrupted by user (Ctrl+C)' });
    };

    process.once('SIGINT', sigintHandler);

    try {
      if (this.config.debug) {
        logger.debug(`Processing message: ${message.substring(0, 100)}...`);
      }

      // Add user message to conversation history (with optional images)
      const userMessage = this.createHumanMessage(message, images);
      this.conversationHistory.push(userMessage);

      // Notify start of thinking
      onEvent({ type: 'thinking_start' });

      // Start the first LLM call step
      currentStep = this.startLLMStep();

      // Create the stream with conversation history
      const stream = await this.agent.stream(
        { messages: this.conversationHistory },
        {
          streamMode: 'updates',
          recursionLimit: 50,
          signal: abortController.signal // Add abort signal for stream cancellation
        }
      );

      let hasContent = false;

      // Process stream chunks with interruption handling
      for await (const chunk of stream) {
        // Check if stream was aborted
        if (streamAborted || abortController.signal.aborted) {
          if (this.config.debug) {
            logger.debug('Stream processing aborted');
          }
          break;
        }
        // Try to extract token usage from stream chunk
        const tokenUsage = extractTokenUsageFromStreamChunk(
          chunk,
          this.config.model,
          this.config.provider
        );

        if (tokenUsage && currentStep && currentStep.type === 'llm_call') {
          // Update current step with token usage
          currentStep.tokenUsage = tokenUsage;
          this.updateStatsWithTokenUsage(tokenUsage);

          // Store token usage to associate with next tool call
          this.currentLLMTokenUsage = tokenUsage;

          if (this.config.debug) {
            logger.debug(`Token usage: ${tokenUsage.inputTokens} in, ${tokenUsage.outputTokens} out`);
          }
        }

        this.processStreamChunk(chunk, onEvent, (toolStarted) => {
          if (toolStarted) {
            // Complete current LLM step if it exists
            if (currentStep && currentStep.type === 'llm_call') {
              this.completeStep(currentStep);
              currentStep = null;
            }

            // Start tool execution step
            currentStep = this.startToolStep(toolStarted);
            currentToolCall = toolStarted;
            this.stats.toolCalls++;
          } else if (currentToolCall && currentStep) {
            // Complete tool step
            currentStep.toolSuccess = true;
            this.completeStep(currentStep);
            currentStep = null;

            this.stats.successfulTools++;
            currentToolCall = null;

            // Start new LLM step for next reasoning cycle (processing tool result)
            currentStep = this.startLLMStep();
          }
        });

        // Check if we have content
        if (chunk.agent?.messages) {
          const lastMessage = chunk.agent.messages.at(-1);
          if (lastMessage?.content && !hasContent) {
            hasContent = true;
          }
        }
      }

      // Complete any remaining step
      if (currentStep) {
        this.completeStep(currentStep);
      }

      // Update conversation history with final messages and try to extract any missed token usage
      try {
        const finalState = await this.agent.getState();
        if (finalState?.messages) {
          this.conversationHistory = finalState.messages;

          // Try to extract token usage from final state if we missed it during streaming
          const finalTokenUsage = extractTokenUsageFromFinalState(
            finalState,
            this.config.model,
            this.config.provider
          );

          if (finalTokenUsage && this.currentExecutionSteps.length > 0) {
            // Find the last LLM step that doesn't have token usage
            for (let i = this.currentExecutionSteps.length - 1; i >= 0; i--) {
              const step = this.currentExecutionSteps[i];
              if (step.type === 'llm_call' && !step.tokenUsage) {
                step.tokenUsage = finalTokenUsage;
                this.updateStatsWithTokenUsage(finalTokenUsage);
                break;
              }
            }
          }
        }
      } catch {
        // If getState fails, continue without updating history
        if (this.config.debug) {
          logger.debug('Could not get final state, continuing...');
        }
      }

      // Finalize execution statistics
      this.stats.executionTime = Date.now() - startTime;
      this.stats.executionSteps = [...this.currentExecutionSteps];

      // Notify thinking end and completion
      onEvent({ type: 'thinking_end' });
      onEvent({ type: 'complete' });

      if (this.config.debug) {
        logger.debug(`Agent completed in ${this.stats.executionTime}ms`);
        logger.debug(`Total tokens: ${this.stats.totalTokens} (${this.stats.inputTokens} in, ${this.stats.outputTokens} out)`);
        logger.debug(`Estimated cost: $${this.stats.estimatedTotalCost.toFixed(4)}`);
      }

    } catch (error) {
      this.stats.executionTime = Date.now() - startTime;

      if (currentToolCall) {
        this.stats.failedTools++;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle AbortError from user interruption gracefully
      if (error instanceof Error && (error.name === 'AbortError' || streamAborted)) {
        if (this.config.debug) {
          logger.debug('Stream aborted by user');
        }

        onEvent({
          type: 'error',
          error: 'Operation interrupted by user'
        });

        return; // Don't throw error for user interruptions
      }

      if (this.config.debug) {
        logger.debug(`Agent error:`, error);
        // Log configuration details for debugging
        logger.debug(`Provider: ${this.config.provider}`);
        logger.debug(`Base URL: ${this.config.baseUrl}`);
        logger.debug(`Model: ${this.config.model}`);
      }

      onEvent({
        type: 'error',
        error: errorMessage
      });

      throw new CodeMieAgentError(
        `Agent execution failed: ${errorMessage}`,
        'EXECUTION_ERROR',
        { originalError: error, stats: this.stats }
      );
    } finally {
      // Clean up global tool event callback
      setGlobalToolEventCallback(null);

      // Always clean up signal handler
      process.removeListener('SIGINT', sigintHandler);

      // Restore original handlers if they existed
      if (originalSigintHandler.length > 0) {
        originalSigintHandler.forEach(handler => {
          process.on('SIGINT', handler as NodeJS.SignalsListener);
        });
      }
    }
  }

  /**
   * Process individual stream chunks from LangGraph
   */
  private processStreamChunk(
    chunk: any,
    onEvent: EventCallback,
    onToolEvent?: (toolStarted?: string) => void
  ): void {
    try {
      // Handle agent node updates (LLM responses)
      if (chunk.agent?.messages) {
        const messages = chunk.agent.messages;
        const lastMessage = messages[messages.length - 1];

        // Stream content chunks
        if (lastMessage?.content && typeof lastMessage.content === 'string') {
          onEvent({
            type: 'content_chunk',
            content: lastMessage.content
          });
        }

        // Handle tool calls
        if (lastMessage?.tool_calls && lastMessage.tool_calls.length > 0) {
          for (const toolCall of lastMessage.tool_calls) {
            // Store tool args for later use in result processing
            // Use tool name as key since LangGraph may not preserve IDs consistently
            this.toolCallArgs.set(toolCall.name, toolCall.args);

            onEvent({
              type: 'tool_call_start',
              toolName: toolCall.name,
              toolArgs: toolCall.args
            });


            if (onToolEvent) {
              onToolEvent(toolCall.name);
            }
          }
        }
      }

      // Handle tool node updates (tool execution results)
      if (chunk.tools?.messages) {
        const messages = chunk.tools.messages;

        for (const toolMessage of messages) {
          const toolName = toolMessage.name || 'unknown';
          const result = toolMessage.content || '';

          // Get the stored tool args for this tool name
          const toolArgs = this.toolCallArgs.get(toolName);
          if (toolArgs) {
            this.toolCallArgs.delete(toolName); // Clean up after use
          }

          // Extract enhanced metadata from the tool result
          let toolMetadata = extractToolMetadata(toolName, result, toolArgs);

          // Associate token usage from the LLM call that triggered this tool
          if (toolMetadata && this.currentLLMTokenUsage) {
            toolMetadata = {
              ...toolMetadata,
              tokenUsage: this.currentLLMTokenUsage
            };
            // Clear the stored token usage after associating it
            this.currentLLMTokenUsage = null;
          }

          onEvent({
            type: 'tool_call_result',
            toolName,
            result,
            toolMetadata
          });

          if (onToolEvent) {
            onToolEvent(); // Signal tool completion
          }
        }
      }

    } catch (error) {
      if (this.config.debug) {
        logger.debug(`Error processing stream chunk:`, error);
      }

      // Don't throw here, just log - let the main stream continue
      onEvent({
        type: 'error',
        error: `Stream processing error: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * Execute a single message without streaming (for non-interactive use)
   */
  async executeMessage(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let response = '';
      let hasError = false;

      this.chatStream(message, (event) => {
        switch (event.type) {
          case 'content_chunk':
            response += event.content || '';
            break;

          case 'complete':
            if (!hasError) {
              resolve(response.trim());
            }
            break;

          case 'error':
            hasError = true;
            reject(new Error(event.error));
            break;
        }
      }).catch(reject);
    });
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
    this.toolCallArgs.clear(); // Clear stored tool args
    this.currentExecutionSteps = [];
    this.currentStepNumber = 0;
    this.currentLLMTokenUsage = null;
    this.isFirstLLMCall = true;

    // Reset stats
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      estimatedTotalCost: 0,
      executionTime: 0,
      toolCalls: 0,
      successfulTools: 0,
      failedTools: 0,
      llmCalls: 0,
      executionSteps: []
    };

    if (this.config.debug) {
      logger.debug('Conversation history cleared');
    }
  }

  /**
   * Get current conversation history
   */
  getHistory(): BaseMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Get agent runtime statistics
   */
  getStats(): AgentStats {
    return { ...this.stats };
  }

  /**
   * Get available tools
   */
  getTools(): StructuredTool[] {
    return [...this.tools];
  }

  /**
   * Get agent configuration
   */
  getConfig(): CodeMieConfig {
    // Return sanitized config (without sensitive data)
    return {
      ...this.config,
      authToken: `${this.config.authToken.substring(0, 8)}***`
    };
  }

  /**
   * Health check for the agent
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    provider: string;
    model: string;
    toolCount: number;
    error?: string;
  }> {
    try {
      // Simple test message
      await this.executeMessage('Hello, can you confirm you are working?');

      return {
        status: 'healthy',
        provider: this.config.provider,
        model: this.config.model,
        toolCount: this.tools.length
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: this.config.provider,
        model: this.config.model,
        toolCount: this.tools.length,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Start a new LLM call step
   */
  private startLLMStep(): ExecutionStep {
    // Determine the context based on whether this is the first call and if we just had a tool execution
    let llmContext: 'initial_input' | 'processing_tool_result' | 'final_response';

    if (this.isFirstLLMCall) {
      llmContext = 'initial_input';
      this.isFirstLLMCall = false;
    } else {
      // Check if the previous step was a tool execution
      const prevStep = this.currentExecutionSteps[this.currentExecutionSteps.length - 1];
      llmContext = (prevStep?.type === 'tool_execution') ? 'processing_tool_result' : 'final_response';
    }

    const step: ExecutionStep = {
      stepNumber: ++this.currentStepNumber,
      type: 'llm_call',
      startTime: Date.now(),
      llmContext
    };

    this.currentExecutionSteps.push(step);
    this.stats.llmCalls++;

    if (this.config.debug) {
      logger.debug(`Started LLM step ${step.stepNumber} (${llmContext})`);
    }

    return step;
  }

  /**
   * Start a new tool execution step
   */
  private startToolStep(toolName: string): ExecutionStep {
    const step: ExecutionStep = {
      stepNumber: ++this.currentStepNumber,
      type: 'tool_execution',
      startTime: Date.now(),
      toolName
    };

    this.currentExecutionSteps.push(step);

    if (this.config.debug) {
      // Get the stored tool args for enhanced logging
      const toolArgs = this.toolCallArgs.get(toolName);
      if (toolArgs && Object.keys(toolArgs).length > 0) {
        logger.debug(`Started tool step ${step.stepNumber}: ${toolName} ${JSON.stringify(toolArgs)}`);
      } else {
        logger.debug(`Started tool step ${step.stepNumber}: ${toolName}`);
      }
    }

    return step;
  }

  /**
   * Complete an execution step
   */
  private completeStep(step: ExecutionStep): void {
    step.endTime = Date.now();
    step.duration = step.endTime - step.startTime;

    if (this.config.debug) {
      const type = step.type === 'llm_call' ? 'LLM' : `Tool (${step.toolName})`;
      logger.debug(`Completed ${type} step ${step.stepNumber} in ${step.duration}ms`);
    }
  }

  /**
   * Update aggregate statistics with token usage
   */
  private updateStatsWithTokenUsage(tokenUsage: TokenUsage): void {
    this.stats.inputTokens += tokenUsage.inputTokens;
    this.stats.outputTokens += tokenUsage.outputTokens;

    if (tokenUsage.cachedTokens) {
      this.stats.cachedTokens += tokenUsage.cachedTokens;
    }

    this.stats.totalTokens = this.stats.inputTokens + this.stats.outputTokens;

    if (tokenUsage.estimatedCost) {
      this.stats.estimatedTotalCost += tokenUsage.estimatedCost;
    }
  }
}