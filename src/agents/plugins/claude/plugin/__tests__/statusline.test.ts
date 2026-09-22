import { describe, it, expect, vi } from 'vitest';
import { resolve, dirname, basename, join } from 'path';
import { pathToFileURL } from 'url';
import {
  matchBudgetRow,
  formatBudgetSegment,
  extractBasicInfo,
  formatDuration,
  buildStatusLine,
  resolveBudget,
  isMainModule,
  ctxBar,
  lookupRate,
  computeSessionCost,
} from '../statusline.js';

const YELLOW = '\x1b[0;33m';
const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';

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

describe('ctxBar', () => {
  it('renders a 10-segment filled/empty bar plus the percentage', () => {
    const bar = ctxBar(50);
    expect(bar).toContain('50%');
    expect(bar).toContain('█████░░░░░');
  });

  it('colors the bar green below 70%, yellow from 70-89%, red at 90%+', () => {
    expect(ctxBar(50)).toContain(GREEN);
    expect(ctxBar(75)).toContain(YELLOW);
    expect(ctxBar(95)).toContain(RED);
  });

  it('returns null for non-numeric or missing input', () => {
    expect(ctxBar(null)).toBeNull();
    expect(ctxBar(undefined)).toBeNull();
    expect(ctxBar(NaN)).toBeNull();
    expect(ctxBar('not-a-number')).toBeNull();
  });
});

describe('buildStatusLine', () => {
  const basic = {
    projectName: 'my-project', branch: 'main', model: 'Claude Sonnet 5',
    ctxPct: 42, cost: 1.5, costExact: true, durationMs: 65000,
  };

  it('always renders basic info (including session cost and duration)', () => {
    const line = buildStatusLine({ ...basic });
    expect(line).not.toContain('⚠');
    expect(line).toContain('$1.5000');
    expect(line).toContain('1m 5s');
    expect(line).toContain('[my-project]');
    expect(line).toContain('(main)');
    expect(line).toContain('[Claude Sonnet 5]');
  });

  it('renders the context-% as a colored bar, and the cost in its own distinct (yellow) color', () => {
    const line = buildStatusLine({ ...basic });
    expect(line).toContain('42%');
    expect(line).toContain('████░░░░░░'); // 42% -> 4 filled segments
    expect(line).toContain(`${YELLOW}$1.5000${'\x1b[0m'}`);
  });

  it('marks the cost an estimate only when it was not priced from the transcript', () => {
    expect(buildStatusLine({ ...basic, costExact: true })).toContain(`${YELLOW}$1.5000`);
    expect(buildStatusLine({ ...basic, costExact: false })).toContain(`${YELLOW}~$1.5000`);
  });

  it('never renders a budget segment, even when budget fields are passed', () => {
    const line = buildStatusLine({
      ...basic,
      budget: { text: '$12.34 (41%) resets 7/15/2026', pct: 41 },
      budgetError: 'reauthenticate',
    } as never);
    expect(line).not.toContain('$12.34');
    expect(line).not.toContain('⚠');
  });

  it('does not throw and omits the cost segment when cost is non-numeric', () => {
    expect(() => buildStatusLine({ ...basic, cost: 'not-a-number' })).not.toThrow();
    const line = buildStatusLine({ ...basic, cost: 'not-a-number' });
    expect(line).not.toContain('NaN');
    expect(line).toContain('[my-project]'); // basic info still renders
  });
});

