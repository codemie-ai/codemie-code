import { describe, it, expect, vi } from 'vitest';
import {
  matchBudgetRow,
  formatBudgetSegment,
  extractBasicInfo,
  formatDuration,
  fmt,
  buildStatusLine,
  resolveBudget,
  isMainModule,
} from '../statusline.mjs';

describe('matchBudgetRow', () => {
  const rows = [
    { project_name: 'nikita_levyankov@epam.com (cli)', current_spending: 500.26, total: 100.05, budget_reset_at: '2026-07-13T00:00:18.663000Z' },
    { project_name: 'nikita_levyankov@epam.com', current_spending: 6.05, total: 5.04, budget_reset_at: '2026-07-17T09:30:34.278000Z' },
    { project_name: 'nikita_levyankov@epam.com (premium)', current_spending: 24.93, total: 83.11, budget_reset_at: '2026-07-18T16:55:53.270000Z' },
  ];

  it('matches only the "(cli)" suffixed row for the given email', () => {
    const row = matchBudgetRow(rows, 'nikita_levyankov@epam.com');
    expect(row).toEqual(rows[0]);
  });

  it('returns null when no row matches the email', () => {
    expect(matchBudgetRow(rows, 'someone-else@epam.com')).toBeNull();
  });

  it('returns null when rows is not an array', () => {
    expect(matchBudgetRow(undefined, 'x@y.com')).toBeNull();
    expect(matchBudgetRow(null, 'x@y.com')).toBeNull();
  });

  it('returns null when userEmail is falsy', () => {
    expect(matchBudgetRow(rows, '')).toBeNull();
    expect(matchBudgetRow(rows, undefined)).toBeNull();
  });

  it('matches regardless of email casing or surrounding whitespace', () => {
    expect(matchBudgetRow(rows, 'Nikita_Levyankov@EPAM.com')).toEqual(rows[0]);
    expect(matchBudgetRow(rows, '  nikita_levyankov@epam.com  ')).toEqual(rows[0]);
  });
});

describe('formatBudgetSegment', () => {
  it('formats current spend, percentage, and reset date — never budget_limit', () => {
    const row = { current_spending: 12.34, budget_limit: 999, total: 41, budget_reset_at: '2026-07-15T00:00:00.000Z' };
    const result = formatBudgetSegment(row);
    expect(result.text).toContain('$12.34');
    expect(result.text).toContain('41%');
    expect(result.text).not.toContain('999');
    expect(result.pct).toBe(41);
  });

  it('returns null for a null row', () => {
    expect(formatBudgetSegment(null)).toBeNull();
  });
});

