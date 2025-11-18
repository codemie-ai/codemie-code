/**
 * Progress Tracker Utility
 *
 * Provides real-time progress tracking and visualization for todo-based workflows
 */

import * as clack from '@clack/prompts';
import chalk from 'chalk';
import type { Todo, ProgressInfo, TodoUpdateEvent } from '../types.js';
import { calculateProgress } from '../utils/todoParser.js';
import { TodoPanel } from './todoPanel.js';

/**
 * Progress tracking configuration
 */
export interface ProgressTrackerConfig {
  /** Show real-time updates */
  realTimeUpdates?: boolean;

  /** Update interval in milliseconds */
  updateInterval?: number;

  /** Show completion celebrations */
  showCelebrations?: boolean;

  /** Show quality feedback */
  showQualityFeedback?: boolean;

  /** Compact display mode */
  compact?: boolean;
}

/**
 * Progress Tracker for todo-based workflows
 */
export class ProgressTracker {
  private todos: Todo[] = [];
  private todoPanel: TodoPanel;
  private lastProgressInfo: ProgressInfo | null = null;
  private isTracking = false;
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(private config: ProgressTrackerConfig = {}) {
    this.config = {
      realTimeUpdates: true,
      updateInterval: 1000,
      showCelebrations: true,
      showQualityFeedback: false,
      compact: false,
      ...config
    };

    this.todoPanel = new TodoPanel({
      compact: this.config.compact,
      showProgress: true,
      showTimestamps: false
    });
  }

  /**
   * Start tracking todo progress
   */
  start(initialTodos: Todo[] = []): void {
    if (this.isTracking) {
      this.stop();
    }

    this.todos = [...initialTodos];
    this.todoPanel.update(this.todos);
    this.lastProgressInfo = calculateProgress(this.todos);
    this.isTracking = true;

    // Show initial state
    this.displayCurrentState();

    // Start real-time updates if enabled
    if (this.config.realTimeUpdates && this.config.updateInterval) {
      this.updateTimer = setInterval(() => {
        this.checkForUpdates();
      }, this.config.updateInterval);
    }
  }

