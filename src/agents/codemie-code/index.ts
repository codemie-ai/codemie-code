/**
 * CodeMie Native Agent - Main Entry Point
 *
 * Orchestrates the entire CodeMie native agent including initialization,
 * tool loading, and interactive/non-interactive execution modes.
 */

import { CodeMieAgent } from './agent.js';
import { loadCodeMieConfig, getConfigSummary } from './config.js';
import { createSystemTools } from './tools/index.js';
import type { CodeMieConfig, InitializationResult, AgentStats } from './types.js';
import { CodeMieAgentError } from './types.js';
import { hasClipboardImage, getClipboardImage } from '../../utils/clipboard.js';
import { logger } from '../../utils/logger.js';

export class CodeMieCode {
  private agent: CodeMieAgent | null = null;
  private config: CodeMieConfig;
  private initializationResult: InitializationResult | null = null;

  constructor(workingDir?: string) {
    // Load configuration first - this may throw if config is invalid
    this.config = {} as CodeMieConfig; // Temporary placeholder

    // Actual loading happens in initialize() to handle async operations
    this.workingDirectory = workingDir || process.cwd();
  }

  private workingDirectory: string;

  /**
   * Initialize the CodeMie agent asynchronously
   */
  async initialize(cliOverrides?: { debug?: boolean }): Promise<InitializationResult> {
    try {
      // Load configuration with CLI overrides
      this.config = await loadCodeMieConfig(this.workingDirectory, cliOverrides);

      if (this.config.debug) {
        logger.debug('Configuration loaded:', getConfigSummary(this.config));
        logger.debug('Global SSO cookies set:', !!(global as any).codemieSSOCookies);
      }

      // Create system tools
      const tools = await createSystemTools(this.config);

      if (this.config.debug) {
        logger.debug(`Created ${tools.length} system tools`);
      }

      // Initialize the agent
      this.agent = new CodeMieAgent(this.config, tools);

      this.initializationResult = {
        success: true,
        toolCount: tools.length,
        duration: 0
      };

      if (this.config.debug) {
        logger.debug('Agent initialized successfully');
      }

      return this.initializationResult!;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.initializationResult = {
        success: false,
        toolCount: 0,
        duration: 0,
        error: errorMessage
      };

      if (this.config.debug) {
        logger.debug('Initialization failed:', error);
      }

      throw new CodeMieAgentError(
        `Failed to initialize CodeMie agent: ${errorMessage}`,
        'INITIALIZATION_ERROR',
        { workingDirectory: this.workingDirectory, originalError: error }
      );
    }
  }

