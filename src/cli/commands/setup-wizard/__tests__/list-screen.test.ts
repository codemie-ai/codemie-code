/**
 * Unit tests for the wizard list screen (src/cli/commands/setup-wizard/list-screen.ts):
 * key handling and rendering, driven through the pure applyKey / renderListScreen.
 */

import { describe, it, expect, vi } from 'vitest';

// Identity chalk: styling calls return their text; color factories (rgb, bgRgb) return chalk again.
vi.mock('chalk', () => {
  const proxy: unknown = new Proxy(() => undefined, {
    get: () => proxy,
    apply: (_target, _this, args: unknown[]) => (typeof args[0] === 'string' ? args[0] : proxy),
  });
  return { default: proxy };
});

import { KEY } from '../../shared/selection/constants.js';
import { applyKey, createListScreenState, getVisibleRows, renderListScreen } from '../list-screen.js';
import type { ListRow, ListScreenSpec } from '../types.js';

const rows = (...ids: string[]): ListRow[] => ids.map(id => ({ id, label: id }));

function spec(overrides: Partial<ListScreenSpec> = {}): ListScreenSpec {
  return {
    stages: ['Agents', 'Claude Code', 'Review'],
    stageIndex: 1,
    title: 'Claude Code · Models',
    mode: 'multi',
    rows: rows('a', 'b', 'c'),
    selected: [],
    ...overrides,
  };
}

function press(state: ReturnType<typeof createListScreenState>, ...keys: string[]) {
  let outcome = applyKey(state, keys[0]);
  for (const key of keys.slice(1)) outcome = applyKey(state, key);
  return outcome;
}

describe('list screen — multi select', () => {
  it('toggles rows with Space and continues with the selection on Enter', () => {
    const state = createListScreenState(spec({ selected: ['c'] }));

    press(state, KEY.SPACE, KEY.ARROW_DOWN, KEY.SPACE);
    const outcome = press(state, KEY.ENTER);

    expect(outcome).toEqual({ type: 'done', result: { action: 'continue', selected: ['c', 'a', 'b'], added: [] } });
  });

  it('keeps only selectable preselected ids', () => {
    const state = createListScreenState(spec({
      rows: [...rows('a'), { id: 'x', label: 'x', disabled: 'nope' }],
      selected: ['a', 'x', 'gone'],
    }));

    expect(state.selected).toEqual(['a']);
  });

  it('blocks Continue with the validation error and shows it', () => {
    const state = createListScreenState(spec({ validate: s => (s.length ? undefined : 'Pick one') }));

    const outcome = press(state, KEY.ENTER);

    expect(outcome).toEqual({ type: 'render' });
    expect(renderListScreen(state)).toContain('Pick one');
  });

  it('refuses a disabled row, naming the reason', () => {
    const state = createListScreenState(spec({ rows: [{ id: 'codex', label: 'Codex', disabled: 'not supported by x' }] }));

    press(state, KEY.SPACE);

    expect(state.selected).toEqual([]);
    expect(state.error).toContain('not supported by x');
  });

  it('moves to the buttons past the last row, where Enter on Cancel cancels', () => {
    const state = createListScreenState(spec());

    press(state, KEY.ARROW_DOWN, KEY.ARROW_DOWN, KEY.ARROW_DOWN);
    expect(state.focus).toBe('buttons');
    const outcome = press(state, KEY.ARROW_RIGHT, KEY.ENTER);

    expect(outcome).toEqual({ type: 'done', result: { action: 'cancel' } });
  });

  it('goes back on Esc and cancels on Ctrl+C', () => {
    expect(press(createListScreenState(spec()), KEY.ESC)).toEqual({ type: 'done', result: { action: 'back' } });
    expect(press(createListScreenState(spec()), KEY.CTRL_C)).toEqual({ type: 'done', result: { action: 'cancel' } });
  });

  it('ends with the action id when an action row is chosen', () => {
    const state = createListScreenState(spec({
      rows: [...rows('a'), { id: '__search__', label: 'Search', kind: 'action' }],
      selected: ['a'],
    }));

    const outcome = press(state, KEY.ARROW_DOWN, KEY.ENTER);

    expect(outcome).toEqual({ type: 'done', result: { action: 'row', id: '__search__', selected: ['a'], added: [] } });
  });
});

