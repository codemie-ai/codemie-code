# Consolidate Claude Code Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two divergent, inconsistent Claude Code statusline mechanisms (a dead `--status` flag path that throws ENOENT in production, and a working-but-incomplete `codemie install statusline` path) with a single implementation that auto-resolves CodeMie budget info from the active profile and always shows session cost/duration.

**Architecture:** Keep the existing "install once, deploy standalone artifact" pattern (`codemie-budget-status.js` deployed to `~/.claude/`, wired into `~/.claude/settings.json.statusLine`). Rewrite the deployed script (`plugin/statusline.mjs`) to auto-match the CodeMie budget row via the profile's `userEmail`, add session cost/duration from Claude Code's own stdin payload (always rendered, independent of network/profile state), and expose its logic as unit-testable pure functions. Retire the dead `--status`/`CODEMIE_STATUS` code path in `claude.plugin.ts` by making it a thin alias that calls the same `installStatusline()` used by `codemie install statusline`, rather than duplicating logic against a file that no longer exists.

**Tech Stack:** TypeScript (project code), plain dependency-free ESM (`plugin/statusline.mjs`, deployed standalone), Vitest.

## Global Constraints

- `plugin/statusline.mjs` must remain import-free of the project's `src/` tree and `node_modules` — it is copied into `~/.claude/` and executed via `node <path>` outside the installed package's module resolution.
- The CodeMie budget segment shows exactly 3 pieces of data: current spend (`current_spending`), percentage used (the API's `total` field), and reset time (`budget_reset_at`). Never show `budget_limit` (soft limit) or any hard-limit field.
- Budget row auto-resolution matches `row.project_name === \`${profile.userEmail} (cli)\`` — no manual/interactive selection at render time.
- Basic info (model, project/dir, branch, context-%, session cost, session duration) must always render, even with zero CodeMie profile/network connectivity.
- No profile configured → skip the budget segment silently (no `⚠` warning). Profile configured but fetch/auth fails → show a minimal `⚠ <reason>` segment, basic info still renders.
- Test-first per task per this project's Vitest conventions (`.ai-run/guides/testing/testing-patterns.md`): dynamic-import the module under test after mocks/spies are set up.

---

### Task 1: Rewrite `plugin/statusline.mjs` — testable pure functions, auto-resolved budget, always-render basic info

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.mjs` (full rewrite, 224 → ~190 lines)
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` (new)

**Interfaces:**
- Produces (named exports from `statusline.mjs`, importable by later tasks' tests and by nothing else — this file must stay dependency-free):
  - `matchBudgetRow(rows: Array<{project_name: string}>, userEmail: string): object | null`
  - `formatBudgetSegment(row: {current_spending: number, total: number, budget_reset_at: string} | null): {text: string, pct: number} | null`
  - `extractBasicInfo(ctx: object): {projectName, cwd, model, ctxPct, tokIn, tokOut, cost, durationMs}`
  - `formatDuration(ms: number | null): string | null`
  - `fmt(n: number): string`
  - `buildStatusLine(opts: {projectName, branch, model, ctxPct, tokIn, tokOut, cost, durationMs, budget, budgetError}): string`
  - `getAuthHeaders(codeMieUrl: string): Promise<{cookie?: string, authorization?: string} | null>`
  - `resolveBudget(deps?: {readFile?, writeFile?, fetchImpl?, getAuthHeadersImpl?}): Promise<{budget: {text,pct} | null, budgetError: string | null}>`
  - `main(): Promise<void>`

- [ ] **Step 1: Write failing tests for `matchBudgetRow`**

Create `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  matchBudgetRow,
  formatBudgetSegment,
  extractBasicInfo,
  formatDuration,
  fmt,
  buildStatusLine,
  resolveBudget,
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t matchBudgetRow`
Expected: FAIL — `statusline.mjs` has no export named `matchBudgetRow` (current file has no exports at all).

- [ ] **Step 3: Add `matchBudgetRow` (and the module-level export scaffolding) to `statusline.mjs`**

Replace the entire content of `src/agents/plugins/claude/plugin/statusline.mjs` with:

```javascript
#!/usr/bin/env node
// CodeMie statusline — shows model, project, branch, context, session cost/duration,
// and (when a CodeMie profile is configured) the CLI budget for the authenticated user.
// Deployed to ~/.claude/ by `codemie install statusline` (also triggered by the `--status`
// CLI flag, which calls the same installer). Runs standalone — Node builtins only, no
// project imports, since it executes via `node <path>` after the project process exits.
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const HOME = process.env.CODEMIE_HOME || path.join(os.homedir(), '.codemie');
const CACHE_FILE = path.join(HOME, 'budget-cache.json');
const CONFIG_FILE = path.join(HOME, 'codemie-cli.config.json');
const CREDS_DIR = path.join(HOME, 'credentials');
const CACHE_TTL_MS = 60_000;

const ENCRYPTION_KEY = (() => {
  const id = os.hostname() + os.platform() + os.arch();
  const hex = crypto.createHash('sha256').update(id).digest('hex');
  return crypto.createHash('sha256').update(hex).digest();
})();

function decrypt(text) {
  const parts = text.split(':');
  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const d = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    d.setAuthTag(authTag);
    return d.update(parts[2], 'hex', 'utf8') + d.final('utf8');
  }
  // Legacy CBC format: iv:encrypted (backward compat for existing stored credentials)
  const iv = Buffer.from(parts[0], 'hex');
  const d = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return d.update(parts[1], 'hex', 'utf8') + d.final('utf8');
}

function urlHash(rawUrl) {
  const normalized = rawUrl.replace(/\/$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function readCredsFile(filePath) {
  try {
    return JSON.parse(decrypt(await fs.readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export async function getAuthHeaders(codeMieUrl) {
  const hash = urlHash(codeMieUrl);

  const sso = await readCredsFile(path.join(CREDS_DIR, `sso-${hash}.enc`));
  if (sso?.cookies) {
    return { cookie: Object.entries(sso.cookies).map(([k, v]) => `${k}=${v}`).join(';') };
  }

  const jwt = await readCredsFile(path.join(CREDS_DIR, `jwt-sso-${hash}.enc`));
  if (jwt?.token) {
    return { authorization: `Bearer ${jwt.token}` };
  }

  return null;
}

// --- Pure functions (unit-testable, no filesystem/network access) ---

export function matchBudgetRow(rows, userEmail) {
  if (!Array.isArray(rows) || !userEmail) return null;
  const target = `${userEmail} (cli)`;
  return rows.find(r => r.project_name === target) ?? null;
}

export function formatBudgetSegment(row) {
  if (!row) return null;
  const pct = Math.round(row.total ?? 0);
  const reset = row.budget_reset_at ? new Date(row.budget_reset_at).toLocaleDateString() : '?';
  return {
    text: `$${row.current_spending.toFixed(2)} (${pct}%) resets ${reset}`,
    pct,
  };
}

export function extractBasicInfo(ctx) {
  const cwd = ctx?.workspace?.current_dir ?? ctx?.cwd ?? '';
  return {
    projectName: cwd ? path.basename(cwd) : '',
    cwd,
    model: ctx?.model?.display_name ?? '',
    ctxPct: ctx?.context_window?.used_percentage ?? null,
    tokIn: ctx?.context_window?.total_input_tokens ?? null,
    tokOut: ctx?.context_window?.total_output_tokens ?? null,
    cost: ctx?.cost?.total_cost_usd ?? null,
    durationMs: ctx?.cost?.total_duration_ms ?? null,
  };
}

export function formatDuration(ms) {
  if (ms == null) return null;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const C = {
  reset:  '\x1b[0m',
  purple: '\x1b[38;2;177;185;249m',
  green:  '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  red:    '\x1b[0;31m',
  cyan:   '\x1b[0;36m',
  blue:   '\x1b[0;94m',
  gray:   '\x1b[0;37m',
};
const c = (color, text) => `${color}${text}${C.reset}`;

function budgetColor(pct) {
  return pct > 85 ? C.red : pct > 30 ? C.yellow : C.green;
}

export function buildStatusLine({ projectName, branch, model, ctxPct, tokIn, tokOut, cost, durationMs, budget, budgetError }) {
  const parts = [];

  if (projectName) parts.push(c(C.purple, `[${projectName}]`));
  if (budget)            parts.push(c(budgetColor(budget.pct), budget.text));
  else if (budgetError)  parts.push(c(C.yellow, `⚠ ${budgetError}`));
  if (branch) parts.push(c(C.blue, `(${branch})`));
  if (model)  parts.push(c(C.cyan, `[${model}]`));

  const stats = [];
  if (ctxPct != null) stats.push(`ctx:${ctxPct}%`);
  if (tokIn != null)  stats.push(`in:${fmt(tokIn)}`);
  if (tokOut != null) stats.push(`out:${fmt(tokOut)}`);
  if (cost != null)   stats.push(`$${cost.toFixed(4)}`);
  const dur = formatDuration(durationMs);
  if (dur) stats.push(dur);
  if (stats.length) parts.push(c(C.gray, stats.join(' ')));

  return parts.join(' | ');
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function gitBranch(cwd) {
  return new Promise(resolve => {
    exec(
      'git --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks rev-parse --short HEAD 2>/dev/null',
      { cwd, timeout: 2000 },
      (_, stdout) => resolve(stdout.trim() || '')
    );
  });
}

// --- Budget resolution (network/filesystem; dependencies injectable for tests) ---

export async function resolveBudget({
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  fetchImpl = fetch,
  getAuthHeadersImpl = getAuthHeaders,
} = {}) {
  // Fast path: fresh cache, skip config/network entirely.
  try {
    const cacheRaw = await readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(cacheRaw);
    if (Date.now() - cache.ts < CACHE_TTL_MS) {
      return { budget: cache.value, budgetError: null };
    }
  } catch {}

  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return { budget: null, budgetError: null }; // no CodeMie config at all → skip silently
  }

  const profile = config.profiles?.[config.activeProfile];
  const { codeMieUrl, baseUrl, userEmail } = profile ?? {};
  if (!profile || !codeMieUrl || !baseUrl || !userEmail) {
    return { budget: null, budgetError: null }; // no CodeMie profile configured → skip silently
  }

  const headers = await getAuthHeadersImpl(codeMieUrl);
  if (!headers) {
    return { budget: null, budgetError: 'reauthenticate' };
  }

  try {
    const res = await fetchImpl(`${baseUrl}/v1/analytics/budget_usage`, {
      headers: { 'Content-Type': 'application/json', 'X-CodeMie-Client': 'codemie-cli', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const row = matchBudgetRow(json?.data?.rows, userEmail);
    if (!row) throw new Error('budget row not found');

    const budget = formatBudgetSegment(row);
    await writeFile(CACHE_FILE, JSON.stringify({ ts: Date.now(), value: budget }), 'utf8');
    return { budget, budgetError: null };
  } catch (e) {
    return { budget: null, budgetError: e.message };
  }
}

export async function main() {
  const stdinRaw = await readStdin();

  let basic;
  try {
    basic = extractBasicInfo(JSON.parse(stdinRaw));
  } catch {
    basic = extractBasicInfo({});
  }

  const branchPromise = basic.cwd ? gitBranch(basic.cwd) : Promise.resolve('');
  const [budgetResult, branch] = await Promise.all([resolveBudget(), branchPromise]);

  process.stdout.write(buildStatusLine({ ...basic, branch, ...budgetResult }));
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  // Statusline must never crash Claude Code — swallow any unexpected error.
  main().catch(() => { process.stdout.write(''); });
}
```

- [ ] **Step 4: Run test to verify `matchBudgetRow` tests pass**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t matchBudgetRow`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing tests for `formatBudgetSegment`**

Append to the test file:

```typescript
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
```

- [ ] **Step 6: Run test to verify it passes (implementation already added in Step 3)**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t formatBudgetSegment`
Expected: PASS (2 tests)

- [ ] **Step 7: Write failing tests for `extractBasicInfo`, `formatDuration`, `fmt`**

Append to the test file:

```typescript
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
});

describe('fmt', () => {
  it('formats large numbers with k/M suffixes', () => {
    expect(fmt(500)).toBe('500');
    expect(fmt(1500)).toBe('1.5k');
    expect(fmt(2_500_000)).toBe('2.5M');
  });
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t "extractBasicInfo|formatDuration|fmt"`
Expected: PASS (6 tests)

- [ ] **Step 9: Write failing tests for `buildStatusLine` — always-render basic info, clean no-profile skip, budget-error indicator**

Append to the test file:

```typescript
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
});
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t buildStatusLine`
Expected: PASS (3 tests)

- [ ] **Step 11: Write failing tests for `resolveBudget` — no-profile skip, reauth, fetch failure, success**

Append to the test file:

```typescript
describe('resolveBudget', () => {
  const noCache = vi.fn().mockRejectedValue(new Error('ENOENT'));

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
    const readFile = vi.fn().mockResolvedValueOnce(JSON.stringify({ ts: Date.now(), value: { text: 'cached', pct: 5 } }));
    const fetchImpl = vi.fn();
    const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl, getAuthHeadersImpl: vi.fn() });
    expect(result).toEqual({ budget: { text: 'cached', pct: 5 }, budgetError: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts -t resolveBudget`
Expected: PASS (6 tests)

- [ ] **Step 13: Run the full test file and commit**

Run: `npx vitest src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`
Expected: PASS (all tests in the file)

```bash
git add src/agents/plugins/claude/plugin/statusline.mjs src/agents/plugins/claude/plugin/__tests__/statusline.test.ts
git commit -m "feat(statusline): auto-resolve budget by user email, always render session cost/duration"
```

---

### Task 2: Rewrite `statusline-installer.ts` — drop interactive budget selection, report install-collision state, clean up legacy artifact on uninstall

**Files:**
- Modify: `src/agents/plugins/claude/statusline-installer.ts`
- Test: `src/agents/plugins/claude/__tests__/statusline-installer.test.ts` (new — this module currently has zero coverage)

**Interfaces:**
- Consumes: nothing from Task 1 directly (reads `plugin/statusline.mjs` as raw text, doesn't import its exports).
- Produces:
  - `installStatusline(): Promise<{ scriptPath: string; alreadyConfigured: boolean }>` — return type CHANGED from `Promise<string>`. `alreadyConfigured` is `true` when `settings.json` already had a `statusLine` entry before this call (used by Task 4 to decide whether `--status` owns session-scoped cleanup).
  - `uninstallStatusline(): Promise<void>` — now also removes the legacy `~/.claude/codemie-statusline.mjs` artifact if present (orphan cleanup from the old broken `--status` mechanism).
  - `isStatuslineInstalled(): boolean` — unchanged.
  - `STATUSLINE_NAME`, `STATUSLINE_DISPLAY_NAME`, `STATUSLINE_DESCRIPTION` — unchanged.
  - REMOVED: `promptBudgetSelection()` — superseded by Task 1's auto-resolution (email + "(cli)" match), no longer needed at install time.

- [ ] **Step 1: Write failing tests for `installStatusline`**

Create `src/agents/plugins/claude/__tests__/statusline-installer.test.ts`:

```typescript
/**
 * Tests for the statusline installer (`codemie install statusline` / `codemie uninstall statusline`).
 *
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');
vi.mock('fs');

// statusline-installer.ts imports these via the `@/` alias, so mock that exact
// specifier (not a relative path) to guarantee the resolver targets the same module.
vi.mock('@/utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getDirname: vi.fn(() => '/fake/dist/plugins/claude'),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

describe('statusline-installer', () => {
  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    fsp = await import('fs/promises');
    fsMod = await import('fs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installStatusline', () => {
    it('deploys the script and reports alreadyConfigured=false when settings.json has no statusLine yet', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('#!/usr/bin/env node\n// statusline' as any) // script source
        .mockResolvedValueOnce(JSON.stringify({ theme: 'dark' }) as any);   // settings.json
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(false);
      expect(result.scriptPath).toBe('/home/testuser/claude/codemie-budget-status.js');

      const settingsWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === '/home/testuser/claude/settings.json');
      expect(settingsWrite).toBeDefined();
      const written = JSON.parse(settingsWrite![1] as string);
      expect(written.statusLine.type).toBe('command');
      expect(written.statusLine.refreshInterval).toBe(60);
    });

    it('reports alreadyConfigured=true (and still refreshes settings) when statusLine already exists', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('// script' as any)
        .mockResolvedValueOnce(JSON.stringify({ statusLine: { type: 'command', command: 'node "/old.js"' } }) as any);
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(true);
    });

    it('creates ~/.claude when it does not exist', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await installStatusline();

      expect(fsp.mkdir).toHaveBeenCalledWith('/home/testuser/claude', { recursive: true });
    });

    it('throws ConfigurationError and does not overwrite malformed settings.json', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('// script' as any)
        .mockResolvedValueOnce('{ bad json' as any);
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await expect(installStatusline()).rejects.toThrow('Could not parse ~/.claude/settings.json');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/agents/plugins/claude/__tests__/statusline-installer.test.ts -t installStatusline`
Expected: FAIL — `installStatusline()` currently returns a plain string, not `{ scriptPath, alreadyConfigured }`.

- [ ] **Step 3: Rewrite `statusline-installer.ts`**

Replace the entire content of `src/agents/plugins/claude/statusline-installer.ts` with:

```typescript
import { readFile, writeFile, mkdir, chmod, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDirname, resolveHomeDir } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';

export const STATUSLINE_NAME = 'statusline';
export const STATUSLINE_DISPLAY_NAME = 'CodeMie Statusline';
export const STATUSLINE_DESCRIPTION = 'Budget usage, project, branch, model, context & token stats for Claude Code';

const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
const REFRESH_INTERVAL = 60;

export interface InstallStatuslineResult {
  scriptPath: string;
  alreadyConfigured: boolean;
}

export async function installStatusline(): Promise<InstallStatuslineResult> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin/statusline.mjs'),
    'utf-8'
  );

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeFile(scriptPath, scriptContent, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json, aborting to avoid data loss',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  const alreadyConfigured = Boolean(settings.statusLine);

  settings.statusLine = {
    type: 'command',
    command: `node "${scriptPath}"`,
    refreshInterval: REFRESH_INTERVAL,
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  logger.debug('[Statusline] Installed', ...sanitizeLogArgs({ scriptPath }));
  return { scriptPath, alreadyConfigured };
}

export async function uninstallStatusline(): Promise<void> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const legacyScriptPath = join(claudeHome, LEGACY_SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  if (existsSync(scriptPath)) {
    await rm(scriptPath);
  }
  // Clean up the orphaned artifact from the old, now-removed --status flag mechanism,
  // in case it was ever written by a version prior to this consolidation.
  if (existsSync(legacyScriptPath)) {
    await rm(legacyScriptPath);
  }

  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (settings.statusLine) {
        delete settings.statusLine;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json during uninstall',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  logger.debug('[Statusline] Uninstalled');
}

export function isStatuslineInstalled(): boolean {
  return existsSync(join(homedir(), '.claude', SCRIPT_FILENAME));
}
```

Note: `promptBudgetSelection`, and the `ConfigLoader`/`CredentialStore` imports it used, are deleted entirely — budget resolution now happens automatically inside `plugin/statusline.mjs` at render time (Task 1), keyed off `profile.userEmail`, with no interactive step required.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest src/agents/plugins/claude/__tests__/statusline-installer.test.ts -t installStatusline`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing tests for `uninstallStatusline` (including legacy-artifact cleanup) and `isStatuslineInstalled`**

Append to the test file:

```typescript
  describe('uninstallStatusline', () => {
    it('removes the script and the statusLine settings entry', async () => {
      vi.mocked(fsMod.existsSync).mockImplementation((p: any) =>
        p === '/home/testuser/claude/codemie-budget-status.js' || p === '/home/testuser/claude/settings.json'
      );
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {}, theme: 'dark' }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith('/home/testuser/claude/codemie-budget-status.js');
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });

    it('also removes the legacy codemie-statusline.mjs artifact if present', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({}) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith('/home/testuser/claude/codemie-statusline.mjs');
    });

    it('skips removal when neither script exists', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(false);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).not.toHaveBeenCalled();
    });
  });

  describe('isStatuslineInstalled', () => {
    it('returns true when the script file exists', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      const { isStatuslineInstalled } = await import('../statusline-installer.js');
      expect(isStatuslineInstalled()).toBe(true);
    });

    it('returns false when the script file does not exist', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(false);
      const { isStatuslineInstalled } = await import('../statusline-installer.js');
      expect(isStatuslineInstalled()).toBe(false);
    });
  });
});
```

- [ ] **Step 6: Run the full test file to verify everything passes**

Run: `npx vitest src/agents/plugins/claude/__tests__/statusline-installer.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add src/agents/plugins/claude/statusline-installer.ts src/agents/plugins/claude/__tests__/statusline-installer.test.ts
git commit -m "refactor(statusline): drop interactive budget selection, report install-collision state, clean legacy artifact on uninstall"
```

---

### Task 3: Update `codemie install statusline` CLI wiring

**Files:**
- Modify: `src/cli/commands/install.ts:7-14` (imports), `:266-298` (install branch)

**Interfaces:**
- Consumes: `installStatusline(): Promise<{ scriptPath, alreadyConfigured }>` from Task 2 (no longer `Promise<string>`); `promptBudgetSelection` no longer exists (import removed).

**Test-first: no** — thin CLI presentation wiring (spinner/console messaging) with no existing test coverage for this branch and no project convention for testing `ora`/`chalk` console output in this file (`install.version-selection.test.ts` covers a different code path). Verified via `qa-gates` (typecheck catches the changed `installStatusline` return shape) and a manual `codemie install statusline` run in Task 6's manual verification step.

- [ ] **Step 1: Update the imports**

In `src/cli/commands/install.ts`, replace lines 7-14:

```typescript
import {
  STATUSLINE_NAME,
  STATUSLINE_DISPLAY_NAME,
  STATUSLINE_DESCRIPTION,
  installStatusline,
  isStatuslineInstalled,
} from '@/agents/plugins/claude/statusline-installer.js';
```

(Removed `promptBudgetSelection` from the named imports.)

- [ ] **Step 2: Update the install branch**

Replace lines 266-298 (the `if (name === STATUSLINE_NAME) { ... }` block):

```typescript
        if (name === STATUSLINE_NAME) {
          const alreadyInstalled = isStatuslineInstalled();
          const spinnerLabel = alreadyInstalled
            ? `Updating ${STATUSLINE_DISPLAY_NAME}...`
            : `Installing ${STATUSLINE_DISPLAY_NAME}...`;
          const spinner = ora(spinnerLabel).start();

          try {
            const { scriptPath } = await installStatusline();
            const successMsg = alreadyInstalled
              ? `${STATUSLINE_DISPLAY_NAME} updated`
              : `${STATUSLINE_DISPLAY_NAME} installed`;
            spinner.succeed(successMsg);
            console.log();
            console.log(chalk.cyan('💡 The statusline appears at the bottom of every Claude Code session'));
            console.log(chalk.white(`   ${STATUSLINE_DESCRIPTION}`));
            console.log(chalk.gray(`   Script: ${scriptPath}`));
            console.log(chalk.gray('   Budget is auto-detected from your authenticated CodeMie profile — no setup needed'));
            console.log();
          } catch (error: unknown) {
            spinner.fail(`Failed to install ${STATUSLINE_DISPLAY_NAME}`);
            throw error;
          }
          return;
        }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms `installStatusline()`'s new return shape is consumed correctly and `promptBudgetSelection` is not referenced anywhere in this file anymore).

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/install.ts
git commit -m "chore(cli): stop prompting for budget selection, budget is now auto-resolved"
```

---

### Task 4: Remove the dead `--status` code path in `claude.plugin.ts` — replace with a working alias to `installStatusline()`

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts:21` (import), `:203-265` (`beforeRun` statusline block)
- Test: `src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts` (full rewrite — the existing file only tests the removed dead path and its `fs` mocks silently masked the production `ENOENT`)