describe('resolveBudget', () => {
  // Path-aware rather than call-ordered: resolveBudget reads both the CodeMie config and the
  // budget cache, and ordering the mocks by call index silently mis-feeds them the moment that
  // read order changes. Dispatch on the filename instead.
  const readFileFor = (config: unknown, cache?: unknown) =>
    vi.fn(async (filePath: string) => {
      if (String(filePath).endsWith('codemie-cli.config.json')) return JSON.stringify(config);
      if (cache !== undefined) return JSON.stringify(cache);
      throw new Error('no cache');
    });

  it('skips silently (no error) when there is no CodeMie config at all', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
  });

  it('skips silently when the profile is missing codeMieUrl/baseUrl/userEmail', async () => {
    const readFile = readFileFor({ activeProfile: 'default', profiles: { default: {} } });
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
  });

  it('skips silently when codeMieUrl/userEmail only exist on the profile — migration 006 moved them to workspace/top-level', async () => {
    const readFile = readFileFor({
      activeProfile: 'default',
      // Pre-fix (stale) shape: codeMieUrl/userEmail stranded on the profile with no
      // top-level `workspace`/`userEmail`. Must not be read from the profile object —
      // regression test for the statusline reading raw profile fields post-migration.
      profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
    });
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: null, budgetError: null });
  });

  it('returns a "reauthenticate" error when no auth headers are available', async () => {
    const readFile = readFileFor({
        activeProfile: 'default',
        userEmail: 'me@x.com',
        workspace: { codeMieUrl: 'https://x' },
        profiles: { default: { baseUrl: 'https://x/api' } },
      });
    const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'reauthenticate' });
  });

  it('returns the HTTP error message when the fetch fails', async () => {
    const readFile = readFileFor({
        activeProfile: 'default',
        userEmail: 'me@x.com',
        workspace: { codeMieUrl: 'https://x' },
        profiles: { default: { baseUrl: 'https://x/api' } },
      });
    const getAuthHeadersImpl = vi.fn().mockResolvedValue({ cookie: 'a=b' });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'HTTP 500' });
  });

  it('resolves and caches the matched budget row on success', async () => {
    const readFile = readFileFor({
        activeProfile: 'default',
        userEmail: 'me@x.com',
        workspace: { codeMieUrl: 'https://x' },
        profiles: { default: { baseUrl: 'https://x/api' } },
      });
    const getAuthHeadersImpl = vi.fn().mockResolvedValue({ cookie: 'a=b' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: { rows: [{ project_name: 'me@x.com (cli)', current_spending: 5, total: 10, budget_reset_at: '2026-07-15T00:00:00.000Z' }] } }),
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await resolveBudget({ readFile, writeFile, fetchImpl, getAuthHeadersImpl });
    expect(result.budgetError).toBeNull();
    expect(result.budget.text).toContain('$5.00');
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('budget-cache.json'), expect.any(String), 'utf8');
  });

  const CONFIG = {
    activeProfile: 'default',
    userEmail: 'me@x.com',
    workspace: { codeMieUrl: 'https://x' },
    profiles: { default: { baseUrl: 'https://x/api' } },
  };

  it('returns the fresh cached value without touching the network when cache is fresh', async () => {
    const readFile = readFileFor(CONFIG, { schema: 2, profile: 'default', ts: Date.now(), value: { text: 'cached', pct: 5 } });
    const fetchImpl = vi.fn();
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: { text: 'cached', pct: 5 }, budgetError: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a cache entry written for a different profile', async () => {
    // Budgets are per-profile and every session shares one cache file, so an entry from another
    // profile must not be shown here — it would report someone else's budget for up to the TTL.
    const readFile = readFileFor(CONFIG, { schema: 2, profile: 'other-profile', ts: Date.now(), value: { text: 'cached', pct: 5 } });
    const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'reauthenticate' }); // fell through to a live lookup
  });

  it('treats a pre-upgrade string-shaped cache entry as a cache miss instead of using it', async () => {
    // Old cache format: value was a plain string, not { text, pct }.
    const readFile = readFileFor(CONFIG, { ts: Date.now(), value: '$5.00/$10 (50%)', pct: 50 });
    const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
    const fetchImpl = vi.fn();
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'reauthenticate' }); // cache rejected, live lookup attempted
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a graceful budgetError instead of an uncaught rejection when getAuthHeadersImpl throws', async () => {
    const readFile = readFileFor({
        activeProfile: 'default',
        userEmail: 'me@x.com',
        workspace: { codeMieUrl: 'https://x' },
        profiles: { default: { baseUrl: 'https://x/api' } },
      });
    const getAuthHeadersImpl = vi.fn().mockRejectedValue(new Error('keychain locked'));
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });
    expect(result).toEqual({ budget: null, budgetError: 'keychain locked' });
  });
});

