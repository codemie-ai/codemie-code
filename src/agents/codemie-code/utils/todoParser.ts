/**
 * Todo Parser Utility
 *
 * Handles parsing todos from multiple input formats:
 * - String with bullet lines: "- Plan\n- Search\n- Edit\n- Verify"
 * - List of strings: ["Plan the work", "Search repo", "Edit files", "Run tests"]
 * - List of objects: [{"content":"Plan", "status":"pending"}, {"content":"Search", "status":"in_progress"}]
 * - GitHub-style checkboxes: "- [ ] pending\n- [x] completed"
 *
 * Ported from langchain-code's planner.py with TypeScript improvements
 */

import type { Todo, TodoParseResult } from '../types.js';

// Valid status mappings and aliases
const ALLOWED_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const STATUS_ALIASES: Record<string, string> = {
  'in-progress': 'in_progress',
  'progress': 'in_progress',
  'doing': 'in_progress',
  'todo': 'pending',
  'tbd': 'pending',
  'done': 'completed',
  'complete': 'completed',
  'finished': 'completed',
};

// Regex for GitHub-style checkboxes: "- [x] Do thing" or "* [ ] Task" or "1) [x] Task"
const CHECKBOX_REGEX = /^\s*(?:[-*+]|\d+[.)])?\s*(\[[ xX]\])?\s*(.+)$/;

/**
 * Normalize a status string to a valid status
 */
function normalizeStatus(status: string | null | undefined): 'pending' | 'in_progress' | 'completed' {
  if (!status) return 'pending';

  const normalized = status.trim().toLowerCase();
  const mapped = STATUS_ALIASES[normalized] || normalized;

  return ALLOWED_STATUSES.has(mapped) ? mapped as any : 'pending';
}

/**
 * Parse a single todo item from various formats
 */
function parseOneTodo(item: any): Todo | null {
  if (item === null || item === undefined) {
    return null;
  }

  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return null;

    // Handle GitHub-style checkboxes: "- [x] Do thing" / "* [ ] Task"
    const match = CHECKBOX_REGEX.exec(trimmed);
    if (match) {
      const [, checkbox, content] = match;
      const cleanContent = (content || '').trim().replace(/^[-|*]+\s*/, '').trim();

      if (!cleanContent) return null;

      const status = (checkbox && checkbox.toLowerCase() === '[x]') ? 'completed' : 'pending';
      return {
        content: cleanContent,
        status,
        timestamp: new Date()
      };
    }

    // Handle plain bullet points: "- Task" or "* Task"
    const cleanContent = trimmed.replace(/^[-|*+]\s*/, '').trim();
    if (!cleanContent) return null;

    return {
      content: cleanContent,
      status: 'pending',
      timestamp: new Date()
    };
  }

  if (typeof item === 'object' && item !== null) {
    const content = item.content || item.task || item.title || '';
    const cleanContent = String(content).trim();

    if (!cleanContent) return null;

    return {
      content: cleanContent,
      status: normalizeStatus(item.status),
      timestamp: new Date(),
      metadata: item.metadata
    };
  }

  // Fallback: convert to string and try again
  return parseOneTodo(String(item));
}

/**
 * Parse todos from various input formats
 */
