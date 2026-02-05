/**
 * Unit tests for UI rendering functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SelectionState, PanelState } from '../types.js';
import { renderUI } from '../ui.js';
import { PANEL_ID } from '../constants.js';

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    dim: (str: string) => `[dim]${str}[/dim]`,
    white: (str: string) => `[white]${str}[/white]`,
    cyan: (str: string) => `[cyan]${str}[/cyan]`,
    yellow: (str: string) => `[yellow]${str}[/yellow]`,
    red: (str: string) => `[red]${str}[/red]`,
    black: (str: string) => `[black]${str}[/black]`,
    bold: vi.fn((str: string) => `[bold]${str}[/bold]`),
    bgRgb: vi.fn(() => ({
      black: (str: string) => `[bg-purple][black]${str}[/black][/bg-purple]`,
    })),
    rgb: vi.fn(() => {
      const fn = (str: string) => `[purple]${str}[/purple]`;
      fn.bold = (str: string) => `[purple][bold]${str}[/bold][/purple]`;
      return fn;
    }),
  },
}));

describe('Selection UI - ui.ts', () => {
  let mockState: SelectionState;
  let registeredPanel: PanelState;
  let projectPanel: PanelState;
  let marketplacePanel: PanelState;

  beforeEach(() => {
    // Setup mock panels
    registeredPanel = {
      id: PANEL_ID.REGISTERED,
      label: 'Registered',
      isActive: true,
      data: [],
      filteredData: [
        {
          id: '1',
          name: 'Assistant One',
          slug: 'assistant-one',
          description: 'First assistant',
        },
        {
          id: '2',
          name: 'Assistant Two',
          slug: 'assistant-two',
        },
      ],
      isFetching: false,
      error: null,
      currentPage: 0,
      totalItems: 2,
      totalPages: 1,
    };

    projectPanel = {
      id: PANEL_ID.PROJECT,
      label: 'Project',
      isActive: false,
      data: [],
      filteredData: [],
      isFetching: false,
      error: null,
      currentPage: 0,
      totalItems: 0,
      totalPages: 0,
    };

    marketplacePanel = {
      id: PANEL_ID.MARKETPLACE,
      label: 'Marketplace',
      isActive: false,
      data: [],
      filteredData: [],
      isFetching: false,
      error: null,
      currentPage: 0,
      totalItems: 0,
      totalPages: 0,
    };

    mockState = {
      panels: [registeredPanel, projectPanel, marketplacePanel],
      activePanelId: PANEL_ID.REGISTERED,
      searchQuery: '',
      selectedIds: new Set<string>(),
      registeredIds: new Set<string>(),
      isSearchFocused: false,
      isPaginationFocused: null,
    };

    // Mock process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      writable: true,
      configurable: true,
    });
  });

  describe('renderUI', () => {
    it('should render full UI with all components', () => {
      const result = renderUI(mockState, 0);

      expect(result).toContain('\x1b[H\x1b[J'); // Cursor home clear
      expect(result).toContain('Assistants'); // Label
      expect(result).toContain('Registered'); // Panel header
      expect(result).toContain('Assistant One'); // Assistant list
      expect(result).toContain('Search…'); // Search placeholder
    });

    it('should highlight active panel', () => {
      const result = renderUI(mockState, 0);

      expect(result).toContain('[bg-purple][black] Registered [/black][/bg-purple]');
      expect(result).toContain('[white]Project[/white]');
      expect(result).toContain('[white]Marketplace[/white]');
    });

    it('should show cursor on current item when not search focused', () => {
      mockState.isSearchFocused = false;
      const result = renderUI(mockState, 0);

      expect(result).toContain('› '); // Cursor indicator
    });

    it('should not show cursor when search is focused', () => {
      mockState.isSearchFocused = true;
      const result = renderUI(mockState, 0);

      // First item should not have cursor indicator
      const lines = result.split('\n');
      const assistantLines = lines.filter(line => line.includes('Assistant One'));
      expect(assistantLines.some(line => line.trim().startsWith('› '))).toBe(false);
    });

    it('should show selected assistants with filled circle', () => {
      mockState.selectedIds.add('1');
      const result = renderUI(mockState, 0);

      expect(result).toContain('◉'); // Filled circle
    });

    it('should show unselected assistants with empty circle', () => {
      const result = renderUI(mockState, 0);

      expect(result).toContain('◯'); // Empty circle
    });

    it('should show assistant descriptions', () => {
      const result = renderUI(mockState, 0);

      expect(result).toContain('First assistant');
    });

    it('should show search query with cursor when focused', () => {
      mockState.searchQuery = 'test';
      mockState.isSearchFocused = true;
      const result = renderUI(mockState, 0);

      expect(result).toContain('test');
      expect(result).toContain('█'); // Cursor block
    });

    it('should show search placeholder when empty and not focused', () => {
      mockState.searchQuery = '';
      mockState.isSearchFocused = false;
      const result = renderUI(mockState, 0);

      expect(result).toContain('[dim]Search…[/dim]');
    });

    it('should show count information', () => {
      const result = renderUI(mockState, 0);

      expect(result).toContain('[dim]2 assistants total, Page 1 of 1[/dim]');
    });

    it('should show loading state', () => {
      registeredPanel.isFetching = true;
      registeredPanel.filteredData = [];
      const result = renderUI(mockState, 0);

      expect(result).toContain('[cyan]Loading assistants...');
    });

    it('should show error state', () => {
      registeredPanel.error = 'Failed to load';
      registeredPanel.filteredData = [];
      const result = renderUI(mockState, 0);

      expect(result).toContain('[red]Error: Failed to load');
    });

    it('should show no assistants message when empty', () => {
      registeredPanel.filteredData = [];
      const result = renderUI(mockState, 0);

      expect(result).toContain('[yellow]No assistants found.');
    });

    it('should show pagination controls when multiple pages', () => {
      registeredPanel.totalPages = 3;
      registeredPanel.currentPage = 1;
      const result = renderUI(mockState, 0);

      expect(result).toContain('[< Prev]');
      expect(result).toContain('[Next >]');
    });

    it('should not show pagination controls when single page', () => {
      registeredPanel.totalPages = 1;
      const result = renderUI(mockState, 0);

      const paginationIndex = result.indexOf('Switch page:');
      expect(paginationIndex).toBe(-1);
    });

    it('should highlight pagination control when focused', () => {
      registeredPanel.totalPages = 2;
      mockState.isPaginationFocused = 'prev';
      const result = renderUI(mockState, 0);

      expect(result).toContain('[purple][bold][< Prev][/bold][/purple]');
    });

    it('should show different instructions with pagination', () => {
      registeredPanel.totalPages = 2;
      const result = renderUI(mockState, 0);

      expect(result).toContain('Ctrl+[/] to change page');
    });

    it('should show assistant project when available', () => {
      registeredPanel.filteredData = [
        {
          id: '1',
          name: 'Test',
          slug: 'test',
          project: { id: 'proj-1', name: 'My Project' },
        },
      ];
      const result = renderUI(mockState, 0);

      expect(result).toContain('My Project');
    });

    it('should show unique users count for marketplace panel', () => {
      marketplacePanel.isActive = true;
      marketplacePanel.filteredData = [
        {
          id: '1',
          name: 'Popular Assistant',
          slug: 'popular',
          unique_users_count: 42,
        },
      ];
      mockState.activePanelId = PANEL_ID.MARKETPLACE;
      const result = renderUI(mockState, 0);

      expect(result).toContain('⚭ 42 uses');
    });

    it('should truncate long descriptions', () => {
      registeredPanel.filteredData = [
        {
          id: '1',
          name: 'Test',
          slug: 'test',
          description: 'A'.repeat(100),
        },
      ];
      const result = renderUI(mockState, 0);

      expect(result).toContain('...');
      expect(result).not.toContain('A'.repeat(100));
    });

    it('should replace newlines in descriptions with spaces', () => {
      registeredPanel.filteredData = [
        {
          id: '1',
          name: 'Test',
          slug: 'test',
          description: 'Line 1\nLine 2\nLine 3',
        },
      ];
      const result = renderUI(mockState, 0);

      // Should not contain actual newlines in description
      const descriptionStart = result.indexOf('[dim]    Line 1');
      const descriptionEnd = result.indexOf('[/dim]', descriptionStart);
      const description = result.substring(descriptionStart, descriptionEnd);
      expect(description).not.toMatch(/\n/);
    });

    it('should handle terminal width correctly', () => {
      Object.defineProperty(process.stdout, 'columns', {
        value: 120,
        writable: true,
        configurable: true,
      });

      const result = renderUI(mockState, 0);

      // Top line should match terminal width
      expect(result).toContain('─'.repeat(120));
    });

    it('should handle narrow terminal width', () => {
      Object.defineProperty(process.stdout, 'columns', {
        value: 40,
        writable: true,
        configurable: true,
      });

      const result = renderUI(mockState, 0);

      expect(result).toContain('─'.repeat(40));
    });

    it('should default to 80 columns when stdout.columns is undefined', () => {
      Object.defineProperty(process.stdout, 'columns', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const result = renderUI(mockState, 0);

      expect(result).toContain('─'.repeat(80));
    });

    it('should handle cursor at last item', () => {
      const lastIndex = registeredPanel.filteredData.length - 1;
      const result = renderUI(mockState, lastIndex);

      expect(result).toContain('› ');
      expect(result).toContain('Assistant Two');
    });

    it('should handle empty registered set', () => {
      mockState.registeredIds = new Set<string>();
      const result = renderUI(mockState, 0);

      expect(result).toBeDefined();
    });

    it('should handle all assistants selected', () => {
      mockState.selectedIds = new Set(['1', '2']);
      const result = renderUI(mockState, 0);

      const filledCircles = (result.match(/◉/g) || []).length;
      expect(filledCircles).toBeGreaterThanOrEqual(2);
    });
  });

  describe('edge cases', () => {
    it('should handle assistants without names gracefully', () => {
      registeredPanel.filteredData = [
        {
          id: '1',
          name: '',
          slug: 'test',
        },
      ];
      const result = renderUI(mockState, 0);

      expect(result).toBeDefined();
    });

    it('should handle very long assistant names', () => {
      registeredPanel.filteredData = [
        {
          id: '1',
          name: 'A'.repeat(200),
          slug: 'test',
        },
      ];
      const result = renderUI(mockState, 0);

      expect(result).toContain('A'.repeat(200));
    });

    it('should handle zero total pages', () => {
      registeredPanel.totalPages = 0;
      registeredPanel.filteredData = [];
      const result = renderUI(mockState, 0);

      expect(result).toContain('[dim]0 assistants total, Page 1 of 1[/dim]');
    });

    it('should handle negative cursor index gracefully', () => {
      const result = renderUI(mockState, -1);

      expect(result).toBeDefined();
    });

    it('should handle cursor index beyond list length', () => {
      const result = renderUI(mockState, 999);

      expect(result).toBeDefined();
    });

    it('should handle panel with null data', () => {
      registeredPanel.data = null;
      const result = renderUI(mockState, 0);

      expect(result).toBeDefined();
    });

    it('should handle special characters in search query', () => {
      mockState.searchQuery = '!@#$%^&*()';
      mockState.isSearchFocused = true;
      const result = renderUI(mockState, 0);

      expect(result).toContain('!@#$%^&*()');
    });

    it('should handle unicode in search query', () => {
      mockState.searchQuery = '测试 🔍';
      mockState.isSearchFocused = true;
      const result = renderUI(mockState, 0);

      expect(result).toContain('测试 🔍');
    });
  });
});
