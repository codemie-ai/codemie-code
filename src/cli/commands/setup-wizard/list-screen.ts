/**
 * Full-screen raw-mode list screen for the per-agent model setup wizard.
 *
 * Built on the shared selection UI primitives the `codemie setup assistants` wizard uses (purple
 * top line, search box, ◉/◯ rows, buttons), but filters in memory and supports single choice,
 * typed custom entries and action rows. Key handling (`applyKey`) and rendering
 * (`renderListScreen`) are pure so they can be tested without a TTY.
 */

import chalk from 'chalk';
import { COLOR } from '@/cli/commands/shared/constants.js';
import { KEY, ANSI, SHARED_TEXT } from '@/cli/commands/shared/selection/constants.js';
import {
  buildTopLine,
  buildSearchInput,
  buildSelectionRow,
  buildSingleChoiceRow,
  buildSelectionDetailLine,
} from '@/cli/commands/shared/selection/ui.js';
import type { ListRow, ListScreenResult, ListScreenSpec } from './types.js';
import { KEEP_ALIVE_INTERVAL_MS, VISIBLE_ROWS, WIZARD_TEXT } from './constants.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export interface ListScreenState {
  spec: ListScreenSpec;
  /** Spec rows plus custom rows added on this screen. */
  rows: ListRow[];
  selected: string[];
  added: string[];
  query: string;
  /** Index into the visible rows. */
  cursor: number;
  /** First visible row of the scroll window. */
  scroll: number;
  focus: 'list' | 'buttons';
  button: 'continue' | 'cancel';
  error?: string;
}

export type KeyOutcome = { type: 'render' } | { type: 'done'; result: ListScreenResult } | { type: 'none' };

interface VisibleRows {
  rows: ListRow[];
  /** Id of the custom row offered for the current query, when it is shown first. */
  customId?: string;
}

const purple = (text: string): string => chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(text);

export function createListScreenState(spec: ListScreenSpec): ListScreenState {
  const rows = [...spec.rows];
  const selectable = rows.filter(row => !row.disabled && row.kind !== 'action').map(row => row.id);
  const selected = spec.selected.filter(id => selectable.includes(id));
  const initialCursor = spec.mode === 'single' && selected[0] ? Math.max(0, rows.findIndex(r => r.id === selected[0])) : 0;

  return {
    spec,
    rows,
    selected: spec.mode === 'single' ? selected.slice(0, 1) : selected,
    added: [],
    query: '',
    cursor: initialCursor,
    scroll: 0,
    focus: rows.length === 0 ? 'buttons' : 'list',
    button: 'continue',
  };
}

export function getVisibleRows(state: ListScreenState): VisibleRows {
  const query = state.query.trim().toLowerCase();
  if (!query) return { rows: state.rows };

  const matches = state.rows.filter(row => row.kind === 'action' || row.id.toLowerCase().includes(query));
  const exact = state.rows.some(row => row.id.toLowerCase() === query);
  const custom = !exact ? state.spec.customRow?.(state.query.trim()) : undefined;
  return custom ? { rows: [custom, ...matches], customId: custom.id } : { rows: matches };
}

function isPrintable(key: string): boolean {
  return key.length > 0 && [...key].every(ch => ch >= ' ' && ch <= '~') && key !== ' ';
}

function finishContinue(state: ListScreenState): KeyOutcome {
  const error = state.spec.validate?.(state.selected);
  if (error) {
    state.error = error;
    return { type: 'render' };
  }
  return { type: 'done', result: { action: 'continue', selected: [...state.selected], added: [...state.added] } };
}

function addCustomRow(state: ListScreenState, row: ListRow): void {
  const inserted = row.addAs ?? { id: row.id, label: row.id };
  state.rows = [...state.rows.filter(r => r.kind !== 'action'), inserted, ...state.rows.filter(r => r.kind === 'action')];
  state.added.push(row.id);
  state.selected = state.spec.mode === 'single' ? [row.id] : [...state.selected, row.id];
  state.query = '';
  state.cursor = state.rows.findIndex(r => r.id === row.id);
}

