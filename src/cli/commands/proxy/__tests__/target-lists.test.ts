/**
 * The bare `proxy connect` / `proxy disconnect` target lists: every flag row starts its description at one column,
 * computed from the longest flag, and every description is one short line.
 * @group unit
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { formatFlagRows, vendorFlag, vendorFlags } from '../flag-list.js';
import { CONNECT_TARGET_LIST } from '../connect-orchestrator.js';
import { DISCONNECT_TARGET_LIST } from '../disconnect-orchestrator.js';

/** The flag rows of a list: the lines between its heading and its first blank line after the rows. */
function flagRows(list: string): string[] {
  const lines = list.split('\n');
  const start = lines.findIndex((line) => line.startsWith('  --'));
  const end = lines.findIndex((line, i) => i > start && line === '');
  return lines.slice(start, end);
}

/** The column where a row's description starts. */
function descriptionColumn(row: string): number {
  const match = /^ {2}--\S+(?: --\S+)* +/.exec(row);
  return match ? match[0].length : -1;
}

describe('formatFlagRows', () => {
  it('pads every flag to the longest one plus two spaces', () => {
    expect(formatFlagRows([['--a', 'first'], ['--longer-flag', 'second']])).toEqual([
      '  --a            first',
      '  --longer-flag  second',
    ]);
  });
});

describe('vendorFlag', () => {
  it('maps each deprecated per-connector flag to its vendor flag and leaves other flags alone', () => {
    expect(vendorFlag('--claude-code-otlp')).toBe('--claude-otlp');
    expect(vendorFlag('--copilot-chat-otlp')).toBe('--copilot-otlp');
    expect(vendorFlag('--copilot-cli-otlp')).toBe('--copilot-otlp');
    expect(vendorFlag('--claude-desktop')).toBe('--claude-desktop');
    expect(vendorFlags(['--claude-desktop', '--copilot-chat-otlp', '--copilot-cli-otlp'])).toEqual(['--claude-desktop', '--copilot-otlp']);
  });
});

describe.each([
  ['connect', CONNECT_TARGET_LIST],
  ['disconnect', DISCONNECT_TARGET_LIST],
])('bare proxy %s target list', (_name, list) => {
  const rows = flagRows(list);

  it('aligns every description on one column', () => {
    expect(rows.length).toBeGreaterThan(5);
    const columns = new Set(rows.map(descriptionColumn));
    expect([...columns]).toHaveLength(1);
    expect([...columns][0]).toBeGreaterThan(0);
  });

  it('keeps every row to one line of at most 100 characters', () => {
    for (const row of rows) {
      expect(row.startsWith('  --'), `continuation line: ${row}`).toBe(true);
      expect(row.length, row).toBeLessThanOrEqual(100);
    }
  });

  it('lists the vendor flags and no deprecated per-connector flag, in rows or examples', () => {
    expect(rows.some((row) => row.startsWith('  --claude-otlp '))).toBe(true);
    expect(rows.some((row) => row.startsWith('  --copilot-otlp '))).toBe(true);
    expect(list).not.toMatch(/--claude-code-otlp|--copilot-chat-otlp|--copilot-cli-otlp/);
  });
});

describe('bare proxy connect target list note', () => {
  it('has one note line under the rows: --claude-otlp routes Desktop and the extension only when not configured, disconnect removes it', () => {
    const lines = CONNECT_TARGET_LIST.split('\n');
    const lastRow = lines.findLastIndex((line) => line.startsWith('  --'));
    expect(lines[lastRow + 1]).toBe('');
    expect(lines[lastRow + 2]).toBe(
      '  Note: --claude-otlp routes Claude Desktop and the VS Code extension through the proxy ' +
      'only when they are not configured yet; disconnect --claude-otlp removes that route.'
    );
    expect(lines[lastRow + 3]).toBe('');
    expect(lines.filter((line) => line.includes('Note:'))).toHaveLength(1);
  });
});
