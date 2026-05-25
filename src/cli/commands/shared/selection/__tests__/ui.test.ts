import { describe, expect, it, vi } from 'vitest';
import {
  buildSelectionDetailLine,
  buildSelectionRow,
  buildSingleChoiceRow,
} from '../ui.js';

vi.mock('chalk', () => ({
  default: {
    dim: (str: string) => `[dim]${str}[/dim]`,
    white: (str: string) => `[white]${str}[/white]`,
    cyan: (str: string) => `[cyan]${str}[/cyan]`,
    yellow: (str: string) => `[yellow]${str}[/yellow]`,
    red: (str: string) => `[red]${str}[/red]`,
    black: (str: string) => `[black]${str}[/black]`,
    bold: (str: string) => `[bold]${str}[/bold]`,
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

describe('shared selection UI row helpers', () => {
  it('keeps selection rows aligned across cursor and selected states', () => {
    const cursorSelected = buildSelectionRow({
      label: 'Alpha',
      isCursor: true,
      isSelected: true,
    });
    const noCursorSelected = buildSelectionRow({
      label: 'Alpha',
      isCursor: false,
      isSelected: true,
    });
    const cursorUnselected = buildSelectionRow({
      label: 'Alpha',
      isCursor: true,
      isSelected: false,
    });
    const noCursorUnselected = buildSelectionRow({
      label: 'Alpha',
      isCursor: false,
      isSelected: false,
    });

    expect(cursorSelected).toContain('[purple]› [/purple][purple]◉[/purple] [purple][bold]Alpha[/bold][/purple]');
    expect(noCursorSelected).toContain('  [purple]◉[/purple] Alpha');
    expect(cursorUnselected).toContain('[purple]› [/purple]◯ [purple][bold]Alpha[/bold][/purple]');
    expect(noCursorUnselected).toContain('  ◯ Alpha');
  });

  it('indents detail lines under the item label', () => {
    expect(buildSelectionDetailLine('Description')).toBe('[dim]    Description[/dim]');
  });

  it('keeps single-choice rows aligned across cursor and selected states', () => {
    const cursorSelected = buildSingleChoiceRow({
      label: 'Global',
      isCursor: true,
      isSelected: true,
    });
    const noCursorUnselected = buildSingleChoiceRow({
      label: 'Local',
      isCursor: false,
      isSelected: false,
    });

    expect(cursorSelected).toContain('[purple]› [/purple][purple]●[/purple] [purple][bold]Global[/bold][/purple]');
    expect(noCursorUnselected).toContain('  ○ Local');
  });
});
