/**
 * Analytics system for CodeMie CLI
 * Provides unified analytics tracking across all agents
 */

import type {
  AnalyticsConfig,
  AnalyticsEvent,
  EventType,
  SessionConfig,
  ToolMetrics,
} from './types.js';
import { EventCollector } from './collector.js';
import { AnalyticsWriter } from './writer.js';
import { SessionManager } from './session.js';
import { redactSensitive } from './privacy.js';
import { loadAnalyticsConfig } from './config.js';
import { getInstallationId } from '../utils/installation-id.js';
import {
  parseAnthropicToolResult,
  parseOpenAIToolResult,
  parseGeminiToolResult,
  createEmptyCodeMetrics,
  createEmptyCommandMetrics,
  mergeCodeMetrics,
  mergeCommandMetrics,
  type ToolResultMetrics,
} from './tool-parser.js';
import { AnalyticsPlugin } from './plugins/types.js';

/**
 * Main analytics class
 * Handles event tracking, buffering, and persistence
 */
export class Analytics {
  private collector: EventCollector | null = null;
  private writer: AnalyticsWriter | null = null;
  private session: SessionManager;
  private config: AnalyticsConfig;
  private installationId: string | null = null;

  // Plugin system for extensibility
  private plugins: AnalyticsPlugin[] = [];

  // Session metrics aggregation
  private sessionMetrics = {
    toolCallCount: 0,
    toolSuccessCount: 0,
    toolFailureCount: 0,
    totalLatencyMs: 0,
    apiRequestCount: 0,
    toolCallsByName: {} as Record<string, number>,
    toolMetricsByName: {} as Record<string, ToolMetrics>,
    code: createEmptyCodeMetrics(),
    commands: createEmptyCommandMetrics(),
  };

  // Track tool call IDs to match calls with results
  private toolCallTracker = new Map<string, {
    toolName: string;
    startTime: number;
  }>();

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = loadAnalyticsConfig(config);
    this.session = new SessionManager();

