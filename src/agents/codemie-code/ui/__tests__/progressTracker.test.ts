/**
 * Tests for ProgressTracker
 * 
 * Verifies progress tracking, todo updates, and visual feedback functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProgressTracker, getProgressTracker, resetProgressTracker } from '../progressTracker.js';
import type { Todo, TodoUpdateEvent } from '../../types.js';

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    // Create a fresh tracker for each test
    tracker = new ProgressTracker({
      realTimeUpdates: false,
      showCelebrations: false
    });
  });

  afterEach(() => {
    tracker.stop();
  });

  describe('initialization', () => {
    it('should create a tracker with default config', () => {
      const defaultTracker = new ProgressTracker();
      expect(defaultTracker).toBeDefined();
      expect(defaultTracker.isActive()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const customTracker = new ProgressTracker({
        realTimeUpdates: false,
        showCelebrations: false,
        compact: true
      });
      expect(customTracker).toBeDefined();
    });
  });

  describe('start() and stop()', () => {
    it('should start tracking with empty todos', () => {
      tracker.start([]);
      expect(tracker.isActive()).toBe(true);
      expect(tracker.getCurrentTodos()).toEqual([]);
    });

    it('should start tracking with initial todos', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      expect(tracker.isActive()).toBe(true);
      expect(tracker.getCurrentTodos()).toHaveLength(2);
    });

    it('should stop tracking when stop() is called', () => {
      tracker.start([]);
      expect(tracker.isActive()).toBe(true);
      
      tracker.stop();
      expect(tracker.isActive()).toBe(false);
    });

    it('should restart tracking if called multiple times', () => {
      const todos1: Todo[] = [{ content: 'Task 1', status: 'pending', timestamp: new Date() }];
      const todos2: Todo[] = [
        { content: 'Task A', status: 'pending', timestamp: new Date() },
        { content: 'Task B', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos1);
      expect(tracker.getCurrentTodos()).toHaveLength(1);
      
      tracker.start(todos2);
      expect(tracker.getCurrentTodos()).toHaveLength(2);
    });
  });

  describe('updateTodos()', () => {
    it('should update todos when tracking is active', () => {
      const initialTodos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(initialTodos);
      
      const updatedTodos: Todo[] = [
        { content: 'Task 1', status: 'in_progress', timestamp: new Date() }
      ];
      
      tracker.updateTodos(updatedTodos);
      expect(tracker.getCurrentTodos()[0].status).toBe('in_progress');
    });

    it('should not update todos when tracking is inactive', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.updateTodos(todos);
      expect(tracker.getCurrentTodos()).toEqual([]);
    });

    it('should handle todo creation event', () => {
      tracker.start([]);
      
      const todos: Todo[] = [
        { content: 'New Task', status: 'pending', timestamp: new Date() }
      ];
      
      const event: TodoUpdateEvent = {
        type: 'todo_update',
        todos,
        changeType: 'create',
        timestamp: new Date()
      };
      
      tracker.updateTodos(todos, event);
      expect(tracker.getCurrentTodos()).toHaveLength(1);
    });

    it('should handle todo status update event', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      
      const updatedTodos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() }
      ];
      
      const event: TodoUpdateEvent = {
        type: 'todo_update',
        todos: updatedTodos,
        changedIndex: 0,
        changeType: 'update',
        timestamp: new Date()
      };
      
      tracker.updateTodos(updatedTodos, event);
      expect(tracker.getCurrentTodos()[0].status).toBe('completed');
    });

    it('should suppress visual feedback when requested', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      
      const updatedTodos: Todo[] = [
        { content: 'Task 1', status: 'in_progress', timestamp: new Date() }
      ];
      
      const event: TodoUpdateEvent = {
        type: 'todo_update',
        todos: updatedTodos,
        changedIndex: 0,
        changeType: 'update',
        timestamp: new Date()
      };
      
      // Should not throw error even with visual feedback suppressed
      expect(() => {
        tracker.updateTodos(updatedTodos, event, true);
      }).not.toThrow();
    });
  });

  describe('getCurrentProgress()', () => {
    it('should return null when no todos exist', () => {
      tracker.start([]);
      const progress = tracker.getCurrentProgress();
      
      expect(progress).toEqual({
        total: 0,
        completed: 0,
        pending: 0,
        inProgress: 0,
        percentage: 0,
        currentTodo: undefined
      });
    });

    it('should calculate progress correctly', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() },
        { content: 'Task 3', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      const progress = tracker.getCurrentProgress();
      
      expect(progress).toMatchObject({
        total: 3,
        completed: 1,
        pending: 1,
        inProgress: 1,
        percentage: 33
      });
      expect(progress?.currentTodo?.content).toBe('Task 2');
    });

    it('should calculate 100% when all todos are completed', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'completed', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      const progress = tracker.getCurrentProgress();
      
      expect(progress?.percentage).toBe(100);
      expect(progress?.completed).toBe(2);
      expect(progress?.currentTodo).toBeUndefined();
    });
  });

  describe('getCurrentTodos()', () => {
    it('should return a copy of todos array', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      const retrieved = tracker.getCurrentTodos();
      
      // Modify retrieved array
      retrieved.push({ content: 'Task 2', status: 'pending', timestamp: new Date() });
      
      // Original should be unchanged
      expect(tracker.getCurrentTodos()).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty todo list', () => {
      tracker.start([]);
      expect(tracker.getCurrentTodos()).toEqual([]);
      expect(tracker.getCurrentProgress()?.total).toBe(0);
    });

    it('should handle single todo', () => {
      const todos: Todo[] = [
        { content: 'Only Task', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      expect(tracker.getCurrentTodos()).toHaveLength(1);
      expect(tracker.getCurrentProgress()?.total).toBe(1);
    });

    it('should handle rapid status changes', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      
      // Rapid updates
      tracker.updateTodos([{ ...todos[0], status: 'in_progress' }]);
      tracker.updateTodos([{ ...todos[0], status: 'completed' }]);
      tracker.updateTodos([{ ...todos[0], status: 'pending' }]);
      
      expect(tracker.getCurrentTodos()[0].status).toBe('pending');
    });

    it('should handle multiple in_progress todos (should be enforced elsewhere)', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'in_progress', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      const progress = tracker.getCurrentProgress();
      
      // ProgressTracker should still track them (enforcement is in todoParser)
      expect(progress?.inProgress).toBe(2);
    });

    it('should handle todos with missing timestamps', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' } as Todo
      ];
      
      expect(() => {
        tracker.start(todos);
      }).not.toThrow();
    });

    it('should handle todos with metadata', () => {
      const todos: Todo[] = [
        {
          content: 'Task 1',
          status: 'pending',
          timestamp: new Date(),
          metadata: { priority: 'high', tags: ['important'] }
        }
      ];
      
      tracker.start(todos);
      expect(tracker.getCurrentTodos()[0].metadata).toEqual({
        priority: 'high',
        tags: ['important']
      });
    });
  });

  describe('global tracker functions', () => {
    afterEach(() => {
      resetProgressTracker();
    });

    it('should return singleton instance', () => {
      const tracker1 = getProgressTracker();
      const tracker2 = getProgressTracker();
      
      expect(tracker1).toBe(tracker2);
    });

    it('should reset global tracker', () => {
      const tracker1 = getProgressTracker();
      tracker1.start([{ content: 'Task', status: 'pending', timestamp: new Date() }]);
      
      resetProgressTracker();
      
      const tracker2 = getProgressTracker();
      expect(tracker2).not.toBe(tracker1);
    });

    it('should stop tracking when reset', () => {
      const tracker = getProgressTracker();
      tracker.start([]);
      
      expect(tracker.isActive()).toBe(true);
      
      resetProgressTracker();
      
      // Old tracker should be stopped
      expect(tracker.isActive()).toBe(false);
    });
  });

  describe('progress change detection', () => {
    it('should detect when progress changes', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      const initialProgress = tracker.getCurrentProgress();
      
      tracker.updateTodos([
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ]);
      
      const updatedProgress = tracker.getCurrentProgress();
      
      expect(updatedProgress?.completed).toBeGreaterThan(initialProgress?.completed || 0);
    });

    it('should not trigger celebrations when progress unchanged', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      tracker.start(todos);
      
      // Update with same status
      tracker.updateTodos([
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ]);
      
      // Should not throw or cause issues
      expect(tracker.getCurrentProgress()?.percentage).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle malformed todos gracefully', () => {
      const malformedTodos = [
        { content: '', status: 'pending', timestamp: new Date() },
        { content: 'Valid Task', status: 'invalid_status', timestamp: new Date() }
      ] as Todo[];
      
      expect(() => {
        tracker.start(malformedTodos);
      }).not.toThrow();
    });

    it('should handle null/undefined in todo updates', () => {
      tracker.start([]);
      
      expect(() => {
        tracker.updateTodos(null as any);
      }).not.toThrow();
    });
  });
});
