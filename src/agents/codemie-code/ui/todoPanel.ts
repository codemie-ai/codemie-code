/**
 * Todo Panel UI Component
 *
 * Provides rich visual display of todo lists with progress tracking
 * Inspired by LangChain-Code's Rich-based todo panels
 */

import * as clack from '@clack/prompts';
import chalk from 'chalk';
import type { Todo, ProgressInfo } from '../types.js';
import { calculateProgress } from '../utils/todoParser.js';

/**
 * Visual styling configuration for todo display
 */
export interface TodoDisplayOptions {
  /** Show progress bar */
  showProgress?: boolean;

  /** Show timestamps */
  showTimestamps?: boolean;

  /** Show quality indicators */
  showQuality?: boolean;

  /** Compact display mode */
  compact?: boolean;

  /** Maximum width for content */
  maxWidth?: number;
}

/**
 * Todo Panel for rich terminal display
 */
export class TodoPanel {
  private todos: Todo[] = [];
  private lastProgressInfo: ProgressInfo | null = null;

  constructor(private options: TodoDisplayOptions = {}) {
    this.options = {
      showProgress: true,
      showTimestamps: false,
      showQuality: false,
      compact: false,
      maxWidth: 80,
      ...options
    };
  }

  /**
   * Update the todo list and trigger display refresh
   */
  update(todos: Todo[]): void {
    this.todos = [...todos];
    this.lastProgressInfo = calculateProgress(todos);
  }

  /**
   * Render the todo panel as a formatted string
   */
  render(): string {
    if (this.todos.length === 0) {
      return this.renderEmptyState();
    }

    const sections: string[] = [];

    // Add header
    sections.push(this.renderHeader());

    // Add todo items
    sections.push(this.renderTodoItems());

    // Add progress section
    if (this.options.showProgress && this.lastProgressInfo) {
      sections.push(this.renderProgress());
    }

    // Add current activity
    if (this.lastProgressInfo?.currentTodo) {
      sections.push(this.renderCurrentActivity());
    }

    return sections.join('\n\n');
  }

  /**
   * Render empty state
   */
  private renderEmptyState(): string {
    return chalk.dim('📋 No todos yet. Use write_todos to create a plan.');
  }

  /**
   * Render panel header
   */
  private renderHeader(): string {
    const count = this.todos.length;
    const completed = this.todos.filter(t => t.status === 'completed').length;

    let header = chalk.bold.blueBright(`📋 Todo List`);

    if (count > 0) {
      const percentage = Math.round((completed / count) * 100);
      header += chalk.dim(` (${completed}/${count} • ${percentage}%)`);
    }

    return header;
  }

  /**
   * Render individual todo items
   */
  private renderTodoItems(): string {
    const items: string[] = [];

    this.todos.forEach((todo, index) => {
      const item = this.renderTodoItem(todo, index);
      items.push(item);
    });

    return items.join('\n');
  }

  /**
   * Render a single todo item
   */
  private renderTodoItem(todo: Todo, index: number): string {
    const { status, content } = todo;

    // Status icon and styling
    let icon: string;
    let contentStyle: (text: string) => string;

    switch (status) {
      case 'completed':
        icon = chalk.green('✅');
        contentStyle = (text: string) => chalk.green(chalk.strikethrough(text));
        break;
      case 'in_progress':
        icon = chalk.yellow('🔄');
        contentStyle = (text: string) => chalk.yellow.bold(text);
        break;
      case 'pending':
      default:
        icon = chalk.dim('⏳');
        contentStyle = (text: string) => chalk.dim(text);
        break;
    }

    // Format content
    let displayContent = content;
    if (this.options.maxWidth && content.length > this.options.maxWidth - 10) {
      displayContent = content.substring(0, this.options.maxWidth - 13) + '...';
    }

    // Build the line
    const indexStr = chalk.dim(`${index + 1}.`);
    const styledContent = contentStyle(displayContent);

    let line = `${indexStr} ${icon} ${styledContent}`;

    // Add timestamp if enabled
    if (this.options.showTimestamps && todo.timestamp) {
      const timeStr = this.formatTimestamp(todo.timestamp);
      line += chalk.dim(` (${timeStr})`);
    }

    return line;
  }

  /**
   * Render progress section
   */
  private renderProgress(): string {
    if (!this.lastProgressInfo) return '';

    const { total, completed, percentage } = this.lastProgressInfo;

    // Progress bar
    const barWidth = 20;
    const filled = Math.round((percentage / 100) * barWidth);
    const empty = barWidth - filled;

    const filledBar = chalk.green('█'.repeat(filled));
    const emptyBar = chalk.dim('░'.repeat(empty));
    const progressBar = `[${filledBar}${emptyBar}]`;

    const stats = chalk.bold(`${completed}/${total} completed (${percentage}%)`);

    return `📊 ${stats} ${progressBar}`;
  }

  /**
   * Render current activity section
   */
  private renderCurrentActivity(): string {
    if (!this.lastProgressInfo?.currentTodo) return '';

    const { currentTodo } = this.lastProgressInfo;
    return `🎯 ${chalk.yellow.bold('Currently working on:')} ${chalk.yellow(currentTodo.content)}`;
  }