describe('list screen — search and custom entries', () => {
  const custom = (query: string): ListRow => ({
    id: query,
    label: `+ Use "${query}"`,
    addAs: { id: query, label: `${query} · unverified` },
  });

  it('ignores typing on a screen that is not searchable', () => {
    const state = createListScreenState(spec());

    expect(press(state, 'a')).toEqual({ type: 'none' });
    expect(state.query).toBe('');
  });

  it('filters rows by the typed (or pasted) query', () => {
    const state = createListScreenState(spec({ searchable: true, rows: rows('gpt-5', 'claude-x', 'gpt-4') }));

    press(state, 'gp', 't');

    expect(getVisibleRows(state).rows.map(r => r.id)).toEqual(['gpt-5', 'gpt-4']);
  });

  it('offers a custom row first for a query matching no id exactly, and adds it on Enter', () => {
    const state = createListScreenState(spec({ searchable: true, rows: rows('gpt-5'), customRow: custom }));

    press(state, 'my-model');
    expect(getVisibleRows(state).rows[0].id).toBe('my-model');
    press(state, KEY.ENTER);

    expect(state.query).toBe('');
    expect(state.selected).toEqual(['my-model']);
    expect(state.added).toEqual(['my-model']);
    expect(state.rows.map(r => r.label)).toEqual(['gpt-5', 'my-model · unverified']);
  });

  it('offers no custom row when the query matches an id exactly', () => {
    const state = createListScreenState(spec({ searchable: true, rows: rows('gpt-5'), customRow: custom }));

    press(state, 'gpt-5');

    expect(getVisibleRows(state).customId).toBeUndefined();
  });

  it('clears the query on the first Esc and goes back on the second', () => {
    const state = createListScreenState(spec({ searchable: true }));

    press(state, 'x');
    expect(press(state, KEY.ESC)).toEqual({ type: 'render' });
    expect(state.query).toBe('');
    expect(press(state, KEY.ESC)).toEqual({ type: 'done', result: { action: 'back' } });
  });

  it('deletes the last query character on Backspace', () => {
    const state = createListScreenState(spec({ searchable: true }));

    press(state, 'ab', KEY.BACKSPACE);

    expect(state.query).toBe('a');
  });
});

describe('list screen — single select', () => {
  it('starts on the selected row and picks the row under the cursor on Enter', () => {
    const state = createListScreenState(spec({ mode: 'single', selected: ['b'] }));
    expect(state.cursor).toBe(1);

    const outcome = press(state, KEY.ARROW_DOWN, KEY.ENTER);

    expect(outcome).toEqual({ type: 'done', result: { action: 'continue', selected: ['c'], added: [] } });
  });

  it('focuses the buttons when there are no rows (review screen)', () => {
    const state = createListScreenState(spec({ mode: 'single', rows: [] }));

    expect(state.focus).toBe('buttons');
    expect(press(state, KEY.ENTER)).toEqual({ type: 'done', result: { action: 'continue', selected: [], added: [] } });
  });
});

describe('renderListScreen', () => {
  it('renders the breadcrumb, title, notes, body, status and button labels', () => {
    const state = createListScreenState(spec({
      notes: ['Only models Claude Code supports are listed.'],
      body: ['Claude Code  a (active)'],
      status: s => `${s.length} selected`,
      continueLabel: 'Save',
    }));

    const output = renderListScreen(state);

    expect(output).toContain('Agents');
    expect(output).toContain('Review');
    expect(output).toContain('Claude Code · Models');
    expect(output).toContain('Only models Claude Code supports are listed.');
    expect(output).toContain('  Claude Code  a (active)');
    expect(output).toContain('0 selected');
    expect(output).toContain('[Save]');
  });

  it('shows a scroll window with its range for long lists, keeping the cursor visible', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const state = createListScreenState(spec({ rows: rows(...ids) }));

    for (let i = 0; i < 15; i++) applyKey(state, KEY.ARROW_DOWN);
    const output = renderListScreen(state);

    expect(output).toContain('Showing 5-16 of 20');
    expect(output).toContain('m15');
    expect(output).not.toContain('m3\n');
  });

  it('renders a disabled row with its reason', () => {
    const state = createListScreenState(spec({ rows: [{ id: 'codex', label: 'Codex', disabled: 'not supported by x' }] }));

    expect(renderListScreen(state)).toContain('(not supported by x)');
  });
});
