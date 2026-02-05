/**
 * Unit tests for data fetcher
 * Tests data fetching logic for assistants selection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Assistant, CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';
import { createDataFetcher } from '../data.js';
import { PANEL_ID, API_SCOPE } from '../selection/constants.js';

// Mock logger
vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}));

describe('Data Fetcher', () => {
  let mockClient: CodeMieClient;
  let mockConfig: ProviderProfile;
  let mockOptions: SetupCommandOptions;

  beforeEach(() => {
    // Arrange: Setup mock client
    mockClient = {
      assistants: {
        listPaginated: vi.fn(),
        get: vi.fn(),
      }
    } as any;

    // Arrange: Setup mock config
    mockConfig = {
      codeMieProject: 'test-project',
      codemieAssistants: [
        {
          id: 'registered-1',
          name: 'Registered Assistant 1',
          description: 'First registered assistant',
          slug: 'registered-1',
          project: 'test-project'
        },
        {
          id: 'registered-2',
          name: 'Registered Assistant 2',
          description: 'Second registered assistant',
          slug: 'registered-2',
          project: 'test-project'
        }
      ]
    } as ProviderProfile;

    // Arrange: Setup mock options
    mockOptions = {} as SetupCommandOptions;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createDataFetcher', () => {
    it('should create data fetcher with required methods', () => {
      // Act
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Assert
      expect(fetcher).toBeDefined();
      expect(fetcher.fetchAssistants).toBeTypeOf('function');
      expect(fetcher.fetchAssistantsByIds).toBeTypeOf('function');
    });
  });

  describe('fetchAssistants - REGISTERED panel', () => {
    it('should fetch registered assistants from config', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED
      });

      // Assert
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.pages).toBe(1); // 2 items, 10 per page = 1 page
      expect(result.data[0].id).toBe('registered-1');
      expect(result.data[1].id).toBe('registered-2');
    });

    it('should return empty array when no registered assistants in config', async () => {
      // Arrange
      const emptyConfig = { ...mockConfig, codemieAssistants: [] } as ProviderProfile;
      const fetcher = createDataFetcher({
        config: emptyConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED
      });

      // Assert
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.pages).toBe(0);
    });

    it('should filter registered assistants by search query', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: 'First'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('registered-1');
      expect(result.data[0].name).toBe('Registered Assistant 1');
    });

    it('should filter registered assistants by description', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: 'Second'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('registered-2');
    });

    it('should be case-insensitive when filtering', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: 'FIRST'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('registered-1');
    });

    it('should filter by project field', async () => {
      // Arrange
      const configWithProjects = {
        ...mockConfig,
        codemieAssistants: [
          {
            id: 'asst-1',
            name: 'Assistant 1',
            description: 'Test',
            slug: 'asst-1',
            project: 'project-alpha'
          },
          {
            id: 'asst-2',
            name: 'Assistant 2',
            description: 'Test',
            slug: 'asst-2',
            project: 'project-beta'
          }
        ]
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithProjects,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: 'beta'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('asst-2');
    });

    it('should filter by slug field', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: 'registered-2'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('registered-2');
    });

    it('should calculate pages correctly for multiple pages', async () => {
      // Arrange: 25 assistants = 3 pages (10 per page)
      const manyAssistants = Array.from({ length: 25 }, (_, i) => ({
        id: `asst-${i}`,
        name: `Assistant ${i}`,
        description: 'Test',
        slug: `asst-${i}`,
        project: 'test'
      }));

      const configWithMany = {
        ...mockConfig,
        codemieAssistants: manyAssistants
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithMany,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        page: 0
      });

      // Assert - page 0 should return first 5 items (ITEMS_PER_PAGE = 5)
      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(25);
      expect(result.pages).toBe(5); // Math.ceil(25 / 5)
    });

    it('should paginate registered assistants correctly across pages', async () => {
      // Arrange - Create 12 assistants (should result in 3 pages with 5 per page)
      const assistants = Array.from({ length: 12 }, (_, i) => ({
        id: `asst-${i}`,
        name: `Assistant ${i}`,
        description: `Description ${i}`,
        slug: `assistant-${i}`,
        project: 'test-project'
      }));

      const configWithAssistants = {
        ...mockConfig,
        codemieAssistants: assistants
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithAssistants,
        client: mockClient,
        options: mockOptions
      });

      // Act & Assert - Page 0 (first 5 items)
      const page0 = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        page: 0
      });
      expect(page0.data).toHaveLength(5);
      expect(page0.data[0].id).toBe('asst-0');
      expect(page0.data[4].id).toBe('asst-4');
      expect(page0.total).toBe(12);
      expect(page0.pages).toBe(3); // Math.ceil(12 / 5)

      // Act & Assert - Page 1 (items 5-9)
      const page1 = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        page: 1
      });
      expect(page1.data).toHaveLength(5);
      expect(page1.data[0].id).toBe('asst-5');
      expect(page1.data[4].id).toBe('asst-9');
      expect(page1.total).toBe(12);
      expect(page1.pages).toBe(3);

      // Act & Assert - Page 2 (last 2 items)
      const page2 = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        page: 2
      });
      expect(page2.data).toHaveLength(2);
      expect(page2.data[0].id).toBe('asst-10');
      expect(page2.data[1].id).toBe('asst-11');
      expect(page2.total).toBe(12);
      expect(page2.pages).toBe(3);
    });
  });

  describe('fetchAssistants - PROJECT panel', () => {
    it('should fetch project assistants from API', async () => {
      // Arrange
      const mockResponse = {
        data: [
          { id: 'proj-1', name: 'Project Assistant 1' } as Assistant,
          { id: 'proj-2', name: 'Project Assistant 2' } as Assistant,
        ],
        pagination: {
          total: 2,
          pages: 1,
          page: 0
        }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.PROJECT,
        page: 0
      });

      // Assert
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.pages).toBe(1);
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 0,
          minimal_response: false,
          scope: 'visible_to_user',
          filters: expect.not.objectContaining({
            project: expect.anything()
          })
        })
      );
    });

    it('should include search query in API params', async () => {
      // Arrange
      const mockResponse = {
        data: [],
        pagination: { total: 0, pages: 0, page: 0 }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      await fetcher.fetchAssistants({
        scope: PANEL_ID.PROJECT,
        searchQuery: 'test query'
      });

      // Assert
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            search: 'test query'
          })
        })
      );
    });

    it('should trim search query whitespace', async () => {
      // Arrange
      const mockResponse = {
        data: [],
        pagination: { total: 0, pages: 0, page: 0 }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      await fetcher.fetchAssistants({
        scope: PANEL_ID.PROJECT,
        searchQuery: '  test query  '
      });

      // Assert
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            search: 'test query'
          })
        })
      );
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      const apiError = new Error('API connection failed');
      vi.mocked(mockClient.assistants.listPaginated).mockRejectedValue(apiError);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act & Assert
      await expect(
        fetcher.fetchAssistants({ scope: PANEL_ID.PROJECT })
      ).rejects.toThrow('API connection failed');
    });
  });

  describe('fetchAssistants - MARKETPLACE panel', () => {
    it('should fetch marketplace assistants from API', async () => {
      // Arrange
      const mockResponse = {
        data: [
          { id: 'market-1', name: 'Marketplace Assistant 1' } as Assistant,
          { id: 'market-2', name: 'Marketplace Assistant 2' } as Assistant,
        ],
        pagination: {
          total: 2,
          pages: 1,
          page: 0
        }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.MARKETPLACE
      });

      // Assert
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.pages).toBe(1);
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: API_SCOPE.MARKETPLACE,
          filters: expect.objectContaining({
            marketplace: null
          })
        })
      );
    });

    it('should not include project filter in marketplace scope', async () => {
      // Arrange
      const mockResponse = {
        data: [],
        pagination: { total: 0, pages: 0, page: 0 }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      await fetcher.fetchAssistants({
        scope: PANEL_ID.MARKETPLACE
      });

      // Assert
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.not.objectContaining({
            project: expect.anything()
          })
        })
      );
    });

    it('should handle pagination for marketplace', async () => {
      // Arrange
      const mockResponse = {
        data: Array.from({ length: 10 }, (_, i) => ({
          id: `market-${i}`,
          name: `Marketplace Assistant ${i}`
        } as Assistant)),
        pagination: {
          total: 50,
          pages: 5,
          page: 2
        }
      };

      vi.mocked(mockClient.assistants.listPaginated).mockResolvedValue(mockResponse);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.MARKETPLACE,
        page: 2
      });

      // Assert
      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(50);
      expect(result.pages).toBe(5);
      expect(mockClient.assistants.listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2
        })
      );
    });
  });

  describe('fetchAssistantsByIds', () => {
    it('should return existing assistants without API call', async () => {
      // Arrange
      const existingAssistants: Assistant[] = [
        { id: 'asst-1', name: 'Assistant 1' } as Assistant,
        { id: 'asst-2', name: 'Assistant 2' } as Assistant,
      ];

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds(
        ['asst-1', 'asst-2'],
        existingAssistants
      );

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('asst-1');
      expect(result[1].id).toBe('asst-2');
      expect(mockClient.assistants.get).not.toHaveBeenCalled();
    });

    it('should fetch missing assistants from API', async () => {
      // Arrange
      const existingAssistants: Assistant[] = [
        { id: 'asst-1', name: 'Assistant 1' } as Assistant,
      ];

      const newAssistant = { id: 'asst-2', name: 'Assistant 2' } as Assistant;
      vi.mocked(mockClient.assistants.get).mockResolvedValue(newAssistant);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds(
        ['asst-1', 'asst-2'],
        existingAssistants
      );

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('asst-1');
      expect(result[1].id).toBe('asst-2');
      expect(mockClient.assistants.get).toHaveBeenCalledWith('asst-2');
      expect(mockClient.assistants.get).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple missing assistants', async () => {
      // Arrange
      const existingAssistants: Assistant[] = [
        { id: 'asst-1', name: 'Assistant 1' } as Assistant,
      ];

      vi.mocked(mockClient.assistants.get)
        .mockResolvedValueOnce({ id: 'asst-2', name: 'Assistant 2' } as Assistant)
        .mockResolvedValueOnce({ id: 'asst-3', name: 'Assistant 3' } as Assistant);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds(
        ['asst-1', 'asst-2', 'asst-3'],
        existingAssistants
      );

      // Assert
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('asst-1');
      expect(result[1].id).toBe('asst-2');
      expect(result[2].id).toBe('asst-3');
      expect(mockClient.assistants.get).toHaveBeenCalledTimes(2);
    });

    it('should continue on API error for individual assistant', async () => {
      // Arrange
      const existingAssistants: Assistant[] = [
        { id: 'asst-1', name: 'Assistant 1' } as Assistant,
      ];

      vi.mocked(mockClient.assistants.get)
        .mockRejectedValueOnce(new Error('Assistant not found'))
        .mockResolvedValueOnce({ id: 'asst-3', name: 'Assistant 3' } as Assistant);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds(
        ['asst-1', 'asst-2', 'asst-3'],
        existingAssistants
      );

      // Assert: Should have asst-1 and asst-3, but not asst-2 (failed)
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('asst-1');
      expect(result[1].id).toBe('asst-3');
      expect(mockClient.assistants.get).toHaveBeenCalledTimes(2);
    });

    it('should handle empty selected IDs', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds([], []);

      // Assert
      expect(result).toHaveLength(0);
      expect(mockClient.assistants.get).not.toHaveBeenCalled();
    });

    it('should handle empty existing assistants', async () => {
      // Arrange
      const newAssistant = { id: 'asst-1', name: 'Assistant 1' } as Assistant;
      vi.mocked(mockClient.assistants.get).mockResolvedValue(newAssistant);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistantsByIds(['asst-1'], []);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('asst-1');
      expect(mockClient.assistants.get).toHaveBeenCalledWith('asst-1');
    });

    it('should preserve order of selected IDs', async () => {
      // Arrange
      const existingAssistants: Assistant[] = [
        { id: 'asst-3', name: 'Assistant 3' } as Assistant,
        { id: 'asst-1', name: 'Assistant 1' } as Assistant,
      ];

      vi.mocked(mockClient.assistants.get)
        .mockResolvedValue({ id: 'asst-2', name: 'Assistant 2' } as Assistant);

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act: Request in specific order
      const result = await fetcher.fetchAssistantsByIds(
        ['asst-1', 'asst-2', 'asst-3'],
        existingAssistants
      );

      // Assert: Should maintain requested order
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('asst-1');
      expect(result[1].id).toBe('asst-2');
      expect(result[2].id).toBe('asst-3');
    });
  });

  describe('Edge cases', () => {
    it('should handle assistants with missing optional fields', async () => {
      // Arrange
      const configWithMinimal = {
        ...mockConfig,
        codemieAssistants: [
          {
            id: 'minimal-1',
            name: 'Minimal Assistant',
            slug: 'minimal-1'
            // No description, no project
          }
        ]
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithMinimal,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].description).toBe('');
      expect(result.data[0].project).toBe('');
    });

    it('should handle empty search query', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: ''
      });

      // Assert: Should return all assistants
      expect(result.data).toHaveLength(2);
    });

    it('should handle whitespace-only search query', async () => {
      // Arrange
      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: '   '
      });

      // Assert: Should return all assistants
      expect(result.data).toHaveLength(2);
    });

    it('should handle special characters in search query', async () => {
      // Arrange
      const configWithSpecial = {
        ...mockConfig,
        codemieAssistants: [
          {
            id: 'special-1',
            name: 'Assistant (v2.0)',
            description: 'Test [beta]',
            slug: 'special-1',
            project: 'test'
          }
        ]
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithSpecial,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: '(v2.0)'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('special-1');
    });

    it('should handle unicode characters in search query', async () => {
      // Arrange
      const configWithUnicode = {
        ...mockConfig,
        codemieAssistants: [
          {
            id: 'unicode-1',
            name: '助理 Assistant',
            description: 'Unicode test',
            slug: 'unicode-1',
            project: 'test'
          }
        ]
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithUnicode,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED,
        searchQuery: '助理'
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('unicode-1');
    });

    it('should handle very long assistant names', async () => {
      // Arrange
      const longName = 'A'.repeat(500);
      const configWithLong = {
        ...mockConfig,
        codemieAssistants: [
          {
            id: 'long-1',
            name: longName,
            description: 'Test',
            slug: 'long-1',
            project: 'test'
          }
        ]
      } as ProviderProfile;

      const fetcher = createDataFetcher({
        config: configWithLong,
        client: mockClient,
        options: mockOptions
      });

      // Act
      const result = await fetcher.fetchAssistants({
        scope: PANEL_ID.REGISTERED
      });

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe(longName);
    });

    it('should handle non-Error thrown from API', async () => {
      // Arrange
      vi.mocked(mockClient.assistants.listPaginated).mockRejectedValue('String error');

      const fetcher = createDataFetcher({
        config: mockConfig,
        client: mockClient,
        options: mockOptions
      });

      // Act & Assert
      await expect(
        fetcher.fetchAssistants({ scope: PANEL_ID.PROJECT })
      ).rejects.toThrow('Failed to fetch project assistants: String error');
    });
  });
});