**Interfaces:**
- Consumes: `installStatusline(): Promise<{ scriptPath, alreadyConfigured }>` from Task 2, via `import('./statusline-installer.js')` (same directory).
- Produces: `ClaudePluginMetadata.lifecycle.beforeRun`/`afterRun` — same external signature as before; `afterRun`'s cleanup logic (lines 270-301) is UNCHANGED and is retained (not dead) — it now correctly cleans up only when `--status` enabled the statusline fresh this session, and leaves an existing persistent `codemie install statusline` setup untouched.

- [ ] **Step 1: Write failing tests for the new `beforeRun`/`afterRun` behavior**

Replace the entire content of `src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts`:

```typescript
/**
 * Tests for Claude Plugin statusline lifecycle hooks (--status flag).
 *
 * The --status flag is a thin alias for `installStatusline()` (the same function
 * `codemie install statusline` uses) — it must not duplicate deploy/settings logic.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../statusline-installer.js', () => ({
  installStatusline: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;
type AfterRunFn = (exitCode: number, env: HookEnv) => Promise<void>;

describe('Claude Plugin – statusline lifecycle hooks', () => {
  let beforeRun: BeforeRunFn;
  let afterRun: AfterRunFn;
  let installerMod: { installStatusline: ReturnType<typeof vi.fn> };
  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');
  let loggerMod: { logger: Record<string, ReturnType<typeof vi.fn>> };

  const mockConfig: AgentConfig = {};

  beforeEach(async () => {
    vi.resetModules(); // Reset module cache → resets statuslineManagedThisSession to false
    vi.resetAllMocks();

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;
    afterRun = mod.ClaudePluginMetadata.lifecycle!.afterRun!;

    installerMod = (await import('../statusline-installer.js')) as any;
    fsp = await import('fs/promises');
    fsMod = await import('fs');
    loggerMod = (await import('../../../../utils/logger.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('beforeRun', () => {
    it('should not call installStatusline when CODEMIE_STATUS is not set', async () => {
      const env: HookEnv = { CODEMIE_PROFILE_NAME: 'default' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(installerMod.installStatusline).not.toHaveBeenCalled();
    });

    it('should call installStatusline and mark the session managed when not already configured', async () => {
      installerMod.installStatusline.mockResolvedValue({
        scriptPath: '/home/testuser/claude/codemie-budget-status.js',
        alreadyConfigured: false,
      });

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(installerMod.installStatusline).toHaveBeenCalledTimes(1);

      // Session-managed → afterRun must clean up settings.json.
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        JSON.stringify({ statusLine: { type: 'command', command: 'node "x"' }, theme: 'dark' }) as any
      );
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await afterRun(0, {});

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });

    it('should NOT mark the session managed when a persistent install already existed', async () => {
      installerMod.installStatusline.mockResolvedValue({
        scriptPath: '/home/testuser/claude/codemie-budget-status.js',
        alreadyConfigured: true,
      });

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      await afterRun(0, {}); // must be a no-op — persistent `codemie install statusline` config must survive

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should log a warning and not throw when installStatusline fails', async () => {
      installerMod.installStatusline.mockRejectedValue(new Error('disk full'));

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to configure statusline'),
        expect.anything(),
      );
    });
  });

  describe('afterRun', () => {
    it('should not touch files when statusline was not managed in this session', async () => {
      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should reset the module-level flag so a second afterRun call is a no-op', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {} }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await afterRun(0, {});
      vi.resetAllMocks();

      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should log a sanitized warning when settings cleanup fails', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{ bad json' as any);

      await afterRun(0, {});

      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up statusLine'),
        expect.anything(),
      );
    });

    it('should skip cleanup when settings.json does not exist', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(false);

      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts`
