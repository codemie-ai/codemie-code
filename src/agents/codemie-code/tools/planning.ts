/**
 * Planning Tools for CodeMie Agent
 *
 * Implementation of to_do management tools with persistent file storage
 */

import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Todo, TodoUpdateEvent } from '../types.js';
import { TodoFileStorage } from '../storage/todoStorage.js';

// Global to_do state and storage for integration with plan mode
let globalTodos: Todo[] = [];
let eventCallbacks: Array<(event: TodoUpdateEvent) => void> = [];
let todoStorage: TodoFileStorage | null = null;

/**
 * Initialize to_do storage for the current working directory
 */
export function initializeTodoStorage(workingDirectory: string, debug = false): void {
  todoStorage = new TodoFileStorage({
    workingDirectory,
    enableGlobalBackup: true,
    debug
  });

  // Load existing todos on initialization
  todoStorage.loadTodos().then(todos => {
    globalTodos = todos;

    if (debug && todos.length > 0) {
      console.log(`[TodoStorage] Loaded ${todos.length} existing todos`);
    }

    // Emit loaded todos event
    if (todos.length > 0) {
      const todoEvent: TodoUpdateEvent = {
        type: 'todo_update',
        todos: todos,
        changeType: 'update',
        timestamp: new Date()
      };

      eventCallbacks.forEach(callback => {
        try {
          callback(todoEvent);
        } catch (error) {
          console.warn('[TodoStorage] Event callback error:', error);
        }
      });
    }
  }).catch(error => {
    console.warn('[TodoStorage] Failed to load initial todos:', error);
  });
}

/**
 * Simple Write Todos Tool
 */
export class WriteSimpleTodosTool extends StructuredTool {
  static readonly name = 'write_todos';
  name = WriteSimpleTodosTool.name;
  description = 'Create or update a structured todo list for planning and progress tracking';

  schema = z.object({
    todos: z.union([
      z.string(),
      z.array(z.string()),
      z.array(z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']).optional()
      }))
    ]).describe('The todo list in various supported formats')
  });

  async _call(input: { todos: any }): Promise<string> {
    try {
      // Simple parsing - convert any format to string array
      let todoItems: string[] = [];

      if (typeof input.todos === 'string') {
        // Handle string format
        todoItems = input.todos.split('\n')
          .filter(line => line.trim())
          .map(line => line.replace(/^[-*•]\s*/, '').trim())
          .filter(item => item);
      } else if (Array.isArray(input.todos)) {
        todoItems = input.todos.map(item =>
          typeof item === 'string' ? item : item.content || String(item)
        );
      }

      if (todoItems.length === 0) {
        return '❌ No valid todos found in input';
      }

      // Create proper Todo objects
      const todos: Todo[] = todoItems.map((content, index) => ({
        content: content.trim(),
        status: 'pending' as const,
        index,
        timestamp: new Date()
      }));

      // Store in global state
      globalTodos = todos;

      // Save to file storage
      if (todoStorage) {
        try {
          await todoStorage.saveTodos(todos);
        } catch (error) {
          console.warn('[write_todos] Failed to save to file:', error);
          // Continue execution - file save failure shouldn't break to_do creation
        }
      }

      // Emit to_do_update event for plan mode integration
      const todoEvent: TodoUpdateEvent = {
        type: 'todo_update',
        todos: todos,
        changeType: 'create',
        timestamp: new Date()
      };

      // Notify all callbacks (plan mode, UI, etc.)
      eventCallbacks.forEach(callback => {
        try {
          callback(todoEvent);
        } catch (error) {
          console.warn('[write_todos] Event callback error:', error);
        }
      });

      // Format response
      const response = `✅ **Todo List Created** (${todoItems.length} items)\n\n` +
        todoItems.map((item, i) => `${i + 1}. ${item}`).join('\n') +
        '\n\n🎯 **Status**: Ready for execution\n' +
        '💡 **Tip**: Use Ctrl+T to view todos during execution';

      return response;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return `❌ Error creating todos: ${errorMessage}`;
    }
  }
}

/**
 * Show Todos Tool with Storage Information
 */
export class ShowSimpleTodosTool extends StructuredTool {
  static readonly name = 'show_todos';
  name = ShowSimpleTodosTool.name;
  description = 'Display the current todo list with progress information and storage details';

  schema = z.object({});

  async _call(): Promise<string> {
    const todos = globalTodos;

    if (todos.length === 0) {
      return `📋 **Current Todo List**\n\n` +
             `No todos currently active.\n` +
             `Use the write_todos tool to create a structured plan.\n\n` +
             `💡 **Tip**: Start with write_todos to create your task list`;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;

    const statusIcon = (status: string) => {
      switch (status) {
        case 'completed': return '✅';
        case 'in_progress': return '🔄';
        case 'pending': return '⏳';
        default: return '○';
      }
    };

    let result = `📋 **Current Todo List** (${todos.length} items)\n\n`;

    todos.forEach((todo, i) => {
      result += `${statusIcon(todo.status)} ${i + 1}. ${todo.content}\n`;
    });

    result += `\n**Progress**: ${completed} completed, ${inProgress} in progress, ${pending} pending`;

    // Add storage information
    const storageInfo = TodoStateManager.getStorageInfo();
    if (storageInfo) {
      result += `\n\n📁 **Storage**: Project todos saved to .codemie/todos.json`;
      result += `\n🔄 **Backup**: Global backup at ~/.codemie/todos/${storageInfo.projectHash}.json`;
    }

    result += `\n💡 **Tip**: Use Ctrl+T to view todos in interactive mode`;

    return result;
  }
}

// Export the tools
export const planningTools = [
  new WriteSimpleTodosTool(),
  new ShowSimpleTodosTool()
];

// Also export individual tools for compatibility
export const writeTodos = new WriteSimpleTodosTool();
export const showTodos = new ShowSimpleTodosTool();

// To_do state manager for plan mode integration
export class TodoStateManager {
  static addEventCallback(callback: (event: TodoUpdateEvent) => void): void {
    eventCallbacks.push(callback);
  }

  static removeEventCallback(callback: (event: TodoUpdateEvent) => void): void {
    const index = eventCallbacks.indexOf(callback);
    if (index > -1) {
      eventCallbacks.splice(index, 1);
    }
  }

  static getCurrentTodos(): Todo[] {
    return [...globalTodos];
  }

  static async clearTodos(): Promise<void> {
    globalTodos = [];

    // Clear file storage
    if (todoStorage) {
      try {
        await todoStorage.clearTodos();
      } catch (error) {
        console.warn('[TodoStateManager] Failed to clear file storage:', error);
      }
    }

    // Emit clear event
    const todoEvent: TodoUpdateEvent = {
      type: 'todo_update',
      todos: [],
      changeType: 'delete',
      timestamp: new Date()
    };

    eventCallbacks.forEach(callback => {
      try {
        callback(todoEvent);
      } catch (error) {
        console.warn('[TodoStateManager] Event callback error:', error);
      }
    });
  }

  static getStorageInfo(): any {
    return todoStorage?.getStorageInfo() || null;
  }
}