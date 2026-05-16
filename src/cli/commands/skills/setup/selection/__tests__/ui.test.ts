import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionState, PanelState } from '../types.js';
import { PANEL_ID } from '../constants.js';
import { renderUI } from '../ui.js';

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

describe('Skill selection UI', () => {
  let projectPanel: PanelState;
  let state: SelectionState;

  beforeEach(() => {
    projectPanel = {
      id: PANEL_ID.PROJECT,
      label: 'Project',
      isActive: true,
      data: [],
      filteredData: [
        {
          id: 'skill-1',
          name: 'Skill One',
          description: 'First skill',
        },
        {
          id: 'skill-2',
          name: 'Skill Two',
        },
      ] as any,
      isFetching: false,
      error: null,
      currentPage: 0,
      totalItems: 2,
      totalPages: 1,
    };

    state = {
      panels: [
        {
          id: PANEL_ID.REGISTERED,
          label: 'Registered',
          isActive: false,
          data: [],
          filteredData: [],
          isFetching: false,
          error: null,
          currentPage: 0,
          totalItems: 0,
          totalPages: 0,
        },
        projectPanel,
        {
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
        },
      ],
      activePanelId: PANEL_ID.PROJECT,
      searchQuery: '',
      selectedIds: new Set<string>(),
      registeredIds: new Set<string>(),
      registeredSkills: [],
      isSearchFocused: false,
      isPaginationFocused: null,
      areNavigationButtonsFocused: false,
      focusedButton: 'continue',
    };

    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      writable: true,
      configurable: true,
    });
  });

  it('aligns selected and unselected skill rows with stable gutters', () => {
    state.selectedIds.add('skill-1');

    const output = renderUI(state, 0);

    expect(output).toContain('[purple]› [/purple][purple]◉[/purple] [purple][bold]Skill One[/bold][/purple]');
    expect(output).toContain('  ◯ Skill Two');
  });

  it('indents skill descriptions under the item label', () => {
    const output = renderUI(state, 0);

    expect(output).toContain('[dim]    First skill[/dim]');
  });
});