describe('extractBasicInfo', () => {
  it('extracts model, project, context, cost, and duration from a full Claude Code payload', () => {
    const ctx = {
      workspace: { current_dir: '/Users/me/repos/my-project' },
      model: { display_name: 'Claude Sonnet 5' },
      context_window: { used_percentage: 42, total_input_tokens: 12345, total_output_tokens: 678 },
      cost: { total_cost_usd: 1.2345, total_duration_ms: 125000 },
    };
    const info = extractBasicInfo(ctx);
    expect(info.projectName).toBe('my-project');
    expect(info.model).toBe('Claude Sonnet 5');
    expect(info.ctxPct).toBe(42);
    expect(info.tokIn).toBe(12345);
    expect(info.tokOut).toBe(678);
    expect(info.cost).toBe(1.2345);
    expect(info.durationMs).toBe(125000);
  });

  it('returns safe defaults for an empty/malformed payload', () => {
    const info = extractBasicInfo({});
    expect(info.projectName).toBe('');
    expect(info.model).toBe('');
    expect(info.ctxPct).toBeNull();
    expect(info.cost).toBeNull();
    expect(info.durationMs).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats milliseconds as "Xm Ys"', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('returns null for null/undefined input', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });

  it('returns null instead of "NaNm NaNs" for non-numeric or negative input', () => {
    expect(formatDuration(NaN)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration('not-a-number')).toBeNull();
  });
});

describe('fmt', () => {
  it('formats large numbers with k/M suffixes', () => {
    expect(fmt(500)).toBe('500');
    expect(fmt(1500)).toBe('1.5k');
    expect(fmt(2_500_000)).toBe('2.5M');
  });
});

describe('buildStatusLine', () => {
  const basic = {
    projectName: 'my-project', branch: 'main', model: 'Claude Sonnet 5',
    ctxPct: 42, tokIn: 1000, tokOut: 200, cost: 1.5, durationMs: 65000,
  };

  it('always renders basic info (including session cost and duration) with no budget/profile', () => {
    const line = buildStatusLine({ ...basic, budget: null, budgetError: null });
    expect(line).not.toContain('⚠');
    expect(line).toContain('$1.5000');
    expect(line).toContain('1m 5s');
    expect(line).toContain('[my-project]');
    expect(line).toContain('(main)');
    expect(line).toContain('[Claude Sonnet 5]');
  });

  it('shows a minimal warning indicator (not blocking basic info) when the budget fetch fails', () => {
    const line = buildStatusLine({ ...basic, budget: null, budgetError: 'reauthenticate' });
    expect(line).toContain('⚠ reauthenticate');
    expect(line).toContain('$1.5000');
    expect(line).toContain('[my-project]');
  });

  it('shows the budget segment (and no warning) when budget resolves successfully', () => {
    const line = buildStatusLine({ ...basic, budget: { text: '$12.34 (41%) resets 7/15/2026', pct: 41 }, budgetError: null });
    expect(line).toContain('$12.34 (41%)');
    expect(line).not.toContain('⚠');
  });

  it('does not throw and omits the cost segment when cost is non-numeric', () => {
    expect(() => buildStatusLine({ ...basic, cost: 'not-a-number', budget: null, budgetError: null })).not.toThrow();
    const line = buildStatusLine({ ...basic, cost: 'not-a-number', budget: null, budgetError: null });
    expect(line).not.toContain('NaN');
    expect(line).toContain('[my-project]'); // basic info still renders
  });
});

describe('resolveBudget', () => {
  it('skips silently (no error) when there is no CodeMie config at all', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
  });

  it('skips silently when the profile is missing codeMieUrl/baseUrl/userEmail', async () => {
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('no cache'))
      .mockResolvedValueOnce(JSON.stringify({ activeProfile: 'default', profiles: { default: {} } }));
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
  });

  it('returns a "reauthenticate" error when no auth headers are available', async () => {
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('no cache'))
      .mockResolvedValueOnce(JSON.stringify({
        activeProfile: 'default',
        profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
      }));
    const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'reauthenticate' });
  });

  it('returns the HTTP error message when the fetch fails', async () => {
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('no cache'))
      .mockResolvedValueOnce(JSON.stringify({
        activeProfile: 'default',
        profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
      }));
    const getAuthHeadersImpl = vi.fn().mockResolvedValue({ cookie: 'a=b' });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'HTTP 500' });
  });

  it('resolves and caches the matched budget row on success', async () => {
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('no cache'))
      .mockResolvedValueOnce(JSON.stringify({
        activeProfile: 'default',
        profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
      }));
    const getAuthHeadersImpl = vi.fn().mockResolvedValue({ cookie: 'a=b' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { rows: [{ project_name: 'me@x.com (cli)', current_spending: 5, total: 10, budget_reset_at: '2026-07-15T00:00:00.000Z' }] } }),
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await resolveBudget({ readFile, writeFile, fetchImpl, getAuthHeadersImpl });
    expect(result.budgetError).toBeNull();
    expect(result.budget.text).toContain('$5.00');
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('budget-cache.json'), expect.any(String), 'utf8');
  });

  it('returns the fresh cached value without touching config/network when cache is fresh', async () => {
    const readFile = vi.fn().mockResolvedValueOnce(JSON.stringify({ schema: 2, ts: Date.now(), value: { text: 'cached', pct: 5 } }));
    const fetchImpl = vi.fn();
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: { text: 'cached', pct: 5 }, budgetError: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a pre-upgrade string-shaped cache entry as a cache miss instead of using it', async () => {
    // Old cache format: value was a plain string, not { text, pct }.
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ ts: Date.now(), value: '$5.00/$10 (50%)', pct: 50 }))
      .mockRejectedValueOnce(new Error('no config'));
    const fetchImpl = vi.fn();
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a graceful budgetError instead of an uncaught rejection when getAuthHeadersImpl throws', async () => {
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('no cache'))
      .mockResolvedValueOnce(JSON.stringify({
        activeProfile: 'default',
        profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
      }));
    const getAuthHeadersImpl = vi.fn().mockRejectedValue(new Error('keychain locked'));
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'keychain locked' });
  });
});

describe('isMainModule', () => {
  it('matches when the raw path equals the decoded file URL', () => {
    expect(isMainModule('/Users/me/script.mjs', 'file:///Users/me/script.mjs')).toBe(true);
  });

  it('matches even when the home directory contains spaces (percent-encoded in the URL)', () => {
    expect(isMainModule('/Users/John Doe/.claude/codemie-budget-status.js', 'file:///Users/John%20Doe/.claude/codemie-budget-status.js')).toBe(true);
  });

  it('returns false for a different path', () => {
    expect(isMainModule('/Users/me/other.mjs', 'file:///Users/me/script.mjs')).toBe(false);
  });

  it('returns false when argv1 is falsy', () => {
    expect(isMainModule('', 'file:///Users/me/script.mjs')).toBe(false);
    expect(isMainModule(undefined, 'file:///Users/me/script.mjs')).toBe(false);
  });
});
