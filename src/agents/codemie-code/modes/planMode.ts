/**
 * Plan Mode Implementation
 *
 * Provides structured planning phase before task execution
 * Inspired by LangChain-Code's Deep Agent planning workflow
 */

import type { CodeMieAgent } from '../agent.js';
import type { CodeMieAgentState, Todo, EventCallback } from '../types.js';
import { getSystemPromptWithPlanning, getTaskPlanningPrompt, detectTaskType } from '../prompts.js';
import { validateTodoList, generateQualityReport } from '../utils/todoValidator.js';
import { calculateProgress } from '../utils/todoParser.js';
import { ContextAwarePlanner, type ContextGatheringConfig } from './contextAwarePlanning.js';

/**
 * Plan mode configuration options
 */
export interface PlanModeConfig {
  /** Require planning phase before execution */
  requirePlanning: boolean;

  /** Maximum number of todos allowed */
  maxTodos: number;

  /** Enforce sequential execution */
  enforceSequential: boolean;

  /** Minimum quality score required (0-100) */
  minQualityScore: number;

  /** Show planning feedback to user */
  showPlanningFeedback: boolean;

  /** Timeout for planning phase in seconds */
  planningTimeout: number;

  /** Enable context-aware planning (explores codebase first) */
  useContextAwarePlanning: boolean;

  /** Context gathering configuration */
  contextConfig: ContextGatheringConfig;
}

/**
 * Planning phase result
 */
export interface PlanningResult {
  /** Whether planning was successful */
  success: boolean;

  /** Generated todos */
  todos: Todo[];

  /** Quality assessment */
  qualityScore: number;

  /** Planning duration in milliseconds */
  duration: number;

  /** Error message if planning failed */
  error?: string;

  /** Warnings about plan quality */
  warnings: string[];

  /** Suggestions for improvement */
  suggestions: string[];
}

/**
 * Plan Mode orchestrator for structured task execution
 */
export class PlanMode {
  private agent: CodeMieAgent;
  private config: PlanModeConfig;
  private state: CodeMieAgentState;
  private contextAwarePlanner: ContextAwarePlanner;

  constructor(agent: CodeMieAgent, config: Partial<PlanModeConfig> = {}) {
    this.agent = agent;
    this.config = {
      requirePlanning: true,
      maxTodos: 10,
      enforceSequential: true,
      minQualityScore: 40, // Lower threshold for context-aware planning
      showPlanningFeedback: true,
      planningTimeout: 60,
      useContextAwarePlanning: true,
      contextConfig: {
        maxFilesToRead: 10,
        maxDirectoryDepth: 3,
        includeTests: true,
        includeConfig: true,
        analyzeDependencies: true,
        debug: false
      },
      ...config
    };

    // Initialize context-aware planner
    this.contextAwarePlanner = new ContextAwarePlanner(this.agent, this.config.contextConfig);

    // Initialize state
    this.state = {
      todos: [],
      files: {},
      planningComplete: false,
      planMode: {
        enabled: true,
        requirePlanning: this.config.requirePlanning,
        maxTodos: this.config.maxTodos,
        enforceSequential: this.config.enforceSequential
      }
    };
  }

  /**
   * Execute a task with mandatory planning phase
   */
  async executePlannedTask(
    task: string,
    eventCallback?: EventCallback
  ): Promise<string> {
    try {
      // Emit planning start event
      eventCallback?.({
        type: 'planning_start',
        planningInfo: {
          phase: 'starting',
          message: 'Starting planning phase...'
        }
      });

      // Phase 1: Planning
      const planningResult = await this.planningPhase(task, eventCallback);

      if (!planningResult.success) {
        throw new Error(`Planning failed: ${planningResult.error}`);
      }

      // Emit planning complete event
      eventCallback?.({
        type: 'planning_complete',
        planningInfo: {
          phase: 'completed',
          totalSteps: planningResult.todos.length,
          message: `Plan created with ${planningResult.todos.length} steps`
        }
      });

      // Phase 2: Validation
      await this.validatePlan(planningResult, eventCallback);

      // Phase 3: Execution with progress tracking
      const result = await this.executeWithProgress(task, eventCallback);

      // Phase 4: Completion verification
      await this.verifyCompletion(eventCallback);

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      eventCallback?.({
        type: 'error',
        error: `Plan mode execution failed: ${errorMessage}`
      });

      throw error;
    }
  }

