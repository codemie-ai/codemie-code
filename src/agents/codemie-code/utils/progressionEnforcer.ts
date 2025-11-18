/**
 * Progression Enforcer Utility
 *
 * Enforces sequential execution rules and validates todo progression
 * Ensures agents follow structured, ordered task completion
 */

import type { Todo } from '../types.js';

/**
 * Progression rule violation types
 */
export type ProgressionViolation =
  | 'multiple_in_progress'
  | 'skip_ahead'
  | 'regression'
  | 'incomplete_sequence'
  | 'invalid_transition';

/**
 * Progression enforcement result
 */
export interface ProgressionEnforcementResult {
  /** Whether enforcement was applied */
  enforced: boolean;

  /** Original todos */
  originalTodos: Todo[];

  /** Corrected todos */
  correctedTodos: Todo[];

  /** Violations found */
  violations: Array<{
    type: ProgressionViolation;
    todoIndex: number;
    description: string;
    correction?: string;
  }>;

  /** Summary of changes made */
  changesSummary: string[];
}

/**
 * Sequential Progression Enforcer
 */
export class ProgressionEnforcer {
  /**
   * Enforce sequential execution rules
   */
  static enforceSequentialExecution(todos: Todo[]): ProgressionEnforcementResult {
    const originalTodos = [...todos];
    const correctedTodos = [...todos];
    const violations: ProgressionEnforcementResult['violations'] = [];
    const changes: string[] = [];

    // Rule 1: Only one todo can be "in_progress" at a time
    const inProgressIndices = correctedTodos
      .map((todo, index) => ({ todo, index }))
      .filter(({ todo }) => todo.status === 'in_progress')
      .map(({ index }) => index);

    if (inProgressIndices.length > 1) {
      // Keep the first in_progress, downgrade others to pending
      for (let i = 1; i < inProgressIndices.length; i++) {
        const index = inProgressIndices[i];
        violations.push({
          type: 'multiple_in_progress',
          todoIndex: index,
          description: `Multiple todos in progress - only one allowed`,
          correction: 'Changed to pending'
        });

        correctedTodos[index] = {
          ...correctedTodos[index],
          status: 'pending',
          lastUpdated: new Date()
        };

        changes.push(`Todo ${index + 1}: in_progress → pending (multiple in_progress violation)`);
      }
    }

    // Rule 2: Sequential execution - can't skip ahead
    let blocked = false;
    for (let i = 0; i < correctedTodos.length; i++) {
      const todo = correctedTodos[i];

      // If we hit a non-completed todo, all subsequent todos should be blocked
      if (todo.status !== 'completed') {
        blocked = true;
      }

      // If we're blocked and this todo is completed or in_progress inappropriately
      if (blocked && i > 0 && (todo.status === 'completed' || todo.status === 'in_progress')) {
        const previousTodo = correctedTodos[i - 1];

        if (previousTodo.status !== 'completed') {
          violations.push({
            type: 'skip_ahead',
            todoIndex: i,
            description: `Cannot work on step ${i + 1} while step ${i} is not completed`,
            correction: 'Changed to pending'
          });

          correctedTodos[i] = {
            ...correctedTodos[i],
            status: 'pending',
            lastUpdated: new Date()
          };

          changes.push(`Todo ${i + 1}: ${todo.status} → pending (sequential execution violation)`);
        }
      }
    }

    return {
      enforced: violations.length > 0,
      originalTodos,
      correctedTodos,
      violations,
      changesSummary: changes
    };
  }

