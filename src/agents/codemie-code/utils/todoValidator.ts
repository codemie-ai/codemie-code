/**
 * Todo Validator Utility
 *
 * Provides validation and quality checking for todo lists
 * Ensures todos follow best practices and are actionable
 */

import type { Todo, ProgressInfo } from '../types.js';

/**
 * Validation result for a single todo
 */
export interface TodoValidationResult {
  /** Whether the todo is valid */
  isValid: boolean;

  /** Validation errors */
  errors: string[];

  /** Warnings for improvement */
  warnings: string[];

  /** Quality score (0-100) */
  qualityScore: number;

  /** Suggestions for improvement */
suggestions: string[];
}

/**
 * Validation result for entire todo list
 */
export interface TodoListValidationResult {
  /** Whether the entire list is valid */
  isValid: boolean;

  /** Overall errors */
  errors: string[];

  /** Overall warnings */
  warnings: string[];

  /** Individual todo validations */
  todoValidations: TodoValidationResult[];

  /** Overall quality score (0-100) */
  overallQuality: number;

  /** List-level suggestions */
  suggestions: string[];
}

/**
 * Validate a single todo item
 */
export function validateTodo(todo: Todo, index: number): TodoValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  let qualityScore = 100;

  // Check content
  if (!todo.content || typeof todo.content !== 'string') {
    errors.push('Todo content is required and must be a string');
    qualityScore -= 50;
  } else {
    const content = todo.content.trim();

    // Check minimum length
    if (content.length < 3) {
      warnings.push('Todo content is very short (less than 3 characters)');
      qualityScore -= 20;
    }

    // Check maximum length
    if (content.length > 200) {
      warnings.push('Todo content is very long (over 200 characters)');
      suggestions.push('Consider breaking long todos into smaller, more specific steps');
      qualityScore -= 10;
    }

    // Check for vague language
    const vagueWords = ['thing', 'stuff', 'handle', 'deal with', 'manage', 'work on'];
    const lowerContent = content.toLowerCase();
    const foundVague = vagueWords.filter(word => lowerContent.includes(word));

    if (foundVague.length > 0) {
      warnings.push(`Contains vague language: ${foundVague.join(', ')}`);
      suggestions.push('Use specific, actionable language (e.g., "Read config.ts file" not "Handle configuration")');
      qualityScore -= 15;
    }

    // Check for verb-first structure (good practice)
    const verbs = ['read', 'write', 'create', 'update', 'delete', 'fix', 'implement', 'test', 'review', 'analyze', 'install', 'configure', 'run', 'execute', 'build', 'deploy'];
    const startsWithVerb = verbs.some(verb => lowerContent.startsWith(verb));

    if (!startsWithVerb) {
      suggestions.push('Consider starting with an action verb (e.g., "Read file" instead of "File reading")');
      qualityScore -= 5;
    }

    // Check for file paths or specific targets
    const hasSpecifics = /\.(ts|js|py|md|json|yml|yaml|txt)|src\/|\/.*\/|[A-Z][a-zA-Z]*\./.test(content);
    if (!hasSpecifics && content.length > 10) {
      suggestions.push('Consider being more specific about files, functions, or components');
      qualityScore -= 5;
    }
  }

  // Check status
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (!validStatuses.includes(todo.status)) {
    errors.push(`Invalid status: ${todo.status}. Must be one of: ${validStatuses.join(', ')}`);
    qualityScore -= 30;
  }

  // Check timestamps
  if (todo.timestamp && !(todo.timestamp instanceof Date)) {
    warnings.push('Timestamp should be a Date object');
    qualityScore -= 5;
  }

  if (todo.lastUpdated && !(todo.lastUpdated instanceof Date)) {
    warnings.push('lastUpdated should be a Date object');
    qualityScore -= 5;
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    qualityScore: Math.max(0, qualityScore),
    suggestions
  };
}

/**
 * Validate entire todo list
 */