/** Space: toggle (multi) or mark (single) the row under the cursor. */
function toggleRow(state: ListScreenState, row: ListRow, isCustom: boolean): KeyOutcome {
  if (row.disabled) {
    state.error = `${row.id}: ${row.disabled}`;
    return { type: 'render' };
  }
  if (row.kind === 'action') {
    return { type: 'done', result: { action: 'row', id: row.id, selected: [...state.selected], added: [...state.added] } };
  }
  if (isCustom) {
    addCustomRow(state, row);
    return { type: 'render' };
  }
  if (state.spec.mode === 'single') {
    state.selected = [row.id];
  } else {
    state.selected = state.selected.includes(row.id)
      ? state.selected.filter(id => id !== row.id)
      : [...state.selected, row.id];
  }
  return { type: 'render' };
}

function handleEnter(state: ListScreenState): KeyOutcome {
  if (state.focus === 'buttons') {
    return state.button === 'continue' ? finishContinue(state) : { type: 'done', result: { action: 'cancel' } };
  }

  const { rows, customId } = getVisibleRows(state);
  const row = rows[state.cursor];
  if (!row) return finishContinue(state);

  const isCustom = row.id === customId && state.cursor === 0;
  if (isCustom || row.kind === 'action' || row.disabled) {
    return toggleRow(state, row, isCustom);
  }
  if (state.spec.mode === 'single') {
    state.selected = [row.id];
  }
  return finishContinue(state);
}

function moveCursor(state: ListScreenState, direction: 'up' | 'down'): void {
  const count = getVisibleRows(state).rows.length;
  if (state.focus === 'buttons') {
    if (direction === 'up' && count > 0) {
      state.focus = 'list';
      state.cursor = count - 1;
    }
    return;
  }
  if (direction === 'up') {
    state.cursor = Math.max(0, state.cursor - 1);
  } else if (state.cursor >= count - 1) {
    state.focus = 'buttons';
    state.button = 'continue';
  } else {
    state.cursor += 1;
  }
}

/** Applies one key (or pasted chunk) to the state. */
export function applyKey(state: ListScreenState, key: string): KeyOutcome {
  state.error = undefined;

  switch (key) {
    case KEY.CTRL_C:
      return { type: 'done', result: { action: 'cancel' } };
    case KEY.ESC:
      if (state.query) {
        state.query = '';
        state.cursor = 0;
        return { type: 'render' };
      }
      return { type: 'done', result: { action: 'back' } };
    case KEY.ARROW_UP:
      moveCursor(state, 'up');
      return { type: 'render' };
    case KEY.ARROW_DOWN:
      moveCursor(state, 'down');
      return { type: 'render' };
    case KEY.TAB:
    case KEY.SHIFT_TAB:
      if (getVisibleRows(state).rows.length > 0) {
        state.focus = state.focus === 'list' ? 'buttons' : 'list';
      }
      return { type: 'render' };
    case KEY.ARROW_LEFT:
    case KEY.ARROW_RIGHT:
      if (state.focus !== 'buttons') return { type: 'none' };
      state.button = state.button === 'continue' ? 'cancel' : 'continue';
      return { type: 'render' };
    case KEY.ENTER:
    case KEY.NEWLINE:
      return handleEnter(state);
    case KEY.SPACE: {
      if (state.focus === 'buttons') return handleEnter(state);
      const { rows, customId } = getVisibleRows(state);
      const row = rows[state.cursor];
      return row ? toggleRow(state, row, row.id === customId && state.cursor === 0) : { type: 'none' };
    }
    case KEY.BACKSPACE:
    case KEY.BACKSPACE_ALT:
      if (!state.query) return { type: 'none' };
      state.query = state.query.slice(0, -1);
      state.cursor = 0;
      state.focus = 'list';
      return { type: 'render' };
    default:
      if (!state.spec.searchable || !isPrintable(key)) return { type: 'none' };
      state.query += key;
      state.cursor = 0;
      state.focus = 'list';
      return { type: 'render' };
  }
}