    // Only initialize if enabled
    if (this.config.enabled) {
      this.initialize();
    }
  }

  /**
   * Register an analytics plugin (Open/Closed principle)
   * Allows adding custom metrics without modifying core
   */
  registerPlugin(plugin: AnalyticsPlugin): void {
    this.plugins.push(plugin);

    // Initialize plugin if it has init method
    if (plugin.initialize) {
      plugin.initialize(this).catch(error => {
        console.error(`Plugin "${plugin.name}" initialization failed:`, error);
      });
    }
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): AnalyticsPlugin[] {
    return [...this.plugins];
  }

  /**
   * Get current metrics from all plugins
   * Useful for displaying aggregated stats
   */
  getPluginMetrics(): Record<string, Record<string, unknown>> {
    const allMetrics: Record<string, Record<string, unknown>> = {};

    for (const plugin of this.plugins) {
      if (plugin.getMetrics) {
        try {
          allMetrics[plugin.name] = plugin.getMetrics();
        } catch (error) {
          console.error(`Error getting metrics from plugin "${plugin.name}":`, error);
          allMetrics[plugin.name] = { error: 'Failed to get metrics' };
        }
      }
    }

    return allMetrics;
  }

  /**
   * Get metrics from a specific plugin by name
   */
  getPluginMetricsByName(pluginName: string): Record<string, unknown> | null {
    const plugin = this.plugins.find(p => p.name === pluginName);

    if (!plugin || !plugin.getMetrics) {
      return null;
    }

    try {
      return plugin.getMetrics();
    } catch (error) {
      console.error(`Error getting metrics from plugin "${pluginName}":`, error);
      return null;
    }
  }

  /**
   * Initialize analytics components
   */
  private initialize(): void {
    this.collector = new EventCollector({
      maxBufferSize: this.config.maxBufferSize,
      flushInterval: this.config.flushInterval,
    });

    // Setup writer for local target
    if (this.config.target === 'local' || this.config.target === 'both') {
      this.writer = new AnalyticsWriter(this.config.localPath);
    }

    // Register flush callback
    this.collector.onFlush(async (events) => {
      if (this.writer) {
        await this.writer.write(events);
      }
    });
  }

  /**
   * Track an analytics event
   */
  async track(
    eventType: EventType,
    attributes: Record<string, unknown> = {},
    metrics?: Record<string, number>
  ): Promise<void> {
    if (!this.config.enabled || !this.collector || !this.session.isActive) {
      return;
    }

    try {
      // Lazy load installation ID
      if (!this.installationId) {
        this.installationId = await getInstallationId();
      }

      let event: AnalyticsEvent = {
        timestamp: new Date().toISOString(),
        eventType,
        sessionId: this.session.id,
        installationId: this.installationId,
        agent: this.session.agent,
        agentVersion: this.session.agentVersion,
        cliVersion: this.session.cliVersion,
        profile: this.session.profile,
        provider: this.session.provider,
        model: this.session.model,
        attributes,
        metrics: metrics || {},
      };

      // Process through plugins
      for (const plugin of this.plugins) {
        try {
          // 1. Allow plugins to transform event
          if (plugin.processEvent) {
            const processed = await plugin.processEvent(event);
            if (!processed) {
              // Plugin filtered out event
              return;
            }
            event = processed;
          }

          // 2. Enrich with plugin metrics
          if (plugin.enrichMetrics) {
            const pluginMetrics = await plugin.enrichMetrics(event);
            // Merge plugin metrics (cast to Record<string, number> for compatibility)
            event.metrics = { ...event.metrics, ...pluginMetrics as Record<string, number> };
          }
        } catch (pluginError) {
          // Plugin errors should not break analytics
          console.error(`Plugin "${plugin.name}" error:`, pluginError);
        }
      }

      // Aggregate session metrics
      this.aggregateMetrics(eventType, attributes, event.metrics);

      this.collector.add(event);
    } catch (error) {
      // Silently fail - don't block agent execution
      console.error('Analytics tracking error:', error);
    }
  }

  /**
   * Update tool-specific metrics from tool result
   */
  private updateToolMetrics(
    toolName: string,
    toolMetrics: ToolResultMetrics,
    latencyMs?: number
  ): void {
    // Initialize tool metrics if not exists
    if (!this.sessionMetrics.toolMetricsByName[toolName]) {
      this.sessionMetrics.toolMetricsByName[toolName] = {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        failureRate: 0,
        totalLatencyMs: 0,
        averageLatencyMs: 0,
      };
    }

    const metrics = this.sessionMetrics.toolMetricsByName[toolName];
    metrics.totalCalls++;

    if (toolMetrics.success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }

    metrics.failureRate = metrics.totalCalls > 0
      ? metrics.failureCount / metrics.totalCalls
      : 0;

    if (latencyMs) {
      metrics.totalLatencyMs += latencyMs;
      metrics.averageLatencyMs = metrics.totalLatencyMs / metrics.totalCalls;
    }

    // Merge code metrics
    mergeCodeMetrics(this.sessionMetrics.code, toolMetrics);

    // Merge command metrics
    mergeCommandMetrics(this.sessionMetrics.commands, toolMetrics);
  }

  /**
   * Aggregate metrics for session-level reporting
   */
  private aggregateMetrics(
    eventType: EventType,
    attributes: Record<string, unknown>,
    metrics?: Record<string, number>
  ): void {
    // Track tool calls
    if (eventType === 'tool_call') {
      this.sessionMetrics.toolCallCount++;

      // Track by tool name for breakdown
      const toolName = attributes.toolName as string;
      if (toolName) {
        this.sessionMetrics.toolCallsByName[toolName] =
          (this.sessionMetrics.toolCallsByName[toolName] || 0) + 1;
      }
    }

    // Track tool results
    if (eventType === 'tool_result') {
      const success = attributes.success as boolean;
      if (success) {
        this.sessionMetrics.toolSuccessCount++;
      } else {
        this.sessionMetrics.toolFailureCount++;
      }
    }

    // Track tool errors (explicit error tracking)
    if (eventType === 'tool_error') {
      this.sessionMetrics.toolFailureCount++;

      const toolName = attributes.toolName as string;
      if (toolName) {
        this.sessionMetrics.toolCallsByName[toolName] =
          (this.sessionMetrics.toolCallsByName[toolName] || 0) + 1;
      }
    }

    // Track API metrics
    if (eventType === 'api_request') {
      this.sessionMetrics.apiRequestCount++;
    }

    if (eventType === 'api_response' && metrics?.latencyMs) {
      this.sessionMetrics.totalLatencyMs += metrics.latencyMs;
    }
  }


  /**
   * Track tool call
   */
  async trackToolCall(
    toolName: string,
    params: Record<string, unknown>,
    latency?: number
  ): Promise<void> {
    const attributes = {
      toolName,
      ...redactSensitive(params),
    };

    const metrics = latency ? { latencyMs: latency } : undefined;

    await this.track('tool_call', attributes, metrics);
  }

  /**
   * Track agent response
   */
  async trackAgentResponse(
    response: string,
    attributes: Record<string, unknown> = {}
  ): Promise<void> {
    const eventAttrs: Record<string, unknown> = {
      ...attributes,
      responseLength: response.length,
    };

    await this.track('agent_response', eventAttrs);
  }

  /**
   * Track API response with unified tool call extraction
   * Extracts tool calls and results from API request/response bodies
   * Supports multiple API formats: Anthropic, OpenAI, Google Gemini
   */
  async trackAPIResponse(data: {
    latency?: number;
    statusCode?: number;
    responseBody?: unknown;
    requestBody?: unknown;
  }): Promise<void> {
    const attributes: Record<string, unknown> = {};

    if (data.statusCode) {
      attributes.statusCode = data.statusCode;
    }

    // Extract tool calls from API response (multiple formats)
    if (data.responseBody && typeof data.responseBody === 'object') {
      await this.extractToolCallsFromResponse(data.responseBody);
    }

    // Extract tool results from API request (multiple formats)
    if (data.requestBody && typeof data.requestBody === 'object') {
      await this.extractToolResultsFromRequest(data.requestBody);
    }

    const metrics: Record<string, number> = {};
    if (data.latency) metrics.latencyMs = data.latency;

    await this.track('api_response', attributes, metrics);
  }

  /**
   * Extract tool calls from API response body
   * Supports: Anthropic, OpenAI, Google Gemini formats
   */
  private async extractToolCallsFromResponse(responseBody: unknown): Promise<void> {
    if (!responseBody || typeof responseBody !== 'object') {
      return;
    }

    // Anthropic format: {content: [{type: "tool_use", name: "...", id: "..."}]}
    const anthropicBody = responseBody as {
      content?: Array<{
        type?: string;
        name?: string;
        id?: string;
        input?: unknown;
      }>;
    };

    if (Array.isArray(anthropicBody.content)) {
      for (const item of anthropicBody.content) {
        if (item.type === 'tool_use' && item.name) {
          // Track tool call for matching with result later
          if (item.id) {
            this.toolCallTracker.set(item.id, {
              toolName: item.name,
              startTime: Date.now(),
            });
          }

          await this.track('tool_call', {
            toolName: item.name,
            toolUseId: item.id,
            source: 'api_response',
            format: 'anthropic',
            hasInput: !!item.input
          });
        }
      }
      return; // Found Anthropic format, stop processing
    }

    // OpenAI format: {choices: [{message: {tool_calls: [{id, function: {name, arguments}}]}}]}
    const openaiBody = responseBody as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
    };

    if (Array.isArray(openaiBody.choices)) {
      for (const choice of openaiBody.choices) {
        const toolCalls = choice.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            if (toolCall.type === 'function' && toolCall.function?.name) {
              // Track tool call for matching with result later
              if (toolCall.id) {
                this.toolCallTracker.set(toolCall.id, {
                  toolName: toolCall.function.name,
                  startTime: Date.now(),
                });
              }

              await this.track('tool_call', {
                toolName: toolCall.function.name,
                toolUseId: toolCall.id,
                source: 'api_response',
                format: 'openai',
                hasArguments: !!toolCall.function.arguments
              });
            }
          }
          return; // Found OpenAI format, stop processing
        }
      }
    }

    // Google Gemini format: {candidates: [{content: {parts: [{functionCall: {name, args}}]}}]}
    const geminiBody = responseBody as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            functionCall?: {
              name?: string;
              args?: unknown;
            };
          }>;
        };
      }>;
    };

    if (Array.isArray(geminiBody.candidates)) {
      for (const candidate of geminiBody.candidates) {
        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.functionCall?.name) {
              await this.track('tool_call', {
                toolName: part.functionCall.name,
                source: 'api_response',
                format: 'gemini',
                hasArgs: !!part.functionCall.args
              });
            }
          }
          return; // Found Gemini format, stop processing
        }
      }
    }
  }

  /**
   * Extract tool results from API request body
   * Supports: Anthropic, OpenAI, Google Gemini formats
   */
  private async extractToolResultsFromRequest(requestBody: unknown): Promise<void> {
    if (!requestBody || typeof requestBody !== 'object') {
      return;
    }

    // Anthropic format: {content: [{type: "tool_result", tool_use_id: "...", is_error: false, content: "..."}]}
    const anthropicBody = requestBody as {
      content?: Array<{
        type?: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    };

    if (Array.isArray(anthropicBody.content)) {
      for (const item of anthropicBody.content) {
        if (item.type === 'tool_result') {
          const resultContent = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          const resultLength = resultContent ? resultContent.length : 0;

          // Get tool name from tracker
          const toolInfo = item.tool_use_id ? this.toolCallTracker.get(item.tool_use_id) : null;
          const toolName = toolInfo?.toolName || 'unknown';
          const latencyMs = toolInfo ? Date.now() - toolInfo.startTime : undefined;

          // Parse tool result for detailed metrics
          const toolMetrics = parseAnthropicToolResult(
            toolName,
            item.content,
            item.is_error || false
          );

          // Update session metrics
          this.updateToolMetrics(toolName, toolMetrics, latencyMs);

          // Destructure to avoid duplicate 'success' field
          const { success: toolSuccess, errorMessage, ...otherMetrics } = toolMetrics;

          await this.track('tool_result', {
            toolUseId: item.tool_use_id,
            toolName,
            success: toolSuccess,
            isError: item.is_error || false,
            source: 'api_request',
            format: 'anthropic',
            resultLength,
            errorMessage,
            ...otherMetrics,
          }, latencyMs ? { latencyMs } : undefined);

          if (item.is_error) {
            await this.track('tool_error', {
              toolUseId: item.tool_use_id,
              toolName,
              success: false,
              error: resultContent.substring(0, 500),
              source: 'api_request',
              format: 'anthropic'
            });
          }

          // Clean up tracker
          if (item.tool_use_id) {
            this.toolCallTracker.delete(item.tool_use_id);
          }
        }
      }
      return; // Found Anthropic format, stop processing
    }

    // OpenAI format: {messages: [{role: "tool", tool_call_id: "...", content: "..."}]}
    const openaiBody = requestBody as {
      messages?: Array<{
        role?: string;
        tool_call_id?: string;
        content?: string;
      }>;
    };

    if (Array.isArray(openaiBody.messages)) {
      for (const message of openaiBody.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          const resultLength = message.content?.length || 0;

          // Get tool name from tracker
          const toolInfo = this.toolCallTracker.get(message.tool_call_id);
          const toolName = toolInfo?.toolName || 'unknown';
          const latencyMs = toolInfo ? Date.now() - toolInfo.startTime : undefined;

          // Parse tool result for detailed metrics
          const toolMetrics = parseOpenAIToolResult(toolName, message.content || '');

          // Update session metrics
          this.updateToolMetrics(toolName, toolMetrics, latencyMs);

          // Destructure to avoid duplicate 'success' field
          const { success: toolSuccess, errorMessage, ...otherMetrics } = toolMetrics;

          await this.track('tool_result', {
            toolUseId: message.tool_call_id,
            toolName,
            success: toolSuccess,
            isError: !toolSuccess,
            source: 'api_request',
            format: 'openai',
            resultLength,
            errorMessage,
            ...otherMetrics,
          }, latencyMs ? { latencyMs } : undefined);

          if (!toolMetrics.success) {
            await this.track('tool_error', {
              toolUseId: message.tool_call_id,
              toolName,
              success: false,
              error: message.content?.substring(0, 500) || 'Unknown error',
              source: 'api_request',
              format: 'openai'
            });
          }

          // Clean up tracker
          this.toolCallTracker.delete(message.tool_call_id);
        }
      }
      return; // Found OpenAI format, stop processing
    }

    // Google Gemini format: {contents: [{parts: [{functionResponse: {name, response}}]}]}
    const geminiBody = requestBody as {
      contents?: Array<{
        parts?: Array<{
          functionResponse?: {
            name?: string;
            response?: unknown;
          };
        }>;
      }>;
    };

    if (Array.isArray(geminiBody.contents)) {
      for (const content of geminiBody.contents) {
        const parts = content.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.functionResponse?.name) {
              const toolName = part.functionResponse.name;
              const responseStr = JSON.stringify(part.functionResponse.response);
              const resultLength = responseStr.length;

              // Parse tool result for detailed metrics
              const toolMetrics = parseGeminiToolResult(toolName, part.functionResponse.response);

              // Note: Gemini doesn't provide tool_call_id, so we can't track latency
              this.updateToolMetrics(toolName, toolMetrics, undefined);

              // Destructure to avoid duplicate 'success' field
              const { success: toolSuccess, errorMessage, ...otherMetrics } = toolMetrics;

              await this.track('tool_result', {
                toolName,
                success: toolSuccess,
                isError: !toolSuccess,
                source: 'api_request',
                format: 'gemini',
                resultLength,
                errorMessage,
                ...otherMetrics,
              });

              if (!toolMetrics.success) {
                await this.track('tool_error', {
                  toolName,
                  success: false,
                  error: responseStr.substring(0, 500),
                  source: 'api_request',
                  format: 'gemini'
                });
              }
            }
          }
          return; // Found Gemini format, stop processing
        }
      }
    }
  }

  /**
   * Start analytics session
   */
  startSession(config: SessionConfig): void {
    this.session.start(config);
    this.resetMetrics(); // Reset metrics for new session

    void this.track('session_start', {
      workingDir: config.workingDir,
      interactive: config.interactive,
    });
  }

  /**
   * End analytics session
   */
  async endSession(
    exitReason: string,
    metrics?: Record<string, number>
  ): Promise<void> {
    if (!this.session.isActive) {
      return;
    }

    // Calculate per-tool failure rates
    const toolMetricsByName: Record<string, any> = {};
    for (const [toolName, toolMetrics] of Object.entries(this.sessionMetrics.toolMetricsByName)) {
      toolMetricsByName[toolName] = {
        totalCalls: toolMetrics.totalCalls,
        successCount: toolMetrics.successCount,
        failureCount: toolMetrics.failureCount,
        failureRate: toolMetrics.failureRate,
        averageLatencyMs: toolMetrics.averageLatencyMs,
      };
    }

    // Combine session metrics with provided metrics
    const sessionMetrics = {
      durationSeconds: this.session.duration,
      toolCallCount: this.sessionMetrics.toolCallCount,
      toolSuccessCount: this.sessionMetrics.toolSuccessCount,
      toolFailureCount: this.sessionMetrics.toolFailureCount,
      toolSuccessRate: this.sessionMetrics.toolCallCount > 0
        ? this.sessionMetrics.toolSuccessCount / this.sessionMetrics.toolCallCount
        : 0,
      totalLatencyMs: this.sessionMetrics.totalLatencyMs,
      averageLatencyMs: this.sessionMetrics.apiRequestCount > 0
        ? this.sessionMetrics.totalLatencyMs / this.sessionMetrics.apiRequestCount
        : 0,
      apiRequestCount: this.sessionMetrics.apiRequestCount,

      // Code metrics
      linesAdded: this.sessionMetrics.code.linesAdded,
      linesRemoved: this.sessionMetrics.code.linesRemoved,
      linesModified: this.sessionMetrics.code.linesModified,
      filesCreated: this.sessionMetrics.code.filesCreated,
      filesModified: this.sessionMetrics.code.filesModified,
      filesDeleted: this.sessionMetrics.code.filesDeleted,
      filesRead: this.sessionMetrics.code.filesRead,
      totalCharactersWritten: this.sessionMetrics.code.totalCharactersWritten,
      totalBytesRead: this.sessionMetrics.code.totalBytesRead,
      totalBytesWritten: this.sessionMetrics.code.totalBytesWritten,

      // Command metrics
      totalCommands: this.sessionMetrics.commands.totalCommands,
      successfulCommands: this.sessionMetrics.commands.successfulCommands,
      failedCommands: this.sessionMetrics.commands.failedCommands,
      commandSuccessRate: this.sessionMetrics.commands.totalCommands > 0
        ? this.sessionMetrics.commands.successfulCommands / this.sessionMetrics.commands.totalCommands
        : 0,

      ...metrics,
    };

    const attributes = {
      exitReason,
      toolCallsByName: this.sessionMetrics.toolCallsByName,
      toolMetricsByName,
      commandsByType: this.sessionMetrics.commands.commandsByType,
    };

    await this.track('session_end', attributes, sessionMetrics);

    // Force flush on session end
    await this.flush();

    // Reset metrics
    this.resetMetrics();

    this.session.end();
  }

  /**
   * Reset session metrics
   */
  private resetMetrics(): void {
    this.sessionMetrics = {
      toolCallCount: 0,
      toolSuccessCount: 0,
      toolFailureCount: 0,
      totalLatencyMs: 0,
      apiRequestCount: 0,
      toolCallsByName: {},
      toolMetricsByName: {},
      code: createEmptyCodeMetrics(),
      commands: createEmptyCommandMetrics(),
    };
    this.toolCallTracker.clear();
  }

  /**
   * Flush buffered events
   */
  async flush(): Promise<void> {
    if (this.collector) {
      await this.collector.flush();
    }
  }

  /**
   * Cleanup and destroy analytics
   */
  async destroy(): Promise<void> {
    if (this.collector) {
      await this.flush();
      this.collector.destroy();
    }
  }

  /**
   * Check if analytics is enabled
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * Singleton analytics instance
 */