export function validateTodoList(todos: Todo[]): TodoListValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const todoValidations: TodoValidationResult[] = [];

  // Validate each todo
  for (let i = 0; i < todos.length; i++) {
    const validation = validateTodo(todos[i], i);
    todoValidations.push(validation);

    // Collect errors and warnings
    errors.push(...validation.errors.map(error => `Todo ${i + 1}: ${error}`));
    warnings.push(...validation.warnings.map(warning => `Todo ${i + 1}: ${warning}`));
  }

  // Check list-level constraints

  // Check for duplicate content
  const contentMap = new Map<string, number[]>();
  todos.forEach((todo, index) => {
    const content = todo.content.toLowerCase().trim();
    if (!contentMap.has(content)) {
      contentMap.set(content, []);
    }
    contentMap.get(content)!.push(index + 1);
  });

  for (const [content, indices] of contentMap) {
    if (indices.length > 1) {
      warnings.push(`Duplicate todo content found at positions: ${indices.join(', ')}`);
      suggestions.push('Remove or merge duplicate todos');
    }
  }

  // Check for too many in_progress todos
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
  if (inProgressCount > 1) {
    errors.push(`Too many in_progress todos (${inProgressCount}). Only one should be in_progress at a time.`);
  }

  // Check for proper progression
  let foundNonCompleted = false;
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (foundNonCompleted && todo.status === 'completed') {
      warnings.push(`Todo ${i + 1} is completed but earlier todos are not. Consider sequential execution.`);
      suggestions.push('Complete todos in order to maintain clear progress tracking');
      break;
    }
    if (todo.status !== 'completed') {
      foundNonCompleted = true;
    }
  }

  // Check list size
  if (todos.length === 0) {
    warnings.push('Todo list is empty');
  } else if (todos.length === 1) {
    suggestions.push('Consider breaking complex tasks into multiple steps');
  } else if (todos.length > 10) {
    warnings.push('Todo list is quite long (>10 items). Consider grouping or prioritizing.');
  }

  // Calculate overall quality
  const totalQuality = todoValidations.reduce((sum, validation) => sum + validation.qualityScore, 0);
  const overallQuality = todos.length > 0 ? Math.round(totalQuality / todos.length) : 0;

  // Add quality-based suggestions
  if (overallQuality < 70) {
    suggestions.push('Consider revising todos to be more specific and actionable');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    todoValidations,
    overallQuality,
    suggestions
  };
}

/**
 * Check if todo status transition is valid
 */
export function isValidStatusTransition(from: Todo['status'], to: Todo['status']): boolean {
  // Valid transitions:
  // pending -> in_progress
  // pending -> completed (skip in_progress if needed)
  // in_progress -> completed
  // in_progress -> pending (rollback)
  // completed -> pending (reopen - rare but allowed)
  // completed -> in_progress (reopen - rare but allowed)

  const validTransitions: Record<string, string[]> = {
    'pending': ['in_progress', 'completed'],
    'in_progress': ['completed', 'pending'],
    'completed': ['pending', 'in_progress'] // Allow reopening for corrections
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Suggest improvements for a todo
 */
export function suggestImprovements(todo: Todo): string[] {
  const suggestions: string[] = [];
  const content = todo.content.toLowerCase().trim();

  // Suggest more specific language
  if (content.includes('fix')) {
    suggestions.push('Be more specific about what needs to be fixed (e.g., "Fix TypeScript error in config.ts")');
  }

  if (content.includes('update')) {
    suggestions.push('Specify what needs to be updated and how');
  }

  if (content.includes('improve')) {
    suggestions.push('Define specific improvements to be made');
  }

  // Suggest breaking down complex tasks
  if (content.includes(' and ')) {
    suggestions.push('Consider breaking this into separate todos (contains "and")');
  }

  if (content.includes('implement')) {
    suggestions.push('Consider breaking implementation into smaller steps (plan, code, test, review)');
  }

  // Suggest adding context
  if (!content.includes('.') && !content.includes('/')) {
    suggestions.push('Consider adding file paths or specific locations');
  }

  return suggestions;
}

/**
 * Generate quality report for todo list
 */
export function generateQualityReport(todos: Todo[]): {
  summary: string;
  qualityScore: number;
  recommendations: string[];
  progressInfo: ProgressInfo;
} {
  const validation = validateTodoList(todos);
  const progressInfo = calculateProgress(todos);

  const recommendations: string[] = [
    ...validation.suggestions,
    ...validation.todoValidations
      .flatMap((v, i) => v.suggestions.map(s => `Todo ${i + 1}: ${s}`))
  ];

  let summary = `Todo list contains ${todos.length} items with ${validation.errors.length} errors and ${validation.warnings.length} warnings.`;

  if (validation.overallQuality >= 80) {
    summary += ' Quality is excellent.';
  } else if (validation.overallQuality >= 60) {
    summary += ' Quality is good but could be improved.';
  } else {
    summary += ' Quality needs improvement.';
  }

  return {
    summary,
    qualityScore: validation.overallQuality,
    recommendations: recommendations.slice(0, 10), // Limit recommendations
    progressInfo
  };
}

/**
 * Calculate progress information from todos
 */
function calculateProgress(todos: Todo[]): ProgressInfo {
  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const pending = todos.filter(t => t.status === 'pending').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const currentTodo = todos.find(t => t.status === 'in_progress');

  return {
    total,
    completed,
    pending,
    inProgress,
    percentage,
    currentTodo
  };
}