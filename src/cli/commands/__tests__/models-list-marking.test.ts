/**
 * `codemie models list` marks catalog rows that belong to the active profile's
 * own model list (resolveProfileModels), and the one matching the active model
 * distinctly, so a multi-model profile's own models are visible at a glance
 * without opening the full catalogue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

import { formatTable } from '../models.js';
import type { ModelInfo } from '../../../providers/core/types.js';

function model(id: string): ModelInfo {
  return { id, name: id } as ModelInfo;
}

describe('formatTable — profile model marking', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function allLogs(): string {
    return logSpy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  it('marks ids in the profile model list, and the active model distinctly', () => {
    formatTable([model('a'), model('b'), model('c')], ['a', 'b'], 'a');

    const lines = allLogs().split('\n');
    const rowA = lines.find(l => /^a\s/.test(l));
    const rowB = lines.find(l => /^b\s/.test(l));
    const rowC = lines.find(l => /^c\s/.test(l));

    expect(rowA).toContain('(active)');
    expect(rowB).toContain('(profile)');
    expect(rowB).not.toContain('(active)');
    expect(rowC).not.toContain('(profile)');
    expect(rowC).not.toContain('(active)');
  });

  it('marks nothing when no profile model ids are given', () => {
    formatTable([model('a'), model('b')]);

    const rendered = allLogs();
    expect(rendered).not.toContain('(active)');
    expect(rendered).not.toContain('(profile)');
  });
});