let analyticsInstance: Analytics | null = null;

/**
 * Initialize global analytics instance
 * Automatically registers default plugins for API tracking
 */
export function initAnalytics(
  config: Partial<AnalyticsConfig> = {},
  options: { registerDefaultPlugins?: boolean } = { registerDefaultPlugins: true }
): void {
  analyticsInstance = new Analytics(config);

  // Register default plugins if enabled
  if (options.registerDefaultPlugins && analyticsInstance.isEnabled) {
    registerDefaultPlugins(analyticsInstance);
  }
}

/**
 * Register default analytics plugins
 * Tracks API request/response patterns, success rates, and latency
 */
export function registerDefaultPlugins(analytics: Analytics): void {
  try {
    // Import plugins dynamically to avoid unnecessary loading
    import('./plugins/index.js').then(({
      APIMetricsPlugin,
      ModelMetricsPlugin,
      ProviderMetricsPlugin
    }) => {
      analytics.registerPlugin(new APIMetricsPlugin());
      analytics.registerPlugin(new ModelMetricsPlugin());
      analytics.registerPlugin(new ProviderMetricsPlugin());
    }).catch(error => {
      // Plugins are optional - don't break if they fail to load
      console.warn('Failed to load default analytics plugins:', error);
    });
  } catch (error) {
    console.warn('Failed to register default analytics plugins:', error);
  }
}

/**
 * Get global analytics instance
 * Auto-initializes if not already initialized
 */
export function getAnalytics(): Analytics {
  if (!analyticsInstance) {
    // Auto-initialize with defaults
    initAnalytics();
  }
  return analyticsInstance!; // Safe: always initialized above
}

/**
 * Destroy global analytics instance
 */
export async function destroyAnalytics(): Promise<void> {
  if (analyticsInstance) {
    await analyticsInstance.destroy();
    analyticsInstance = null;
  }
}

// Re-export types
export type {
  AnalyticsConfig,
  AnalyticsEvent,
  EventType,
  SessionConfig,
} from './types.js';
export { DEFAULT_ANALYTICS_CONFIG } from './types.js';

// Re-export plugin types for convenience
export type { AnalyticsPlugin } from './plugins/types.js';
