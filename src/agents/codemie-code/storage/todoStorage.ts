/**
 * Todo File Storage System
 *
 * Provides persistent storage for todos with both project-level and global backup storage
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Todo } from '../types.js';
import { getCodemiePath } from '../../../utils/paths.js';

export interface TodoStorageConfig {
  workingDirectory: string;
  enableGlobalBackup?: boolean;
  debug?: boolean;
}

export interface TodoStorageMetadata {
  version: string;
  projectPath: string;
  projectHash: string;
  lastModified: Date;
  sessionId: string;
}

export interface TodoFile {
  metadata: TodoStorageMetadata;
  todos: Todo[];
}

export class TodoFileStorage {
  private workingDirectory: string;
  private projectTodoPath: string;
  private globalBackupDir: string;
  private projectHash: string;
  private sessionId: string;
  private enableGlobalBackup: boolean;
  private debug: boolean;

  constructor(config: TodoStorageConfig) {
    this.workingDirectory = config.workingDirectory;
    this.enableGlobalBackup = config.enableGlobalBackup ?? true;
    this.debug = config.debug ?? false;

    // Project-level storage path
    this.projectTodoPath = path.join(this.workingDirectory, '.codemie', 'todos.json');

    // Generate project hash for global storage
    this.projectHash = this.generateProjectHash(this.workingDirectory);

    // Global backup storage path
    this.globalBackupDir = getCodemiePath('todos');

    // Generate session ID
    this.sessionId = this.generateSessionId();

    if (this.debug) {
      console.log(`[TodoStorage] Project path: ${this.projectTodoPath}`);
      console.log(`[TodoStorage] Global backup: ${this.globalBackupDir}`);
      console.log(`[TodoStorage] Project hash: ${this.projectHash}`);
    }
  }

  /**
   * Generate a hash for the project path to use as filename
   */
  private generateProjectHash(projectPath: string): string {
    return crypto.createHash('md5').update(projectPath).digest('hex').substring(0, 12);
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Save todos to both project and global storage
   */
  async saveTodos(todos: Todo[]): Promise<void> {
    const todoFile: TodoFile = {
      metadata: {
        version: '1.0.0',
        projectPath: this.workingDirectory,
        projectHash: this.projectHash,
        lastModified: new Date(),
        sessionId: this.sessionId
      },
      todos: todos
    };

    try {
      // Save to project-level storage
      await this.saveToProject(todoFile);

      // Save to global backup if enabled
      if (this.enableGlobalBackup) {
        await this.saveToGlobalBackup(todoFile);
      }

      if (this.debug) {
        console.log(`[TodoStorage] Saved ${todos.length} todos successfully`);
      }
    } catch (error) {
      console.error('[TodoStorage] Failed to save todos:', error);
      throw new Error(`Failed to save todos: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load todos from project storage (with global backup fallback)
   */
  async loadTodos(): Promise<Todo[]> {
    try {
      // Try project-level storage first
      const projectTodos = await this.loadFromProject();
      if (projectTodos.length > 0) {
        if (this.debug) {
          console.log(`[TodoStorage] Loaded ${projectTodos.length} todos from project storage`);
        }
        return projectTodos;
      }

      // Fallback to global backup
      if (this.enableGlobalBackup) {
        const globalTodos = await this.loadFromGlobalBackup();
        if (globalTodos.length > 0) {
          if (this.debug) {
            console.log(`[TodoStorage] Loaded ${globalTodos.length} todos from global backup`);
          }
          return globalTodos;
        }
      }

      if (this.debug) {
        console.log('[TodoStorage] No existing todos found, starting fresh');
      }
      return [];

    } catch (error) {
      console.warn('[TodoStorage] Failed to load todos:', error);
      return [];
    }
  }

  /**
   * Save to project-level storage (.codemie/todos.json)
   */
  private async saveToProject(todoFile: TodoFile): Promise<void> {
    const projectDir = path.dirname(this.projectTodoPath);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(this.projectTodoPath, JSON.stringify(todoFile, null, 2), 'utf-8');
  }

  /**
   * Save to global backup storage (~/.codemie/todos/{hash}.json)
   */
  private async saveToGlobalBackup(todoFile: TodoFile): Promise<void> {
    await fs.mkdir(this.globalBackupDir, { recursive: true });

    const globalTodoPath = path.join(this.globalBackupDir, `${this.projectHash}.json`);
    await fs.writeFile(globalTodoPath, JSON.stringify(todoFile, null, 2), 'utf-8');

    // Also save a timestamped backup
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backupPath = path.join(this.globalBackupDir, 'history', `${this.projectHash}-${timestamp}.json`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, JSON.stringify(todoFile, null, 2), 'utf-8');
  }

  /**
   * Load from project-level storage
   */
  private async loadFromProject(): Promise<Todo[]> {
    try {
      const content = await fs.readFile(this.projectTodoPath, 'utf-8');
      const todoFile: TodoFile = JSON.parse(content);

      // Validate the structure
      if (!todoFile.todos || !Array.isArray(todoFile.todos)) {
        console.warn('[TodoStorage] Invalid project todo file structure');
        return [];
      }

      return todoFile.todos;
    } catch {
      // File doesn't exist or is invalid
      return [];
    }
  }

  /**
   * Load from global backup storage
   */
  private async loadFromGlobalBackup(): Promise<Todo[]> {
    try {
      const globalTodoPath = path.join(this.globalBackupDir, `${this.projectHash}.json`);
      const content = await fs.readFile(globalTodoPath, 'utf-8');
      const todoFile: TodoFile = JSON.parse(content);

      // Validate the structure and project match
      if (!todoFile.todos || !Array.isArray(todoFile.todos)) {
        console.warn('[TodoStorage] Invalid global todo file structure');
        return [];
      }

      if (todoFile.metadata.projectHash !== this.projectHash) {
        console.warn('[TodoStorage] Project hash mismatch in global backup');
        return [];
      }

      return todoFile.todos;
    } catch {
      // File doesn't exist or is invalid
      return [];
    }
  }

  /**
   * Clear todos from both storages
   */
  async clearTodos(): Promise<void> {
    try {
      // Clear project storage
      await this.saveToProject({
        metadata: {
          version: '1.0.0',
          projectPath: this.workingDirectory,
          projectHash: this.projectHash,
          lastModified: new Date(),
          sessionId: this.sessionId
        },
        todos: []
      });

      // Clear global backup
      if (this.enableGlobalBackup) {
        await this.saveToGlobalBackup({
          metadata: {
            version: '1.0.0',
            projectPath: this.workingDirectory,
            projectHash: this.projectHash,
            lastModified: new Date(),
            sessionId: this.sessionId
          },
          todos: []
        });
      }

      if (this.debug) {
        console.log('[TodoStorage] Cleared todos successfully');
      }
    } catch (error) {
      console.error('[TodoStorage] Failed to clear todos:', error);
      throw new Error(`Failed to clear todos: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get storage information
   */
  getStorageInfo(): {
    projectPath: string;
    globalBackupPath: string;
    projectHash: string;
    sessionId: string;
  } {
    return {
      projectPath: this.projectTodoPath,
      globalBackupPath: path.join(this.globalBackupDir, `${this.projectHash}.json`),
      projectHash: this.projectHash,
      sessionId: this.sessionId
    };
  }
}