describe('isMainModule', () => {
  // Build the file URL from a real, platform-resolved absolute path (via pathToFileURL)
  // rather than hardcoding POSIX-style "file:///..." strings, so this test is symmetric
  // on Windows too — fileURLToPath() decodes to a backslash-separated path there.
  it('matches when the raw path equals the decoded file URL', () => {
    const scriptPath = resolve('Users', 'me', 'script.mjs');
    expect(isMainModule(scriptPath, pathToFileURL(scriptPath).href)).toBe(true);
  });

  it('matches even when the path contains spaces (percent-encoded in the URL)', () => {
    const scriptPath = resolve('Users', 'John Doe', '.claude', 'codemie-budget-status.js');
    expect(isMainModule(scriptPath, pathToFileURL(scriptPath).href)).toBe(true);
  });

  it('returns false for a different path', () => {
    const scriptPath = resolve('Users', 'me', 'script.mjs');
    const otherPath = resolve('Users', 'me', 'other.mjs');
    expect(isMainModule(otherPath, pathToFileURL(scriptPath).href)).toBe(false);
  });

  it('returns false when argv1 is falsy', () => {
    const url = pathToFileURL(resolve('Users', 'me', 'script.mjs')).href;
    expect(isMainModule('', url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
  });
});

// statusline.ts is now a normal, type-checked, linted TS source file — but these tests remain the
// sole *behavioral* gate on the pricing path (an engine that overrides Claude Code's own reported
// spend, which typechecking and linting alone can't catch a logic error in).
describe('lookupRate', () => {
  const TABLE = {
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
    'claude-smart-router': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    'gemini-3.7-flash': { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
    _meta: { note: 'must never be matched as a model id' },
  };

  it('matches an exact id', () => {
    expect(lookupRate(TABLE, 'claude-sonnet-5')?.input).toBe(3);
  });

  it('prices a dotted table key, whose dots the id-side folding would otherwise never match', () => {
    // The id is folded to dashes before lookup; folding only one side made all 14 dotted keys in the
    // shipped rate card unreachable, so those turns silently priced at $0.
    expect(lookupRate(TABLE, 'gemini-3.7-flash')?.input).toBe(2);
  });

  it('prices the router alias that motivated transcript-based costing', () => {
    expect(lookupRate(TABLE, 'claude-smart-router')?.output).toBe(5);
  });

  it('resolves a Bedrock ARN back to its bare model id', () => {
    expect(lookupRate(TABLE, 'converse/eu.anthropic.claude-haiku-4-5-20251001-v1:0')?.input).toBe(1);
  });

  it('is case-insensitive about the incoming id', () => {
    expect(lookupRate(TABLE, 'Claude-Sonnet-5')?.input).toBe(3);
  });

  it('matches only on a segment boundary, never mid-token', () => {
    expect(lookupRate(TABLE, 'claude-haiku-4-5-20251001')?.input).toBe(1); // suffixed -> family match
    expect(lookupRate(TABLE, 'notclaude-sonnet-5x')).toBeNull();
  });

  it('never matches a metadata key, and returns null for an unknown model', () => {
    expect(lookupRate(TABLE, '_meta')).toBeNull();
    expect(lookupRate(TABLE, 'some-other-vendor-model')).toBeNull();
    expect(lookupRate(null, 'claude-sonnet-5')).toBeNull();
  });
});

describe('computeSessionCost', () => {
  const TRANSCRIPT = '/p/sess.jsonl';
  // Derived with the same path.dirname/basename/join computeSessionCost itself uses (not a
  // hardcoded '/'-joined literal) so this matches on Windows too, where path.join joins with
  // '\' regardless of the input's own separator style — a literal here silently never matched
  // and made every subagent-transcript lookup miss.
  const SUBAGENT_DIR = join(dirname(TRANSCRIPT), basename(TRANSCRIPT, '.jsonl'), 'subagents');
  const PRICES = {
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  };

  const row = (id: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ message: { id, model, usage } });

  /** Wires the injectable seam: files by path, an optional subagent listing, and a always-miss cache. */
  const deps = (files: Record<string, string>, subagents: string[] = []) => ({
    readPrices: async () => PRICES,
    readDir: async (dir: string) => {
      if (dir === SUBAGENT_DIR && subagents.length) return subagents;
      throw new Error('ENOENT');
    },
    readFile: async (p: string) => {
      if (p in files) return files[p];
      throw new Error('ENOENT'); // covers the cost cache too, so every case recomputes
    },
    writeFile: async () => undefined,
    stat: async (p: string) => {
      if (p in files) return { size: files[p].length, mtimeMs: 1 };
      throw new Error('ENOENT');
    },
  });

  it('reports an exact zero when the transcript does not exist yet', async () => {
    // Claude Code writes the transcript lazily; a session that has not billed anything has no file.
    // Treating that as unpriceable marked every fresh session `~$0.0000` — an estimate of nothing.
    expect(await computeSessionCost(TRANSCRIPT, deps({}))).toEqual({ cost: 0, exact: true });
  });

  it('reports an exact zero for a transcript with no usage rows', async () => {
    const files = { [TRANSCRIPT]: JSON.stringify({ message: { role: 'user', content: 'hi' } }) };
    expect(await computeSessionCost(TRANSCRIPT, deps(files))).toEqual({ cost: 0, exact: true });
  });

  it('counts a message once even though Claude Code repeats it per streaming update', async () => {
    // One assistant message is appended several times carrying identical usage; summing the lines
    // multi-counts it. 16 rows for 7 messages was observed on a real session.
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const files = {
      [TRANSCRIPT]: [row('msg_1', 'claude-sonnet-5', usage), row('msg_1', 'claude-sonnet-5', usage), row('msg_1', 'claude-sonnet-5', usage)].join('\n'),
    };
    expect((await computeSessionCost(TRANSCRIPT, deps(files)))!.cost).toBeCloseTo(3, 10);
  });

  it('adds subagent transcripts, which live outside the main file entirely', async () => {
    // Subagents bill against the session but are written to <sessionId>/subagents/*.jsonl with no
    // isSidechain row in the main transcript. Omitting them lost 79% of one session's real spend.
    const files = {
      [TRANSCRIPT]: row('msg_main', 'claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 }),
      // path.join, not a '/'-joined template literal — see SUBAGENT_DIR's own comment above.
      [join(SUBAGENT_DIR, 'agent-a.jsonl')]: row('msg_a', 'claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 0 }),
      [join(SUBAGENT_DIR, 'agent-b.jsonl')]: row('msg_b', 'claude-haiku-4-5', { output_tokens: 1_000_000 }),
    };
    const result = await computeSessionCost(TRANSCRIPT, deps(files, ['agent-a.jsonl', 'agent-b.jsonl', 'notes.txt']));
    expect(result!.cost).toBeCloseTo(3 + 1 + 5, 10);
    expect(result!.exact).toBe(true);
  });

  it('bills 1-hour cache writes at the 1h rate, not the 5-minute one', async () => {
    // CodeMie sets ENABLE_PROMPT_CACHING_1H=1, so this is the common path, and the two rates differ
    // ($6/M vs $3.75/M on sonnet). Pricing the flat field instead undercounts real spend.
    const files = {
      [TRANSCRIPT]: row('msg_1', 'claude-sonnet-5', {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    };
    expect((await computeSessionCost(TRANSCRIPT, deps(files)))!.cost).toBeCloseTo(6, 10);
  });

  it('falls back to the flat cache-creation field when the split is absent or zeroed', async () => {
    const files = {
      [TRANSCRIPT]: row('msg_1', 'claude-sonnet-5', {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      }),
    };
    expect((await computeSessionCost(TRANSCRIPT, deps(files)))!.cost).toBeCloseTo(3.75, 10);
  });

  it('prefers the routed model over the requested one', async () => {
    const files = {
      [TRANSCRIPT]: JSON.stringify({
        message: {
          id: 'msg_1',
          model: 'claude-smart-router',
          'x-codemie-routed-model': 'claude-haiku-4-5',
          usage: { output_tokens: 1_000_000 },
        },
      }),
    };
    expect((await computeSessionCost(TRANSCRIPT, deps(files)))!.cost).toBeCloseTo(5, 10);
  });

  it('marks the total an estimate when a model has no rate, rather than silently undercounting', async () => {
    const files = {
      [TRANSCRIPT]: [
        row('msg_1', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
        row('msg_2', 'some-unpriced-model', { input_tokens: 1_000_000 }),
      ].join('\n'),
    };
    const result = await computeSessionCost(TRANSCRIPT, deps(files));
    expect(result!.exact).toBe(false);
    expect(result!.cost).toBeCloseTo(3, 10); // the priced row still counts
  });

  it('survives a torn final line while Claude Code is mid-write', async () => {
    const files = {
      [TRANSCRIPT]: `${row('msg_1', 'claude-sonnet-5', { input_tokens: 1_000_000 })}\n{"message":{"id":"msg_2","usa`,
    };
    expect((await computeSessionCost(TRANSCRIPT, deps(files)))!.cost).toBeCloseTo(3, 10);
  });

  it('falls back to Claude Code’s own figure only when the rate card is unavailable', async () => {
    const base = deps({ [TRANSCRIPT]: row('msg_1', 'claude-sonnet-5', { input_tokens: 1 }) });
    const result = await computeSessionCost(TRANSCRIPT, {
      ...base,
      readPrices: async () => { throw new Error('no rate card'); },
    });
    expect(result).toBeNull();
  });

  it('returns null without touching the disk when there is no transcript path', async () => {
    const readFile = vi.fn();
    expect(await computeSessionCost('', { readFile } as never)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reuses a cached total when every source is byte-for-byte unchanged', async () => {
    // Without this the whole transcript plus every subagent file is re-read and re-parsed on every
    // render, growing without bound with session length.
    const content = row('msg_1', 'claude-sonnet-5', { input_tokens: 1_000_000 });
    const files = { [TRANSCRIPT]: content };
    const base = deps(files);
    const cache: Record<string, string> = {};
    const readFile = vi.fn(async (p: string) => {
      if (p in cache) return cache[p];
      return base.readFile(p);
    });
    const io = {
      ...base,
      readFile,
      writeFile: async (p: string, body: string) => { cache[p] = body; },
    };

    const first = await computeSessionCost(TRANSCRIPT, io as never);
    const transcriptReads = readFile.mock.calls.filter(([p]) => p === TRANSCRIPT).length;
    const second = await computeSessionCost(TRANSCRIPT, io as never);

    expect(second).toEqual(first);
    expect(readFile.mock.calls.filter(([p]) => p === TRANSCRIPT).length).toBe(transcriptReads);
  });

  it('recomputes when a source changes size, so an appended turn is never missed', async () => {
    const files = { [TRANSCRIPT]: row('msg_1', 'claude-sonnet-5', { input_tokens: 1_000_000 }) };
    const cache: Record<string, string> = {};
    const io = {
      readPrices: async () => PRICES,
      readDir: async () => { throw new Error('ENOENT'); },
      readFile: async (p: string) => {
        if (p in cache) return cache[p];
        if (p in files) return files[p];
        throw new Error('ENOENT');
      },
      writeFile: async (p: string, body: string) => { cache[p] = body; },
      stat: async (p: string) => {
        if (p in files) return { size: files[p].length, mtimeMs: 1 };
        throw new Error('ENOENT');
      },
    };

    const first = await computeSessionCost(TRANSCRIPT, io as never);
    files[TRANSCRIPT] += `\n${row('msg_2', 'claude-sonnet-5', { input_tokens: 1_000_000 })}`;
    const second = await computeSessionCost(TRANSCRIPT, io as never);

    expect(first!.cost).toBeCloseTo(3, 10);
    expect(second!.cost).toBeCloseTo(6, 10);
  });
});
