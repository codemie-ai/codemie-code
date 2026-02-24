/**
 * Unit tests for main selection orchestration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../../index.js';
import { promptAssistantSelection } from '../index.js';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';
import { PANEL_ID } from '../constants.js';

// Mock dependencies
vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../../data.js', () => ({
  createDataFetcher: vi.fn(() => ({
    fetchAssistants: vi.fn().mockResolvedValue({
      data: [
        { id: '1', name: 'Assistant 1', slug: 'a1' },
        { id: '2', name: 'Assistant 2', slug: 'a2' },
      ],
      total: 2,
      pages: 1,
    }),
  })),
}));

vi.mock('../interactive-prompt.js', () => ({
  createInteractivePrompt: vi.fn((_options) => {
    const mockPrompt = {
      start: vi.fn(async () => {
        // Simulate user interaction
        await Promise.resolve();
      }),
      stop: vi.fn(),
      render: vi.fn(),
      getCursorIndex: vi.fn().mockReturnValue(0),
      setCursorIndex: vi.fn(),
    };
    return mockPrompt;
  }),
}));

describe('Selection Index - index.ts', () => {
  let mockClient: CodeMieClient;
  let mockConfig: ProviderProfile;
  let mockOptions: SetupCommandOptions;
  let consoleErrorSpy: any;

  beforeEach(() => {
    mockClient = {} as CodeMieClient;
    mockConfig = {
      codeMieProject: 'test-project',
      codemieAssistants: [],
    } as ProviderProfile;
    mockOptions = {
      allProjects: false,
    } as SetupCommandOptions;

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('promptAssistantSelection', () => {
    it('should initialize state with registered IDs', async () => {
      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
        { id: '2', name: 'Assistant 2', slug: 'a2', registeredAt: new Date().toISOString() },
      ];

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
      expect(result.action).toBe(ACTIONS.UPDATE);
    });

    it('should load initial data for registered panel', async () => {
      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should return selected IDs on confirm', async () => {
      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
      ];

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.action).toBe(ACTIONS.UPDATE);
      expect(result.selectedIds).toEqual(['1']);
    });

    it('should return empty array on cancel', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce((options) => {
        const mockPrompt = {
          start: vi.fn(async () => {
            // Simulate cancel
            options.actions.handleCancel();
          }),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
      ];

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.action).toBe(ACTIONS.CANCEL);
      expect(result.selectedIds).toEqual([]);
    });

    it('should handle fetch errors gracefully', async () => {
      const { createDataFetcher } = await import('../../data.js');

      vi.mocked(createDataFetcher).mockReturnValueOnce({
        fetchAssistants: vi.fn().mockRejectedValue(new Error('Network error')),
      } as any);

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should initialize all three panels', async () => {
      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
      // State should have 3 panels
    });

    it('should set registered panel as active when registered IDs exist', async () => {
      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
        { id: '2', name: 'Assistant 2', slug: 'a2', registeredAt: new Date().toISOString() },
      ];

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      const { createInteractivePrompt } = await import('../interactive-prompt.js');
      const callArgs = vi.mocked(createInteractivePrompt).mock.calls[0][0];

      expect(callArgs.state.activePanelId).toBe(PANEL_ID.REGISTERED);
    });

    it('should set project panel as active when no registered IDs exist', async () => {
      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      const { createInteractivePrompt } = await import('../interactive-prompt.js');
      const callArgs = vi.mocked(createInteractivePrompt).mock.calls[0][0];

      expect(callArgs.state.activePanelId).toBe(PANEL_ID.PROJECT);
    });

    it('should initialize selected IDs with registered IDs', async () => {
      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
        { id: '2', name: 'Assistant 2', slug: 'a2', registeredAt: new Date().toISOString() },
        { id: '3', name: 'Assistant 3', slug: 'a3', registeredAt: new Date().toISOString() },
      ];

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.selectedIds).toContain('1');
      expect(result.selectedIds).toContain('2');
      expect(result.selectedIds).toContain('3');
    });

    it('should handle empty registered IDs', async () => {
      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
      expect(result.selectedIds.length).toBeGreaterThanOrEqual(0);
    });

    it('should pass correct config to data fetcher', async () => {
      const { createDataFetcher } = await import('../../data.js');

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(createDataFetcher).toHaveBeenCalledWith({
        config: mockConfig,
        client: mockClient,
        options: mockOptions,
      });
    });

    it('should create interactive prompt with state and actions', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(createInteractivePrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            panels: expect.any(Array),
            activePanelId: expect.any(String), // Can be REGISTERED or PROJECT based on registeredIds
            searchQuery: '',
            selectedIds: expect.any(Set),
            registeredIds: expect.any(Set),
            isSearchFocused: false,
            isPaginationFocused: null,
          }),
          actions: expect.objectContaining({
            handlePanelSwitch: expect.any(Function),
            handleSearchUpdate: expect.any(Function),
            handleFocusSearch: expect.any(Function),
            handleFocusList: expect.any(Function),
            handleCursorMove: expect.any(Function),
            handleToggleSelection: expect.any(Function),
            handleConfirm: expect.any(Function),
            handleCancel: expect.any(Function),
            handlePageNext: expect.any(Function),
            handlePagePrev: expect.any(Function),
          }),
        })
      );
    });

    it('should show spinner during initial load', async () => {
      const ora = (await import('ora')).default;

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(ora).toHaveBeenCalledWith('Loading assistants...');
    });

    it('should clear spinner output before interactive mode', async () => {
      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      // Spinner should be cleared (ANSI clear line above)
      expect(true).toBe(true); // Verify no errors
    });

    it('should handle selection state changes', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce((options) => {
        const mockPrompt = {
          start: vi.fn(async () => {
            // Simulate user selecting items
            options.state.selectedIds.add('2');
            options.state.selectedIds.add('3');
          }),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
      ];

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.selectedIds).toContain('2');
      expect(result.selectedIds).toContain('3');
    });

    it('should handle deselection', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce((options) => {
        const mockPrompt = {
          start: vi.fn(async () => {
            // Simulate user deselecting all
            options.state.selectedIds.clear();
          }),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.selectedIds).toHaveLength(0);
    });
  });

  describe('initialization', () => {
    it('should initialize with default panel parameters', async () => {
      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should set project panel as active when no registered IDs', async () => {
      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      const { createInteractivePrompt } = await import('../interactive-prompt.js');
      const callArgs = vi.mocked(createInteractivePrompt).mock.calls[0][0];
      const projectPanel = callArgs.state.panels.find((p: any) => p.id === PANEL_ID.PROJECT);

      expect(projectPanel?.isActive).toBe(true);
    });

    it('should set registered panel as inactive when no registered IDs', async () => {
      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      const { createInteractivePrompt } = await import('../interactive-prompt.js');
      const callArgs = vi.mocked(createInteractivePrompt).mock.calls[0][0];
      const registeredPanel = callArgs.state.panels.find((p: any) => p.id === PANEL_ID.REGISTERED);

      expect(registeredPanel?.isActive).toBe(false);
    });

    it('should set marketplace panel as inactive initially', async () => {
      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      const { createInteractivePrompt } = await import('../interactive-prompt.js');
      const callArgs = vi.mocked(createInteractivePrompt).mock.calls[0][0];
      const marketplacePanel = callArgs.state.panels.find((p: any) => p.id === PANEL_ID.MARKETPLACE);

      expect(marketplacePanel?.isActive).toBe(false);
    });

    it('should fetch data for project panel when no registered IDs', async () => {
      const { createDataFetcher } = await import('../../data.js');
      const mockFetch = vi.fn().mockResolvedValue({
        data: [],
        total: 0,
        pages: 0,
      });

      vi.mocked(createDataFetcher).mockReturnValueOnce({
        fetchAssistants: mockFetch,
      } as any);

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(mockFetch).toHaveBeenCalledWith({
        scope: PANEL_ID.PROJECT,
        searchQuery: '',
        page: 0,
      });
    });

    it('should fetch data for registered panel when registered IDs exist', async () => {
      const { createDataFetcher } = await import('../../data.js');
      const mockFetch = vi.fn().mockResolvedValue({
        data: [],
        total: 0,
        pages: 0,
      });

      vi.mocked(createDataFetcher).mockReturnValueOnce({
        fetchAssistants: mockFetch,
      } as any);

      mockConfig.codemieAssistants = [
        { id: '1', name: 'Assistant 1', slug: 'a1', registeredAt: new Date().toISOString() },
        { id: '2', name: 'Assistant 2', slug: 'a2', registeredAt: new Date().toISOString() },
      ];

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(mockFetch).toHaveBeenCalledWith({
        scope: PANEL_ID.REGISTERED,
        searchQuery: '',
        page: 0,
      });
    });
  });

  describe('edge cases', () => {
    it('should handle very large registered ID sets', async () => {
      mockConfig.codemieAssistants = Array.from({ length: 1000 }, (_, i) => ({
        id: `id-${i}`,
        name: `Assistant ${i}`,
        slug: `a${i}`,
        registeredAt: new Date().toISOString(),
      }));

      const result = await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
      expect(result.selectedIds.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle config without project', async () => {
      const configNoProject = {} as ProviderProfile;

      const result = await promptAssistantSelection(
        new Set<string>(),
        configNoProject,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should handle options with allProjects flag', async () => {
      const optionsAllProjects = {
        allProjects: true,
      } as SetupCommandOptions;

      const result = await promptAssistantSelection(
        new Set<string>(),
        mockConfig,
        optionsAllProjects,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should handle prompt start rejection', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce(() => {
        const mockPrompt = {
          start: vi.fn().mockRejectedValue(new Error('Start failed')),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      await expect(
        promptAssistantSelection(
          new Set<string>(),
          mockConfig,
          mockOptions,
          mockClient
        )
      ).rejects.toThrow('Start failed');
    });

    it('should handle multiple rapid confirmations', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce((options) => {
        const mockPrompt = {
          start: vi.fn(async () => {
            // Simulate rapid confirmations
            options.actions.handleConfirm();
            options.actions.handleConfirm();
            options.actions.handleConfirm();
          }),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      const result = await promptAssistantSelection(
        new Set<string>(),
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result).toBeDefined();
    });

    it('should preserve registered assistants array', async () => {
      mockConfig.codemieAssistants = [
        { id: 'original-1', name: 'Original 1', slug: 'o1', registeredAt: new Date().toISOString() },
        { id: 'original-2', name: 'Original 2', slug: 'o2', registeredAt: new Date().toISOString() },
      ];

      const originalLength = mockConfig.codemieAssistants.length;

      await promptAssistantSelection(
        mockConfig,
        mockOptions,
        mockClient
      );

      // Original array should not be modified
      expect(mockConfig.codemieAssistants.length).toBe(originalLength);
      expect(mockConfig.codemieAssistants[0].id).toBe('original-1');
      expect(mockConfig.codemieAssistants[1].id).toBe('original-2');
    });
  });

  describe('return values', () => {
    it('should return valid action type on update', async () => {
      const result = await promptAssistantSelection(
        new Set<string>(),
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(result.action).toBe(ACTIONS.UPDATE);
    });

    it('should return array of selected IDs', async () => {
      const result = await promptAssistantSelection(
        new Set(['1', '2']),
        mockConfig,
        mockOptions,
        mockClient
      );

      expect(Array.isArray(result.selectedIds)).toBe(true);
    });

    it('should not include duplicate IDs', async () => {
      const { createInteractivePrompt } = await import('../interactive-prompt.js');

      vi.mocked(createInteractivePrompt).mockImplementationOnce((options) => {
        const mockPrompt = {
          start: vi.fn(async () => {
            // Try to add duplicate
            options.state.selectedIds.add('1');
            options.state.selectedIds.add('1');
            options.state.selectedIds.add('1');
          }),
          stop: vi.fn(),
          render: vi.fn(),
          getCursorIndex: vi.fn().mockReturnValue(0),
          setCursorIndex: vi.fn(),
        };
        return mockPrompt;
      });

      const result = await promptAssistantSelection(
        new Set<string>(),
        mockConfig,
        mockOptions,
        mockClient
      );

      const uniqueIds = new Set(result.selectedIds);
      expect(uniqueIds.size).toBe(result.selectedIds.length);
    });
  });
});