function parseTodoList(input: any): TodoParseResult {
  const todos: Todo[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let detectedFormat: TodoParseResult['detectedFormat'] = 'mixed';

  try {
    if (typeof input === 'string') {
      // Handle multi-line string input
      const lines = input.split('\n').filter(line => line.trim());
      detectedFormat = lines.some(line => CHECKBOX_REGEX.test(line)) ? 'github_checkboxes' : 'string_bullets';

      for (const line of lines) {
        const todo = parseOneTodo(line);
        if (todo) {
          todos.push(todo);
        }
      }
    } else if (Array.isArray(input)) {
      // Handle array input
      const hasObjects = input.some(item => typeof item === 'object' && item !== null);
      detectedFormat = hasObjects ? 'object_array' : 'string_array';

      for (const item of input) {
        const todo = parseOneTodo(item);
        if (todo) {
          todos.push(todo);
        }
      }
    } else if (typeof input === 'object' && input !== null && 'items' in input) {
      // Handle object with 'items' property
      detectedFormat = 'object_array';

      if (Array.isArray(input.items)) {
        for (const item of input.items) {
          const todo = parseOneTodo(item);
          if (todo) {
            todos.push(todo);
          }
        }
      }
    } else {
      // Single item
      const todo = parseOneTodo(input);
      if (todo) {
        todos.push(todo);
        detectedFormat = typeof input === 'object' ? 'object_array' : 'string_array';
      }
    }

    // Deduplicate consecutive duplicates by content
    const deduped: Todo[] = [];
    let lastContent: string | null = null;

    for (const todo of todos.slice(0, 50)) { // Limit to 50 items
      if (todo.content !== lastContent) {
        deduped.push({ ...todo, index: deduped.length });
        lastContent = todo.content;
      } else {
        warnings.push(`Duplicate todo removed: "${todo.content}"`);
      }
    }

    if (todos.length > 50) {
      warnings.push(`Todo list truncated to 50 items (was ${todos.length})`);
    }

    return {
      todos: deduped,
      errors,
      warnings,
      detectedFormat
    };

  } catch (error) {
    errors.push(`Failed to parse todos: ${error instanceof Error ? error.message : String(error)}`);

    return {
      todos: [],
      errors,
      warnings,
      detectedFormat: 'mixed'
    };
  }
}

/**
 * Enforce single in-progress rule
 * Only one todo can be "in_progress" at a time
 */
function enforceSingleInProgressRule(todos: Todo[], preferIndex?: number): Todo[] {
  const inProgressIndices = todos
    .map((todo, index) => ({ todo, index }))
    .filter(({ todo }) => todo.status === 'in_progress')
    .map(({ index }) => index);

  if (inProgressIndices.length <= 1) {
    return todos;
  }

  // Keep preferred index or first one, downgrade others to pending
  const keepIndex = preferIndex !== undefined ? preferIndex : inProgressIndices[0];

  return todos.map((todo, index) => {
    if (todo.status === 'in_progress' && index !== keepIndex) {
      return {
        ...todo,
        status: 'pending' as const,
        lastUpdated: new Date()
      };
    }
    return todo;
  });
}

/**
 * Validate sequential progression
 * Ensures todos are completed in order (no skipping ahead)
 */
function enforceSequentialProgression(todos: Todo[]): Todo[] {
  let blocked = false;

  return todos.map(todo => {
    const currentStatus = todo.status;

    // If we're blocked and this todo is in_progress or completed, downgrade to pending
    if (blocked && (currentStatus === 'in_progress' || currentStatus === 'completed')) {
      return {
        ...todo,
        status: 'pending' as const,
        lastUpdated: new Date()
      };
    }

    // If this todo is not completed, block future todos
    if (currentStatus !== 'completed') {
      blocked = true;
    }

    return todo;
  });
}

/**
 * Main parsing function with validation
 */
export function parseTodos(input: any, options: {
  enforceSequential?: boolean;
  enforceSingleInProgress?: boolean;
  preferredInProgressIndex?: number;
} = {}): TodoParseResult {
  const {
    enforceSequential = true,
    enforceSingleInProgress = true,
    preferredInProgressIndex
  } = options;

  let result = parseTodoList(input);

  if (result.todos.length === 0) {
    return result;
  }

  // Apply enforcement rules
  let processedTodos = result.todos;

  if (enforceSequential) {
    processedTodos = enforceSequentialProgression(processedTodos);
  }

  if (enforceSingleInProgress) {
    processedTodos = enforceSingleInProgressRule(processedTodos, preferredInProgressIndex);
  }

  // Update indices
  processedTodos = processedTodos.map((todo, index) => ({
    ...todo,
    index
  }));

  return {
    ...result,
    todos: processedTodos
  };
}

/**
 * Calculate progress information from todos
 */
export function calculateProgress(todos: Todo[]) {
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

/**
 * Generate diff between two todo states
 */
export function diffTodos(before: Todo[], after: Todo[]): string[] {
  const changes: string[] = [];
  const maxLength = Math.max(before.length, after.length);

  // Check status changes in existing todos
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const prevStatus = before[i]?.status || 'pending';
    const currStatus = after[i]?.status || 'pending';

    if (prevStatus !== currStatus) {
      const content = after[i]?.content || before[i]?.content || '(unknown)';
      changes.push(`[${i + 1}] ${content} -> ${currStatus}`);
    }
  }

  // Check for added todos
  if (after.length > before.length) {
    for (let i = before.length; i < after.length; i++) {
      const content = after[i]?.content || '(unknown)';
      changes.push(`[+] ${content} (added)`);
    }
  }

  // Check for removed todos
  if (before.length > after.length) {
    for (let i = after.length; i < before.length; i++) {
      const content = before[i]?.content || '(unknown)';
      changes.push(`[-] ${content} (removed)`);
    }
  }

  return changes;
}

/**
 * Mark all remaining todos as completed
 * Used when agent finishes work but forgot to update todos
 */
export function completeAllTodos(todos: Todo[]): Todo[] {
  return todos.map(todo => ({
    ...todo,
    status: todo.status === 'completed' ? 'completed' : 'completed' as const,
    lastUpdated: new Date()
  }));
}