Expected: FAIL — current `beforeRun` reads a nonexistent file path (`plugin/codemie-statusline.mjs`) directly via `fs/promises`, never calls `installStatusline()`, so `installerMod.installStatusline` is never invoked and the mocked-fs-based assertions from the old test no longer apply.

- [ ] **Step 3: Replace the dead statusline block in `claude.plugin.ts`**

In `src/agents/plugins/claude/claude.plugin.ts`, change line 21 from:

```typescript
import { resolveHomeDir, getDirname } from '../../../utils/paths.js';
```

to:

```typescript
import { resolveHomeDir } from '../../../utils/paths.js';
```

(`getDirname` was only used by the dead block being replaced.)

Then replace lines 203-265 (everything from the `// Statusline setup:` comment through the closing `}` of the `if (env.CODEMIE_STATUS === '1')` block, just before `return env;`):

```typescript
      // Statusline setup: when --status is passed, ensure the CodeMie statusline is
      // installed — the same installer `codemie install statusline` uses, so there is
      // exactly one statusline implementation instead of a separate duplicated one here.
      // https://code.claude.com/docs/en/statusline
      if (env.CODEMIE_STATUS === '1') {
        try {
          const { installStatusline } = await import('./statusline-installer.js');
          const { alreadyConfigured } = await installStatusline();
          // Only clean up on afterRun if THIS session enabled it — a persistent
          // `codemie install statusline` setup must survive after the session ends.
          statuslineManagedThisSession = !alreadyConfigured;
        } catch (error) {
          logger.warn(
            '[Claude] Failed to configure statusline via --status flag',
            ...sanitizeLogArgs({
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
```