  /**
   * Start interactive mode with modern terminal UI
   */
  async startInteractive(): Promise<void> {
    if (!this.agent) {
      throw new CodeMieAgentError(
        'Agent not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }

    // Use modern Clack-based terminal UI
    const { CodeMieTerminalUI } = await import('./ui.js');
    const ui = new CodeMieTerminalUI(this.agent);

    try {
      await ui.startInteractive();
    } finally {
      ui.dispose();
    }
  }

  /**
   * Execute a single task (non-interactive mode)
   */
  async executeTask(task: string): Promise<string> {
    if (!this.agent) {
      throw new CodeMieAgentError(
        'Agent not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }

    try {
      if (this.config.debug) {
        logger.debug(`Executing task: ${task.substring(0, 100)}...`);
      }

      let result = '';
      await this.agent.chatStream(task, (event) => {
        if (event.type === 'content_chunk') {
          result += event.content || '';
        }
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.config.debug) {
        logger.debug('Task execution failed:', error);
      }

      throw new CodeMieAgentError(
        `Task execution failed: ${errorMessage}`,
        'TASK_EXECUTION_ERROR',
        { task, originalError: error }
      );
    }
  }

  /**
   * Execute a single task with modern UI feedback (for CLI usage)
   */
  async executeTaskWithUI(task: string, options?: { planMode?: boolean; planOnly?: boolean }): Promise<string> {
    if (!this.agent) {
      throw new CodeMieAgentError(
        'Agent not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }

    // Use modern Clack-based terminal UI for single task
    const { CodeMieTerminalUI } = await import('./ui.js');
    const ui = new CodeMieTerminalUI(this.agent);

    try {
      // Enable plan mode if requested
      if (options?.planMode || options?.planOnly) {
        ui.enablePlanMode();
      }

      // Check for clipboard image
      let clipboardImage;
      if (await hasClipboardImage()) {
        clipboardImage = await getClipboardImage() || undefined;
      }

      ui.showTaskWelcome(task);

      let result: string;
      if (options?.planMode) {
        // Use UI-connected planning execution instead of direct planning
        result = await ui.executePlanningTask(task, clipboardImage ? [clipboardImage] : [], options.planOnly);
      } else {
        result = await ui.executeSingleTask(task, clipboardImage ? [clipboardImage] : []);
      }

      // Only show task complete if not plan-only mode
      if (!options?.planOnly) {
        ui.showTaskComplete();
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ui.showError(errorMessage);
      throw error;
    } finally {
      ui.dispose();
    }
  }

  /**
   * Execute a task with structured planning mode
   */
  async executeTaskWithPlanning(task: string, _images: any[] = [], planOnly = false): Promise<string> {
    if (!this.agent) {
      throw new CodeMieAgentError(
        'Agent not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }

    try {
      const { PlanMode } = await import('./modes/planMode.js');
      const planMode = new PlanMode(this.agent, {
        requirePlanning: true,
        enforceSequential: true,
        showPlanningFeedback: true
      });

      if (planOnly) {
        // Only generate plan, don't execute
        const planningResult = await (planMode as any).planningPhase(task);

        if (!planningResult.success) {
          throw new Error(`Planning failed: ${planningResult.error}`);
        }

        return `📋 Plan generated successfully with ${planningResult.todos.length} steps:\n\n` +
               planningResult.todos.map((todo: any, i: number) =>
                 `${i + 1}. ${todo.content}`
               ).join('\n') +
               `\n\nQuality Score: ${planningResult.qualityScore}/100\n` +
               (planningResult.suggestions.length > 0 ?
                 `\nSuggestions:\n${planningResult.suggestions.map((s: string) => `• ${s}`).join('\n')}` : '') +
               `\n\n🎯 **Plan-only mode**: Plan created. Use --plan flag (without --plan-only) to execute this plan.`;
      }

      // Full planning + execution
      return await planMode.executePlannedTask(task, (event) => {
        // Handle todo updates and planning events
        // Note: planning_start and other UI events are handled by the UI system
        if (event.type === 'planning_complete') {
          console.log(`📋 Plan created with ${event.planningInfo?.totalSteps || 0} steps`);
        } else if (event.type === 'todo_update') {
          // Todo updates are handled by the UI system
        }
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.config.debug) {
        logger.debug('Plan mode execution failed:', error);
      }

      throw new CodeMieAgentError(
        `Plan mode execution failed: ${errorMessage}`,
        'PLAN_MODE_ERROR',
        { task, originalError: error }
      );
    }
  }

  /**
   * Stream a task with event callbacks (for programmatic use)
   */
  async streamTask(
    task: string,
    onEvent: (event: any) => void
  ): Promise<void> {
    if (!this.agent) {
      throw new CodeMieAgentError(
        'Agent not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }

    try {
      await this.agent.chatStream(task, onEvent);
    } catch (error) {
      throw new CodeMieAgentError(
        `Streaming task failed: ${error instanceof Error ? error.message : String(error)}`,
        'STREAM_TASK_ERROR',
        { task, originalError: error }
      );
    }
  }

  /**
   * Get agent statistics
   */
  getStats(): AgentStats | null {
    return this.agent?.getStats() || null;
  }

  /**
   * Get initialization result
   */
  getInitializationResult(): InitializationResult | null {
    return this.initializationResult;
  }

  /**
   * Get agent configuration (sanitized)
   */
  getConfig(): CodeMieConfig | null {
    return this.agent?.getConfig() || null;
  }

  /**
   * Get the underlying agent instance (for advanced usage)
   */
  getAgent(): CodeMieAgent | null {
    return this.agent;
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    if (this.agent) {
      this.agent.clearHistory();
    }
  }

  /**
   * Health check for the entire system
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    initialized: boolean;
    config: any;
    agent?: any;
    error?: string;
  }> {
    try {
      const configStatus = {
        valid: !!this.config,
        provider: this.config?.provider,
        model: this.config?.model,
        workingDirectory: this.config?.workingDirectory
      };

      if (!this.agent) {
        return {
          status: 'unhealthy',
          initialized: false,
          config: configStatus,
          error: 'Agent not initialized'
        };
      }

      const agentStats = this.agent.getStats();
      const agentConfig = this.agent.getConfig();

      return {
        status: 'healthy',
        initialized: true,
        config: configStatus,
        agent: {
          stats: agentStats,
          config: agentConfig ? {
            provider: agentConfig.provider,
            model: agentConfig.model
          } : null
        }
      };

    } catch (error) {
      return {
        status: 'unhealthy',
        initialized: !!this.agent,
        config: { valid: false },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Dispose of resources
   */
  async dispose(): Promise<void> {
    // Future: Clean up any resources, close connections, etc.
    if (this.config.debug) {
      logger.debug('CodeMie agent disposed');
    }
  }

  /**
   * Static method to test connection and configuration
   */
  static async testConnection(workingDir?: string): Promise<{
    success: boolean;
    provider?: string;
    model?: string;
    error?: string;
  }> {
    try {
      const config = await loadCodeMieConfig(workingDir);

      // Basic validation that we can create an agent
      const codeMie = new CodeMieCode(workingDir);
      codeMie.config = config;

      // Try to initialize (this will test tool creation and agent setup)
      const initResult = await codeMie.initialize();

      await codeMie.dispose();

      return {
        success: initResult.success,
        provider: config.provider,
        model: config.model
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

// Export types and utilities for external use
export type {
  CodeMieConfig,
  AgentEvent,
  EventCallback,
  AgentStats,
  TokenUsage,
  ExecutionStep
} from './types.js';
export { loadCodeMieConfig, getConfigSummary } from './config.js';
export { CodeMieAgent } from './agent.js';
export {
  formatCost,
  formatTokens,
  formatTokenUsageSummary,
  calculateCost
} from './tokenUtils.js';