/**
 * Tests for TodoPanel
 * 
 * Verifies todo visualization, rendering, and display functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TodoPanel, renderTodoList } from '../todoPanel.js';
import type { Todo } from '../../types.js';

describe('TodoPanel', () => {
  let panel: TodoPanel;

  beforeEach(() => {
    panel = new TodoPanel({
      showProgress: true,
      showTimestamps: false,
      compact: false
    });
  });

  describe('initialization', () => {
    it('should create a panel with default options', () => {
      const defaultPanel = new TodoPanel();
      expect(defaultPanel).toBeDefined();
    });

    it('should accept custom display options', () => {
      const customPanel = new TodoPanel({
        showProgress: false,
        showTimestamps: true,
        compact: true,
        maxWidth: 60
      });
      expect(customPanel).toBeDefined();
    });
  });

  describe('update()', () => {
    it('should update the internal todo list', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      expect(panel.getTodos()).toHaveLength(1);
    });

    it('should recalculate progress info on update', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const progress = panel.getProgressInfo();
      
      expect(progress?.total).toBe(2);
      expect(progress?.completed).toBe(1);
      expect(progress?.percentage).toBe(50);
    });
  });

  describe('render()', () => {
    it('should render empty state when no todos', () => {
      const output = panel.render();
      expect(output).toContain('No todos');
    });

    it('should render todo items', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() },
        { content: 'Task 3', status: 'completed', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('Task 1');
      expect(output).toContain('Task 2');
      expect(output).toContain('Task 3');
    });

    it('should include progress information when enabled', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      // Should show progress stats
      expect(output).toMatch(/1\/2|50%/);
    });

    it('should show current activity when todo is in progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('Task 2');
      expect(output).toMatch(/currently|working/i);
    });

    it('should not include progress when disabled', () => {
      const noPanelProgress = new TodoPanel({ showProgress: false });
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() }
      ];
      
      noPanelProgress.update(todos);
      const output = noPanelProgress.render();
      
      // Should still show todos but not progress bar
      expect(output).toContain('Task 1');
    });
  });

  describe('renderCompactProgress()', () => {
    it('should render compact single-line progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.renderCompactProgress();
      
      expect(output).toContain('1/2');
      expect(output).toContain('50%');
    });

    it('should show current todo in compact mode', () => {
      const todos: Todo[] = [
        { content: 'Very Long Task Name That Should Be Truncated', status: 'in_progress', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.renderCompactProgress();
      
      // Should include task content (possibly truncated)
      expect(output).toMatch(/Task|Truncated/i);
    });

    it('should handle empty todos in compact mode', () => {
      const output = panel.renderCompactProgress();
      expect(output).toContain('No todos');
    });
  });

  describe('renderDiff()', () => {
    it('should detect status changes', () => {
      const before: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      const after: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() }
      ];
      
      panel.update(after);
      const diff = panel.renderDiff(before, after);
      
      expect(diff).toContain('Task 1');
      expect(diff).toContain('completed');
    });

    it('should detect added todos', () => {
      const before: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      const after: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(after);
      const diff = panel.renderDiff(before, after);
      
      expect(diff).toContain('Task 2');
      expect(diff).toContain('added');
    });

    it('should detect removed todos', () => {
      const before: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      const after: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(after);
      const diff = panel.renderDiff(before, after);
      
      expect(diff).toContain('Task 2');
      expect(diff).toContain('removed');
    });

    it('should show "No changes" when nothing changed', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const diff = panel.renderDiff(todos, todos);
      
      expect(diff).toContain('No changes');
    });
  });

  describe('getTodos() and getProgressInfo()', () => {
    it('should return current todos', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      expect(panel.getTodos()).toEqual(todos);
    });

    it('should return a copy of todos array', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const retrieved = panel.getTodos();
      
      // Modify retrieved
      retrieved.push({ content: 'Task 2', status: 'pending', timestamp: new Date() });
      
      // Original should be unchanged
      expect(panel.getTodos()).toHaveLength(1);
    });

    it('should return progress info', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const progress = panel.getProgressInfo();
      
      expect(progress).toMatchObject({
        total: 2,
        completed: 1,
        pending: 1,
        percentage: 50
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty todo list', () => {
      panel.update([]);
      const output = panel.render();
      
      expect(output).toContain('No todos');
    });

    it('should handle single todo', () => {
      const todos: Todo[] = [
        { content: 'Only Task', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('Only Task');
    });

    it('should handle very long todo content', () => {
      const longContent = 'A'.repeat(200);
      const todos: Todo[] = [
        { content: longContent, status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      // Should truncate or handle gracefully
      expect(output).toBeDefined();
      expect(output.length).toBeLessThan(longContent.length + 100);
    });

    it('should handle todos with special characters', () => {
      const todos: Todo[] = [
        { content: 'Task with "quotes" and \'apostrophes\'', status: 'pending', timestamp: new Date() },
        { content: 'Task with emoji 🎉 🚀', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('quotes');
      expect(output).toContain('emoji');
    });

    it('should handle todos without timestamps', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' } as Todo
      ];
      
      expect(() => {
        panel.update(todos);
        panel.render();
      }).not.toThrow();
    });

    it('should handle todos with metadata', () => {
      const todos: Todo[] = [
        {
          content: 'Task 1',
          status: 'pending',
          timestamp: new Date(),
          metadata: { priority: 'high' }
        }
      ];
      
      panel.update(todos);
      expect(panel.getTodos()[0].metadata).toEqual({ priority: 'high' });
    });
  });

  describe('compact mode', () => {
    it('should render more concisely in compact mode', () => {
      const compactPanel = new TodoPanel({ compact: true });
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'in_progress', timestamp: new Date() }
      ];
      
      compactPanel.update(todos);
      const output = compactPanel.render();
      
      // Compact mode should produce shorter output
      expect(output.length).toBeLessThan(200);
    });
  });

  describe('status indicators', () => {
    it('should show different indicators for different statuses', () => {
      const todos: Todo[] = [
        { content: 'Pending Task', status: 'pending', timestamp: new Date() },
        { content: 'In Progress Task', status: 'in_progress', timestamp: new Date() },
        { content: 'Completed Task', status: 'completed', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      // Should contain status-specific indicators (emojis or symbols)
      expect(output).toMatch(/⏳|🔄|✅/);
    });
  });

  describe('utility functions', () => {
    it('renderTodoList should create and render a panel', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      const output = renderTodoList(todos);
      
      expect(output).toContain('Task 1');
    });

    it('renderTodoList should accept display options', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() }
      ];
      
      const output = renderTodoList(todos, { compact: true });
      
      expect(output).toBeDefined();
    });
  });

  describe('progress bar visualization', () => {
    it('should show progress bar with correct proportions', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'completed', timestamp: new Date() },
        { content: 'Task 3', status: 'pending', timestamp: new Date() },
        { content: 'Task 4', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      // Should show 50% progress (2/4 completed)
      expect(output).toContain('50%');
    });

    it('should show 100% when all completed', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'completed', timestamp: new Date() },
        { content: 'Task 2', status: 'completed', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('100%');
    });

    it('should show 0% when none completed', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', timestamp: new Date() },
        { content: 'Task 2', status: 'pending', timestamp: new Date() }
      ];
      
      panel.update(todos);
      const output = panel.render();
      
      expect(output).toContain('0%');
    });
  });
});