function buildBreadcrumb(stages: string[], current: number): string {
  return stages
    .map((stage, index) => {
      if (index === current) {
        return chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${stage} `);
      }
      return index < current ? chalk.white(stage) : chalk.dim(stage);
    })
    .join(chalk.dim('  ›  ')) + '\n\n';
}

function buildRow(state: ListScreenState, row: ListRow, isCursor: boolean): string {
  const isSelected = state.selected.includes(row.id);
  const label = row.disabled ? chalk.dim(row.label) : row.label;
  const metadata = row.disabled ? chalk.dim(`(${row.disabled})`) : undefined;

  const line = state.spec.mode === 'single' && row.kind !== 'action'
    ? buildSingleChoiceRow({ label: metadata ? `${label} ${metadata}` : label, isCursor, isSelected })
    : row.kind === 'action'
      ? `${isCursor ? purple('› ') : '  '}${isCursor ? purple(row.label) : chalk.cyan(row.label)}`
      : buildSelectionRow({ label, isCursor, isSelected, metadata });

  return row.detail ? `${line}\n${buildSelectionDetailLine(row.detail)}` : line;
}

function buildButtons(state: ListScreenState): string {
  const active = (text: string): string => chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${text} `);
  const label = state.spec.continueLabel ?? SHARED_TEXT.CONTINUE_BUTTON;
  const focused = state.focus === 'buttons';
  const continueButton = focused && state.button === 'continue' ? active(label) : chalk.dim(`[${label}]`);
  const cancelButton = focused && state.button === 'cancel'
    ? active(SHARED_TEXT.CANCEL_BUTTON)
    : chalk.dim(`[${SHARED_TEXT.CANCEL_BUTTON}]`);
  return `  ${continueButton}  ${cancelButton}\n\n`;
}

/** Keeps the cursor inside the scroll window. */
function syncScroll(state: ListScreenState, count: number): void {
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  if (state.cursor >= state.scroll + VISIBLE_ROWS) state.scroll = state.cursor - VISIBLE_ROWS + 1;
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, count - VISIBLE_ROWS)));
}

export function renderListScreen(state: ListScreenState): string {
  const { spec } = state;
  const { rows } = getVisibleRows(state);
  syncScroll(state, rows.length);

  let output = ANSI.CURSOR_HOME_CLEAR;
  output += buildTopLine();
  output += buildBreadcrumb(spec.stages, spec.stageIndex);
  output += chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(spec.title) + '\n';
  for (const note of spec.notes ?? []) {
    output += chalk.dim(note) + '\n';
  }
  output += '\n';
  if (spec.body?.length) {
    output += spec.body.map(line => `  ${line}`).join('\n') + '\n\n';
  }

  if (spec.searchable) {
    output += buildSearchInput(state.query, state.query.length > 0);
  }

  if (rows.length > VISIBLE_ROWS) {
    const end = Math.min(rows.length, state.scroll + VISIBLE_ROWS);
    output += chalk.dim(`Showing ${state.scroll + 1}-${end} of ${rows.length}`) + '\n';
  }

  rows.slice(state.scroll, state.scroll + VISIBLE_ROWS).forEach((row, offset) => {
    const index = state.scroll + offset;
    output += buildRow(state, row, state.focus === 'list' && index === state.cursor) + '\n';
  });
  if (rows.length > 0) output += '\n';

  const status = state.error ? chalk.red(state.error) : spec.status?.(state.selected);
  if (status) {
    output += (state.error ? status : chalk.dim(status)) + '\n\n';
  }

  output += buildButtons(state);
  const instructions = rows.length === 0
    ? WIZARD_TEXT.INSTRUCTIONS_REVIEW
    : spec.mode === 'single'
      ? WIZARD_TEXT.INSTRUCTIONS_SINGLE
      : spec.searchable ? WIZARD_TEXT.INSTRUCTIONS_MULTI_SEARCH : WIZARD_TEXT.INSTRUCTIONS_MULTI;
  output += chalk.dim(instructions) + '\n';

  return output;
}

/** Shows one screen and resolves when the user continues, picks an action row, goes back or cancels. */
export function runListScreen(spec: ListScreenSpec): Promise<ListScreenResult> {
  const state = createListScreenState(spec);

  return new Promise(resolve => {
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);

    const render = (): void => {
      process.stdout.write(HIDE_CURSOR + renderListScreen(state));
    };

    const onData = (data: Buffer | string): void => {
      const outcome = applyKey(state, data.toString());
      if (outcome.type === 'render') {
        render();
      } else if (outcome.type === 'done') {
        cleanup();
        resolve(outcome.result);
      }
    };

    function cleanup(): void {
      clearInterval(keepAlive);
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write(ANSI.CURSOR_HOME_CLEAR + SHOW_CURSOR);
    }

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    render();
  });
}