Leave `afterRun` (lines 270-301 in the original file) completely unchanged — it already correctly cleans up `settings.statusLine` only when `statuslineManagedThisSession` is true, which is exactly the behavior the new `beforeRun` now drives.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (confirms `getDirname` removal didn't leave any other reference, and no unused imports remain)

- [ ] **Step 6: Commit**

```bash
git add src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts
git commit -m "fix(claude): replace dead --status ENOENT code path with a working installStatusline() alias"
```

---

### Task 5: Remove the superseded `statuslineBudgetName` field

**Files:**
- Modify: `src/env/types.ts:138-139`

**Test-first: no** — pure type-surface deletion; the codebase-wide grep in this task's investigation confirmed the only remaining references were in files already rewritten by Tasks 1-2 (which no longer read/write this field), so `npm run typecheck` is sufficient to catch any missed usage.

- [ ] **Step 1: Remove the field**

In `src/env/types.ts`, delete lines 138-139:

```typescript
  // Statusline budget tracking
  statuslineBudgetName?: string; // Budget row name selected during statusline install
```

from the `ProviderProfile` interface (leave the blank line above/below tidy — no other fields in the interface are affected).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — confirms no remaining code reads or writes `statuslineBudgetName` (Tasks 1-3 already removed every call site).

- [ ] **Step 3: Commit**

```bash
git add src/env/types.ts
git commit -m "chore(types): remove statuslineBudgetName, superseded by automatic budget-row resolution"
```

---

### Task 6: Full-suite verification and manual smoke check

**Files:** none (verification only)

**Test-first: no** — this task is the verification gate, not new functionality.

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test:unit`
Expected: all tests pass, including the four files touched/added in Tasks 1, 2, and 4.

- [ ] **Step 2: Run typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors; `npm run build` succeeds (confirms `copy-plugins.js` still copies the rewritten `plugin/statusline.mjs` into `dist/` correctly, since the filename didn't change).

- [ ] **Step 3: Manual smoke check of the auto-resolved budget path**

Run (from a shell with a configured CodeMie SSO/JWT profile):

```bash
echo '{"model":{"display_name":"Claude Sonnet 5"},"workspace":{"current_dir":"'"$(pwd)"'"},"context_window":{"used_percentage":10,"total_input_tokens":100,"total_output_tokens":50},"cost":{"total_cost_usd":0.1234,"total_duration_ms":45000}}' | node dist/agents/plugins/claude/plugin/statusline.mjs
```

Expected: a single line containing the project name, the auto-resolved budget (current spend / percentage / reset date — no soft/hard limit shown), the git branch, the model name, and `ctx:10%`, token counts, `$0.1234`, and `0m 45s` — with no `⚠` if the profile is configured and reachable.

- [ ] **Step 4: Manual smoke check of the `--status` flag alias and `codemie install statusline`**

Run:

```bash
node bin/codemie.js install statusline
cat ~/.claude/settings.json | grep -A3 statusLine
node bin/agent-executor.js claude --status --help
```

Expected: `codemie install statusline` reports success without any interactive budget-selection prompt; `~/.claude/settings.json` contains a `statusLine` entry pointing at `codemie-budget-status.js`; the `--status` flag no longer throws `ENOENT`.

- [ ] **Step 5: No commit for this task** — it is verification-only. If any step fails, return to the relevant task above, fix, and re-run this task's checks before proceeding.