  /**
   * Stop tracking
   */
  stop(): void {
    this.isTracking = false;

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * Update todos and refresh display
   */
  updateTodos(newTodos: Todo[], event?: TodoUpdateEvent, suppressVisualFeedback: boolean = false): void {
    if (!this.isTracking) return;

    // Handle null/undefined gracefully
    if (!newTodos || !Array.isArray(newTodos)) {
      return;
    }

    const previousTodos = [...this.todos];
    this.todos = [...newTodos];
    this.todoPanel.update(this.todos);

    const newProgressInfo = calculateProgress(this.todos);
    const progressChanged = this.hasProgressChanged(newProgressInfo);

    // Show update notification only if not suppressing visual feedback
    if (event && !suppressVisualFeedback) {
      this.handleTodoUpdateEvent(event, previousTodos);
    }

    // Update progress info
    this.lastProgressInfo = newProgressInfo;

    // Show celebrations if progress improved and not suppressing feedback
    if (progressChanged && this.config.showCelebrations && !suppressVisualFeedback) {
      this.checkForCelebrations(newProgressInfo);
    }

    // Display updated state only if not suppressing feedback
    if (!suppressVisualFeedback) {
      this.displayCurrentState();
    }
  }

  /**
   * Handle specific todo update events
   */
  private handleTodoUpdateEvent(event: TodoUpdateEvent, previousTodos: Todo[]): void {
    const { changeType, changedIndex, todos } = event;

    switch (changeType) {
      case 'create':
        if (changedIndex !== undefined) {
          const todo = todos[changedIndex];
          clack.note(`Added: ${todo.content}`, '➕ New Todo');
        } else {
          // Only show "Todo List Created" if we're showing visual feedback
          // This prevents duplicate messages during planning phases
          if (todos.length > 0) {
            clack.note(`Created ${todos.length} todo${todos.length === 1 ? '' : 's'}`, '📋 Todo List Created');
          }
        }
        break;

      case 'update':
        if (changedIndex !== undefined) {
          const todo = todos[changedIndex];
          const previousTodo = previousTodos[changedIndex];

          if (previousTodo && todo.status !== previousTodo.status) {
            this.showStatusChangeNotification(todo, previousTodo.status, changedIndex);
          }
        }
        break;

      case 'delete':
        clack.note(`Removed ${previousTodos.length} todo${previousTodos.length === 1 ? '' : 's'}`, '🗑️ Todos Cleared');
        break;

      case 'reorder':
        clack.note('Todo order updated', '🔄 Reordered');
        break;
    }
  }

  /**
   * Show status change notification
   */
  private showStatusChangeNotification(todo: Todo, previousStatus: Todo['status'], index: number): void {
    const statusEmoji = {
      'pending': '⏳',
      'in_progress': '🔄',
      'completed': '✅'
    };

    const message = `${statusEmoji[todo.status]} ${todo.content}`;
    // const subtitle = `Status: ${previousStatus} → ${todo.status}`;  // Available for future use

    switch (todo.status) {
      case 'in_progress':
        clack.note(message, `🎯 Started Task ${index + 1}`);
        break;

      case 'completed':
        clack.note(message, `✅ Completed Task ${index + 1}`);
        this.showTaskCompletion(todo, index);
        break;

      case 'pending':
        clack.note(message, `⏳ Reset Task ${index + 1}`);
        break;
    }
  }

  /**
   * Show task completion with celebration
   */
  private showTaskCompletion(todo: Todo, _index: number): void {
    if (!this.config.showCelebrations) return;

    const progress = this.lastProgressInfo;
    if (!progress) return;

    // Individual task completion
    const completionMessage = chalk.green(`🎉 Great job completing: ${todo.content}`);

    // Check if this was the final task
    if (progress.completed === progress.total && progress.total > 1) {
      clack.outro(chalk.green.bold('🏆 All tasks completed! Excellent work!'));
    } else if (progress.completed === progress.total - 1) {
      clack.note(completionMessage + chalk.yellow('\n\n🏁 One more task to go!'), '🎯 Almost There');
    } else {
      clack.note(completionMessage, '✨ Task Complete');
    }
  }

  /**
   * Check for milestone celebrations
   */
  private checkForCelebrations(progressInfo: ProgressInfo): void {
    if (!this.config.showCelebrations) return;

    const { percentage, completed: _completed, total } = progressInfo;

    // Milestone celebrations
    if (percentage === 25 && total >= 4) {
      clack.note('🌟 25% complete - Great start!', '🎯 Milestone');
    } else if (percentage === 50 && total >= 4) {
      clack.note('🔥 50% complete - Halfway there!', '🎯 Milestone');
    } else if (percentage === 75 && total >= 4) {
      clack.note('⚡ 75% complete - Almost done!', '🎯 Milestone');
    } else if (percentage === 100 && total > 0) {
      const celebration = total === 1 ?
        '🎉 Task completed!' :
        `🏆 All ${total} tasks completed! Outstanding work!`;

      clack.outro(chalk.green.bold(celebration));
    }
  }

  /**
   * Display current state
   */
  private displayCurrentState(): void {
    if (!this.isTracking) return;

    // Only show progress if we have todos to track
    if (this.todos.length === 0) return;

    if (this.config.compact) {
      // Compact single-line display
      console.log(this.todoPanel.renderCompactProgress());
    } else {
      // Full panel display (for debug or detailed mode)
      // In normal operation, we rely on individual notifications
      // rather than constantly refreshing the full panel
    }
  }

  /**
   * Check if progress has meaningfully changed
   */
  private hasProgressChanged(newProgressInfo: ProgressInfo): boolean {
    if (!this.lastProgressInfo) return true;

    return (
      newProgressInfo.completed !== this.lastProgressInfo.completed ||
      newProgressInfo.inProgress !== this.lastProgressInfo.inProgress ||
      newProgressInfo.total !== this.lastProgressInfo.total
    );
  }

  /**
   * Check for updates (for polling mode)
   */
  private checkForUpdates(): void {
    // This would be used if we need to poll for external changes
    // Currently, we rely on explicit updateTodos calls
  }

  /**
   * Show planning phase start
   */
  showPlanningStart(): void {
    // Don't duplicate planning start message - handled by main UI spinner
  }

  /**
   * Show planning phase completion
   */
  showPlanningComplete(todoCount: number): void {
    const message = `Created plan with ${todoCount} step${todoCount === 1 ? '' : 's'}`;
    clack.log.success(`📋 ${message}`);
  }

  /**
   * Show execution phase start
   */
  showExecutionStart(): void {
    clack.log.info('🚀 Starting execution phase...');
  }

  /**
   * Show overall completion
   */
  showOverallCompletion(stats: { totalTime?: number; tasksCompleted: number }): void {
    const { totalTime, tasksCompleted } = stats;

    let message = `🏁 Completed ${tasksCompleted} task${tasksCompleted === 1 ? '' : 's'}`;

    if (totalTime) {
      const minutes = Math.round(totalTime / 60000);
      const seconds = Math.round((totalTime % 60000) / 1000);

      if (minutes > 0) {
        message += ` in ${minutes}m ${seconds}s`;
      } else {
        message += ` in ${seconds}s`;
      }
    }

    clack.outro(chalk.green.bold(message));
  }

  /**
   * Show error state
   */
  showError(error: string, todoIndex?: number): void {
    let message = `❌ ${error}`;

    if (todoIndex !== undefined && this.todos[todoIndex]) {
      message += `\n📍 While working on: ${this.todos[todoIndex].content}`;
    }

    clack.log.error(message);
  }

  /**
   * Show warning
   */
  showWarning(warning: string): void {
    clack.log.warn(`⚠️ ${warning}`);
  }

  /**
   * Get current progress
   */
  getCurrentProgress(): ProgressInfo | null {
    return this.lastProgressInfo;
  }

  /**
   * Get current todos
   */
  getCurrentTodos(): Todo[] {
    return [...this.todos];
  }

  /**
   * Check if currently tracking
   */
  isActive(): boolean {
    return this.isTracking;
  }
}

/**
 * Global progress tracker instance
 */
let globalProgressTracker: ProgressTracker | null = null;

/**
 * Get or create global progress tracker
 */
export function getProgressTracker(config?: ProgressTrackerConfig): ProgressTracker {
  if (!globalProgressTracker) {
    globalProgressTracker = new ProgressTracker(config);
  }
  return globalProgressTracker;
}

/**
 * Reset global progress tracker
 */
export function resetProgressTracker(): void {
  if (globalProgressTracker) {
    globalProgressTracker.stop();
    globalProgressTracker = null;
  }
}

/**
 * Quick utility to show a progress update
 */
export function showQuickProgress(todos: Todo[], message?: string): void {
  const progress = calculateProgress(todos);
  const progressText = `${progress.completed}/${progress.total} (${progress.percentage}%)`;

  const displayMessage = message ?
    `${message} - ${progressText}` :
    `Progress: ${progressText}`;

  clack.log.info(`📊 ${displayMessage}`);
}