  /**
   * Planning phase - force agent to create structured plan
   */
  private async planningPhase(
    task: string,
    eventCallback?: EventCallback
  ): Promise<PlanningResult> {
    const startTime = Date.now();

    try {
      // Use context-aware planning if enabled
      if (this.config.useContextAwarePlanning) {
        return await this.contextAwarePlanningPhase(task, startTime, eventCallback);
      }

      // Fallback to original abstract planning
      return await this.abstractPlanningPhase(task, startTime, eventCallback);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        todos: [],
        qualityScore: 0,
        duration: Date.now() - startTime,
        error: errorMessage,
        warnings: [],
        suggestions: []
      };
    }
  }

  /**
   * Context-aware planning phase that explores codebase first
   */
  private async contextAwarePlanningPhase(
    task: string,
    startTime: number,
    eventCallback?: EventCallback
  ): Promise<PlanningResult> {
    try {
      // Create a wrapper callback that forwards all planning events
      const planningEventCallback: EventCallback = (event) => {
        // Forward the event to the original callback
        eventCallback?.(event);

        // Capture todo updates from the planning process
        if (event.type === 'todo_update' && event.todoUpdate) {
          this.state.todos = [...event.todoUpdate.todos];
          this.state.planningComplete = true;
        }
      };

      // Use the ContextAwarePlanner to create an informed plan
      const { plan: _plan, context: _context } = await this.contextAwarePlanner.createContextAwarePlan(task, planningEventCallback);

      // Emit final planning progress completion
      eventCallback?.({
        type: 'planning_progress',
        planningProgress: {
          phase: 'plan_validation',
          message: 'Plan completed successfully',
          phaseProgress: 100,
          overallProgress: 100,
          details: 'Context-aware plan created and validated'
        }
      });

      // Parse the plan to extract todos (the ContextAwarePlanner should have called write_todos)
      // Get the latest todos directly from TodoStateManager instead of relying on event timing
      const { TodoStateManager } = await import('../tools/planning.js');
      const latestTodos = TodoStateManager.getCurrentTodos();

      // Sync the todos to our state
      if (latestTodos.length > 0) {
        this.state.todos = [...latestTodos];
        this.state.planningComplete = true;
      }

      // Assess plan quality using the latest todos
      const qualityReport = generateQualityReport(this.state.todos);

      const result: PlanningResult = {
        success: qualityReport.qualityScore >= this.config.minQualityScore,
        todos: [...this.state.todos],
        qualityScore: qualityReport.qualityScore,
        duration: Date.now() - startTime,
        warnings: [],
        suggestions: qualityReport.recommendations
      };

      if (!result.success) {
        result.error = `Plan quality too low (${qualityReport.qualityScore}/${this.config.minQualityScore} required)`;
        result.warnings.push('Consider asking for more specific, actionable steps');

        // Emit planning failure event
        eventCallback?.({
          type: 'planning_progress',
          planningProgress: {
            phase: 'plan_validation',
            message: 'Plan validation failed',
            phaseProgress: 100,
            overallProgress: 100,
            details: `Quality score ${qualityReport.qualityScore}/${this.config.minQualityScore} too low`
          }
        });
      } else {
        // Emit planning success event
        eventCallback?.({
          type: 'planning_discovery',
          planningDiscovery: {
            type: 'project_structure',
            summary: `Plan validated successfully with ${this.state.todos.length} steps`,
            data: {
              todoCount: this.state.todos.length,
              qualityScore: qualityReport.qualityScore,
              planningDuration: Date.now() - startTime
            },
            impact: 'Ready for execution with high-quality, context-aware plan'
          }
        });
      }

      // Check todo count limits
      if (this.state.todos.length > this.config.maxTodos) {
        result.warnings.push(`Plan has ${this.state.todos.length} steps (max ${this.config.maxTodos}). Consider breaking into smaller tasks.`);
      }

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit error event
      eventCallback?.({
        type: 'planning_progress',
        planningProgress: {
          phase: 'plan_validation',
          message: 'Planning failed with error',
          phaseProgress: 100,
          overallProgress: 100,
          details: errorMessage
        }
      });

      return {
        success: false,
        todos: [],
        qualityScore: 0,
        duration: Date.now() - startTime,
        error: `Context-aware planning failed: ${errorMessage}`,
        warnings: [],
        suggestions: ['Try with simpler task description', 'Check codebase accessibility']
      };
    }
  }

  /**
   * Original abstract planning phase (fallback)
   */
  private async abstractPlanningPhase(
    task: string,
    startTime: number,
    eventCallback?: EventCallback
  ): Promise<PlanningResult> {
    // Detect task type and get appropriate planning prompt
    const taskType = detectTaskType(task);
    const taskPrompt = getTaskPlanningPrompt(taskType);
    const _systemPrompt = getSystemPromptWithPlanning(this.agent.getConfig()?.workingDirectory || process.cwd());

    // Create planning request
    const planningRequest = `${taskPrompt}

TASK: ${task}

INSTRUCTIONS:
1. Start by calling write_todos([...]) with a structured plan of 3-8 specific steps
2. Each step should be actionable and have clear completion criteria
3. Use verb-first language and be specific about files/components
4. Do NOT start executing yet - only create the plan

Create your plan now using the write_todos tool.`;

    // Emit planning in progress
    eventCallback?.({
      type: 'planning_start',
      planningInfo: {
        phase: 'in_progress',
        message: `Creating ${taskType} plan...`
      }
    });

    // Execute planning with timeout
    const planningPromise = this.executePlanningRequest(planningRequest, eventCallback);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Planning timeout')), this.config.planningTimeout * 1000)
    );

    const planningResponse = await Promise.race([planningPromise, timeoutPromise]);

    // Validate that planning was successful
    // Check if todos were created via tool OR if planning content looks structured
    const responseContent = typeof planningResponse === 'string' ? planningResponse : '';
    const hasStructuredPlan = this.validatePlanningContent(responseContent);

    if (this.state.todos.length === 0 && !hasStructuredPlan) {
      return {
        success: false,
        todos: [],
        qualityScore: 0,
        duration: Date.now() - startTime,
        error: 'Agent failed to create any todos during planning phase',
        warnings: [],
        suggestions: ['Try rephrasing the task to be more specific']
      };
    }

    // If no explicit todos but we have structured planning content, create basic todos
    if (this.state.todos.length === 0 && hasStructuredPlan) {
      this.state.todos = this.extractTodosFromContent(responseContent);
    }

    // Get the latest todos from TodoStateManager to ensure we have the most recent state
    const { TodoStateManager } = await import('../tools/planning.js');
    const latestTodos = TodoStateManager.getCurrentTodos();
    if (latestTodos.length > 0) {
      this.state.todos = [...latestTodos];
      this.state.planningComplete = true;
    }

    // Assess plan quality
    const qualityReport = generateQualityReport(this.state.todos);

    const result: PlanningResult = {
      success: qualityReport.qualityScore >= this.config.minQualityScore,
      todos: [...this.state.todos],
      qualityScore: qualityReport.qualityScore,
      duration: Date.now() - startTime,
      warnings: [],
      suggestions: qualityReport.recommendations
    };

    if (!result.success) {
      result.error = `Plan quality too low (${qualityReport.qualityScore}/${this.config.minQualityScore} required)`;
      result.warnings.push('Consider asking for more specific, actionable steps');
    }

    // Check todo count limits
    if (this.state.todos.length > this.config.maxTodos) {
      result.warnings.push(`Plan has ${this.state.todos.length} steps (max ${this.config.maxTodos}). Consider breaking into smaller tasks.`);
    }

    return result;
  }

  /**
   * Execute the planning request and capture todos
   */
  private async executePlanningRequest(
    planningRequest: string,
    eventCallback?: EventCallback
  ): Promise<string> {
    let todos: Todo[] = [];

    // Create a wrapper callback that captures todo creation
    const planningCallback: EventCallback = (event) => {
      // Forward the event to the original callback
      eventCallback?.(event);

      // Capture todo updates
      if (event.type === 'todo_update' && event.todoUpdate) {
        todos = event.todoUpdate.todos;
        this.state.todos = [...todos];
        this.state.planningComplete = true;
      }
    };

    // Execute the planning request
    let result = '';
    await this.agent.chatStream(planningRequest, (event) => {
      planningCallback(event);

      if (event.type === 'content_chunk') {
        result += event.content || '';
      }
    });

    // Ensure we captured the todos
    if (todos.length > 0) {
      this.state.todos = todos;
      this.state.planningComplete = true;
    }

    return result;
  }

  /**
   * Validate the generated plan
   */
  private async validatePlan(
    planningResult: PlanningResult,
    eventCallback?: EventCallback
  ): Promise<void> {
    const validation = validateTodoList(planningResult.todos);

    if (validation.errors.length > 0) {
      throw new Error(`Plan validation failed: ${validation.errors.join(', ')}`);
    }

    if (this.config.showPlanningFeedback && eventCallback) {
      // Show planning feedback
      if (validation.warnings.length > 0) {
        eventCallback({
          type: 'content_chunk',
          content: `⚠️ Planning warnings: ${validation.warnings.join(', ')}\n`
        });
      }

      if (validation.suggestions.length > 0) {
        eventCallback({
          type: 'content_chunk',
          content: `💡 Suggestions: ${validation.suggestions.slice(0, 2).join(', ')}\n`
        });
      }
    }
  }

  /**
   * Execute the task with progress tracking
   */
  private async executeWithProgress(
    task: string,
    eventCallback?: EventCallback
  ): Promise<string> {
    // Create execution request that references the plan
    const executionRequest = `Now execute the plan you created. For each step:

1. Call update_todo_status(index, "in_progress") when starting a step
2. Perform the work for that step
3. Call update_todo_status(index, "completed") when finishing the step
4. Move to the next step

Remember:
- Only work on ONE step at a time (only one "in_progress")
- Complete steps in order when possible
- Update status as you work through the plan
- Use the tools you have available to complete each step

Begin executing your plan now, starting with step 0.`;

    let result = '';
    await this.agent.chatStream(executionRequest, (event) => {
      eventCallback?.(event);

      if (event.type === 'content_chunk') {
        result += event.content || '';
      }

      // Update internal state when todos change
      if (event.type === 'todo_update' && event.todoUpdate) {
        this.state.todos = event.todoUpdate.todos;
      }
    });

    return result;
  }

  /**
   * Verify that execution completed successfully
   */
  private async verifyCompletion(eventCallback?: EventCallback): Promise<void> {
    const progress = calculateProgress(this.state.todos);

    if (progress.total === 0) {
      eventCallback?.({
        type: 'content_chunk',
        content: '\n⚠️ No todos were tracked during execution.\n'
      });
      return;
    }

    const completionRate = (progress.completed / progress.total) * 100;

    if (completionRate === 100) {
      eventCallback?.({
        type: 'content_chunk',
        content: `\n🎉 All ${progress.total} planned steps completed successfully!\n`
      });
    } else if (completionRate >= 80) {
      eventCallback?.({
        type: 'content_chunk',
        content: `\n✅ Most steps completed (${progress.completed}/${progress.total}). Great progress!\n`
      });
    } else {
      eventCallback?.({
        type: 'content_chunk',
        content: `\n📊 Completed ${progress.completed}/${progress.total} steps (${Math.round(completionRate)}%).\n`
      });

      if (progress.currentTodo) {
        eventCallback?.({
          type: 'content_chunk',
          content: `🔄 Last active step: ${progress.currentTodo.content}\n`
        });
      }
    }
  }

  /**
   * Get current plan state
   */
  getPlanState(): CodeMieAgentState {
    return { ...this.state };
  }

  /**
   * Get plan mode configuration
   */
  getConfig(): PlanModeConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<PlanModeConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (this.state.planMode) {
      this.state.planMode = {
        ...this.state.planMode,
        requirePlanning: this.config.requirePlanning,
        maxTodos: this.config.maxTodos,
        enforceSequential: this.config.enforceSequential
      };
    }
  }

  /**
   * Validate if planning content has structured plan elements
   */
  private validatePlanningContent(content: string): boolean {
    // Look for common planning indicators
    const indicators = [
      /\d+\.\s+/g,  // Numbered lists like "1. "
      /[-*]\s+/g,   // Bullet points
      /step\s+\d+/gi, // "Step 1", "Step 2"
      /phase\s+\d+/gi, // "Phase 1", "Phase 2"
      /\b(plan|todo|task|step)s?\b/gi // Planning keywords
    ];

    return indicators.some(pattern => pattern.test(content));
  }

  /**
   * Extract basic todos from planning content
   */
  private extractTodosFromContent(content: string): Todo[] {
    const todos: Todo[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Look for numbered or bulleted items
      const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);

      if (numberedMatch) {
        todos.push({
          content: numberedMatch[1].trim(),
          status: 'pending' as const,
          index: todos.length
        });
      } else if (bulletMatch) {
        todos.push({
          content: bulletMatch[1].trim(),
          status: 'pending' as const,
          index: todos.length
        });
      }
    }

    // If we found some todos, ensure we have at least a few basic ones
    if (todos.length === 0) {
      // Create basic fallback todos
      todos.push(
        {
          content: 'Research and analyze requirements',
          status: 'pending' as const,
          index: 0
        },
        {
          content: 'Implement core functionality',
          status: 'pending' as const,
          index: 1
        },
        {
          content: 'Test and validate results',
          status: 'pending' as const,
          index: 2
        }
      );
    }

    return todos.slice(0, this.config.maxTodos); // Respect max todos limit
  }

  /**
   * Reset plan state
   */
  reset(): void {
    this.state = {
      todos: [],
      files: {},
      planningComplete: false,
      planMode: {
        enabled: true,
        requirePlanning: this.config.requirePlanning,
        maxTodos: this.config.maxTodos,
        enforceSequential: this.config.enforceSequential
      }
    };
  }
}