  /**
   * Format timestamp for display
   */
  private formatTimestamp(timestamp: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  /**
   * Show a diff between two todo states
   */
  renderDiff(previousTodos: Todo[], currentTodos: Todo[]): string {
    const changes: string[] = [];

    // Find status changes
    const minLength = Math.min(previousTodos.length, currentTodos.length);
    for (let i = 0; i < minLength; i++) {
      const prev = previousTodos[i];
      const curr = currentTodos[i];

      if (prev.status !== curr.status) {
        const statusIcon = curr.status === 'completed' ? '✅' :
                          curr.status === 'in_progress' ? '🔄' : '⏳';
        changes.push(`${i + 1}. ${statusIcon} ${curr.content} (${prev.status} → ${curr.status})`);
      }
    }

    // Find new todos
    if (currentTodos.length > previousTodos.length) {
      for (let i = previousTodos.length; i < currentTodos.length; i++) {
        const todo = currentTodos[i];
        changes.push(`${i + 1}. ➕ ${todo.content} (added)`);
      }
    }

    // Find removed todos
    if (previousTodos.length > currentTodos.length) {
      for (let i = currentTodos.length; i < previousTodos.length; i++) {
        const todo = previousTodos[i];
        changes.push(`${i + 1}. ➖ ${todo.content} (removed)`);
      }
    }

    if (changes.length === 0) {
      return chalk.dim('No changes');
    }

    return `🔄 ${chalk.bold('Changes:')}\n${changes.map(c => `  ${c}`).join('\n')}`;
  }

  /**
   * Render a compact single-line progress indicator
   */
  renderCompactProgress(): string {
    if (!this.lastProgressInfo) {
      return chalk.dim('📋 No todos');
    }

    const { total, completed, percentage, currentTodo } = this.lastProgressInfo;

    let line = `📋 ${completed}/${total} (${percentage}%)`;

    if (currentTodo) {
      const shortContent = currentTodo.content.length > 30 ?
        currentTodo.content.substring(0, 27) + '...' :
        currentTodo.content;
      line += chalk.yellow(` • ${shortContent}`);
    }

    return line;
  }

  /**
   * Show an animated progress update
   */
  showProgressUpdate(message: string, todoIndex?: number): void {
    let displayMessage = message;

    if (todoIndex !== undefined && this.todos[todoIndex]) {
      const todo = this.todos[todoIndex];
      displayMessage = `${message}: ${todo.content}`;
    }

    // Use clack spinner for visual feedback
    clack.note(displayMessage, '🔄 Todo Update');
  }

  /**
   * Show completion celebration
   */
  showCompletion(): void {
    const { completed, total } = this.lastProgressInfo || { completed: 0, total: 0 };

    if (completed === total && total > 0) {
      clack.outro(chalk.green.bold('🎉 All todos completed! Great work!'));
    } else {
      clack.note(
        `${completed}/${total} todos completed`,
        '✅ Progress Update'
      );
    }
  }

  /**
   * Display validation warnings
   */
  showValidationWarnings(warnings: string[]): void {
    if (warnings.length === 0) return;

    const warningText = warnings
      .slice(0, 3) // Limit to 3 warnings
      .map(w => `• ${w}`)
      .join('\n');

    clack.note(warningText, '⚠️ Todo Quality Warnings');
  }

  /**
   * Display quality suggestions
   */
  showQualitySuggestions(suggestions: string[]): void {
    if (suggestions.length === 0) return;

    const suggestionText = suggestions
      .slice(0, 2) // Limit to 2 suggestions
      .map(s => `• ${s}`)
      .join('\n');

    clack.note(suggestionText, '💡 Quality Suggestions');
  }

  /**
   * Get current todos
   */
  getTodos(): Todo[] {
    return [...this.todos];
  }

  /**
   * Get current progress info
   */
  getProgressInfo(): ProgressInfo | null {
    return this.lastProgressInfo;
  }
}

/**
 * Utility function to create a quick todo display
 */
export function renderTodoList(
  todos: Todo[],
  options: TodoDisplayOptions = {}
): string {
  const panel = new TodoPanel(options);
  panel.update(todos);
  return panel.render();
}

/**
 * Utility function to show a todo update notification
 */
export function showTodoUpdate(
  message: string,
  todos?: Todo[],
  previousTodos?: Todo[]
): void {
  if (todos && previousTodos) {
    const panel = new TodoPanel({ compact: true });
    panel.update(todos);
    const diff = panel.renderDiff(previousTodos, todos);

    clack.note(`${message}\n\n${diff}`, '📋 Todo Update');
  } else {
    clack.note(message, '📋 Todo Update');
  }
}

/**
 * Interactive todo status selector
 */
export async function selectTodoStatus(
  currentStatus: Todo['status']
): Promise<Todo['status'] | symbol> {
  return await clack.select({
    message: 'Select new status:',
    initialValue: currentStatus,
    options: [
      { value: 'pending', label: '⏳ Pending', hint: 'Not yet started' },
      { value: 'in_progress', label: '🔄 In Progress', hint: 'Currently working on' },
      { value: 'completed', label: '✅ Completed', hint: 'Finished successfully' }
    ]
  });
}