  /**
   * Validate todo status transition
   */
  static validateTransition(
    fromStatus: Todo['status'],
    toStatus: Todo['status'],
    todoIndex: number,
    allTodos: Todo[]
  ): { valid: boolean; reason?: string } {
    // Valid basic transitions
    const validTransitions: Record<Todo['status'], Todo['status'][]> = {
      'pending': ['in_progress', 'completed'],
      'in_progress': ['completed', 'pending'],
      'completed': ['pending', 'in_progress'] // Allow reopening
    };

    if (!validTransitions[fromStatus]?.includes(toStatus)) {
      return {
        valid: false,
        reason: `Invalid transition: ${fromStatus} → ${toStatus}`
      };
    }

    // Additional sequential validation
    if (toStatus === 'in_progress') {
      // Check if any other todo is already in_progress
      const otherInProgress = allTodos.find((todo, index) =>
        index !== todoIndex && todo.status === 'in_progress'
      );

      if (otherInProgress) {
        return {
          valid: false,
          reason: 'Another todo is already in progress'
        };
      }

      // Check if previous todos are completed (sequential enforcement)
      for (let i = 0; i < todoIndex; i++) {
        if (allTodos[i].status !== 'completed') {
          return {
            valid: false,
            reason: `Cannot start step ${todoIndex + 1} while step ${i + 1} is not completed`
          };
        }
      }
    }

    if (toStatus === 'completed') {
      // Generally allowed, but warn if skipping steps
      const incompleteEarlierSteps = allTodos
        .slice(0, todoIndex)
        .filter(todo => todo.status !== 'completed').length;

      if (incompleteEarlierSteps > 0) {
        return {
          valid: true, // Allow but warn
          reason: `Warning: Completing step ${todoIndex + 1} while ${incompleteEarlierSteps} earlier steps are incomplete`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Get next allowed todo for execution
   */
  static getNextTodo(todos: Todo[]): {
    nextTodo: Todo | null;
    nextIndex: number;
    reason: string;
  } {
    // Check if any todo is currently in progress
    const currentInProgress = todos.findIndex(todo => todo.status === 'in_progress');

    if (currentInProgress !== -1) {
      return {
        nextTodo: todos[currentInProgress],
        nextIndex: currentInProgress,
        reason: 'Continue current in-progress todo'
      };
    }

    // Find first non-completed todo
    const nextPendingIndex = todos.findIndex(todo => todo.status === 'pending');

    if (nextPendingIndex === -1) {
      return {
        nextTodo: null,
        nextIndex: -1,
        reason: 'All todos completed'
      };
    }

    // Check if we can start this todo (sequential enforcement)
    const incompletePrevious = todos
      .slice(0, nextPendingIndex)
      .filter(todo => todo.status !== 'completed').length;

    if (incompletePrevious > 0) {
      const firstIncompleteIndex = todos.findIndex(todo => todo.status !== 'completed');
      return {
        nextTodo: todos[firstIncompleteIndex],
        nextIndex: firstIncompleteIndex,
        reason: `Must complete step ${firstIncompleteIndex + 1} before step ${nextPendingIndex + 1}`
      };
    }

    return {
      nextTodo: todos[nextPendingIndex],
      nextIndex: nextPendingIndex,
      reason: 'Next sequential todo'
    };
  }

  /**
   * Analyze progression health
   */
  static analyzeProgression(todos: Todo[]): {
    health: 'excellent' | 'good' | 'warning' | 'poor';
    score: number; // 0-100
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    // Check for multiple in_progress
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      issues.push(`${inProgressCount} todos in progress (only 1 allowed)`);
      recommendations.push('Complete current todo before starting next one');
      score -= 30;
    } else if (inProgressCount === 0 && todos.some(t => t.status === 'pending')) {
      issues.push('No todo currently in progress but pending todos exist');
      recommendations.push('Start working on the next pending todo');
      score -= 10;
    }

    // Check for sequential violations
    let foundIncomplete = false;
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];

      if (foundIncomplete && todo.status === 'completed') {
        issues.push(`Step ${i + 1} completed but earlier steps are not`);
        recommendations.push('Complete todos in sequential order when possible');
        score -= 15;
      }

      if (todo.status !== 'completed') {
        foundIncomplete = true;
      }
    }

    // Check for stalled progress
    const completedCount = todos.filter(t => t.status === 'completed').length;
    const totalCount = todos.length;
    const completionRate = totalCount > 0 ? completedCount / totalCount : 0;

    if (completionRate === 0 && totalCount > 0) {
      issues.push('No progress made on any todos');
      recommendations.push('Start with the first todo in the list');
      score -= 20;
    } else if (completionRate < 0.3 && totalCount >= 3) {
      issues.push('Low completion rate');
      recommendations.push('Focus on completing current todos before adding new ones');
      score -= 10;
    }

    // Determine health level
    let health: 'excellent' | 'good' | 'warning' | 'poor';
    if (score >= 90) health = 'excellent';
    else if (score >= 70) health = 'good';
    else if (score >= 50) health = 'warning';
    else health = 'poor';

    return {
      health,
      score: Math.max(0, score),
      issues,
      recommendations
    };
  }

  /**
   * Auto-correct todo progression issues
   */
  static autoCorrect(todos: Todo[]): {
    corrected: Todo[];
    corrections: string[];
    summary: string;
  } {
    const enforcement = this.enforceSequentialExecution(todos);

    const summary = enforcement.enforced
      ? `Applied ${enforcement.violations.length} correction${enforcement.violations.length === 1 ? '' : 's'}`
      : 'No corrections needed';

    return {
      corrected: enforcement.correctedTodos,
      corrections: enforcement.changesSummary,
      summary
    };
  }
}

/**
 * Utility functions for common progression operations
 */

/**
 * Check if it's safe to start a specific todo
 */
export function canStartTodo(todoIndex: number, todos: Todo[]): {
  canStart: boolean;
  reason: string;
} {
  if (todoIndex < 0 || todoIndex >= todos.length) {
    return { canStart: false, reason: 'Invalid todo index' };
  }

  const todo = todos[todoIndex];

  if (todo.status !== 'pending') {
    return { canStart: false, reason: `Todo is ${todo.status}, not pending` };
  }

  // Check for existing in_progress todo
  const existingInProgress = todos.find((t, i) => i !== todoIndex && t.status === 'in_progress');
  if (existingInProgress) {
    return { canStart: false, reason: 'Another todo is already in progress' };
  }

  // Check sequential requirement
  for (let i = 0; i < todoIndex; i++) {
    if (todos[i].status !== 'completed') {
      return {
        canStart: false,
        reason: `Must complete step ${i + 1} before starting step ${todoIndex + 1}`
      };
    }
  }

  return { canStart: true, reason: 'Ready to start' };
}

/**
 * Get progression summary
 */
export function getProgressionSummary(todos: Todo[]): string {
  const analysis = ProgressionEnforcer.analyzeProgression(todos);
  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const pending = todos.filter(t => t.status === 'pending').length;

  let summary = `${completed}/${todos.length} completed`;

  if (inProgress > 0) {
    summary += `, ${inProgress} in progress`;
  }

  if (pending > 0) {
    summary += `, ${pending} pending`;
  }

  summary += ` (${analysis.health} progression)`;

  return summary;
}