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
import { fileURLToPath } from 'url';

const HOME = process.env.CODEMIE_HOME || path.join(os.homedir(), '.codemie');
const CACHE_FILE = path.join(HOME, 'budget-cache.json');
const CONFIG_FILE = path.join(HOME, 'codemie-cli.config.json');
const CREDS_DIR = path.join(HOME, 'credentials');
const CACHE_TTL_MS = 60_000;
const CACHE_SCHEMA = 2; // bump when the cache.value shape changes, to discard stale pre-upgrade entries

// Cumulative session token totals, read from the CodeMie metrics-delta JSONL that the live
// SSO-proxy sync pipeline writes. Independent of the budget cache above.
const SESSIONS_DIR = path.join(HOME, 'sessions');
const TOKENS_CACHE_FILE = path.join(HOME, 'statusline-tokens-cache.json');
const TOKENS_CACHE_TTL_MS = 30_000; // deltas flush per proxy sync interval; keep the bar fresh-ish
const TOKENS_CACHE_SCHEMA = 1;
const TOKENS_MAX_SCAN = 60; // bound the correlation dir scan on this hot (per-render) path

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
  const target = `${userEmail.trim().toLowerCase()} (cli)`;
  return rows.find(r => r.project_name?.trim().toLowerCase() === target) ?? null;
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
  // Claude Code's own session id — carried on the Status payload as `session_id`, and also
  // recoverable from the transcript filename. Used to reverse-map to the CodeMie session id
  // when reading cumulative token totals; null when neither field is present.
  const transcriptPath = typeof ctx?.transcript_path === 'string' ? ctx.transcript_path : null;
  const sessionId = ctx?.session_id
    ?? (transcriptPath ? path.basename(transcriptPath, '.jsonl') : null);
  return {
    projectName: cwd ? path.basename(cwd) : '',
    cwd,
    sessionId,
    model: ctx?.model?.display_name ?? '',
    ctxPct: ctx?.context_window?.used_percentage ?? null,
    tokIn: ctx?.context_window?.total_input_tokens ?? null,
    tokOut: ctx?.context_window?.total_output_tokens ?? null,
    cost: ctx?.cost?.total_cost_usd ?? null,
    durationMs: ctx?.cost?.total_duration_ms ?? null,
  };
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return null;
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

export function ctxBar(pct) {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? C.red : clamped >= 70 ? C.yellow : C.green;
  const filled = Math.floor(clamped / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${c(color, bar)} ${pct}%`;
}

export function buildStatusLine({ projectName, branch, model, ctxPct, tokIn, tokOut, sessionTokens, cost, durationMs, budget, budgetError }) {
  // Line 1: identity/context — project, budget, branch.
  const line1 = [];
  if (projectName) line1.push(c(C.purple, `[${projectName}]`));
  if (budget)            line1.push(c(budgetColor(budget.pct), budget.text));
  else if (budgetError)  line1.push(c(C.yellow, `⚠ ${budgetError}`));
  if (branch) line1.push(c(C.blue, `(${branch})`));

  // Line 2 wraps at the model name: model + context/token/cost stats.
  const line2 = [];
  if (model) line2.push(c(C.cyan, `[${model}]`));

  const bar = ctxBar(ctxPct);
  if (bar) line2.push(bar);

  // Live context-window occupancy (main-thread; resets on compaction). Labeled `ctx` so it reads
  // as "how full is the window", not tokens billed — a different quantity from the cumulative Σ.
  const stats = [];
  if (tokIn != null)  stats.push(`in:${fmt(tokIn)}`);
  if (tokOut != null) stats.push(`out:${fmt(tokOut)}`);
  if (stats.length) line2.push(c(C.gray, `ctx ${stats.join(' ')}`));

  // Cumulative session totals from the metrics-delta file — cache-aware and (where the deltas
  // carry sidechain turns) subagent-inclusive. `new` is the per-turn uncached input Anthropic
  // reports in `input_tokens`; the cached context is counted separately under cR (read) / cW
  // (creation), so `new` reads far smaller than cR by design — that is expected, not a miscount.
  if (sessionTokens) {
    const seg = [`Σ new:${fmt(sessionTokens.in)}`, `out:${fmt(sessionTokens.out)}`];
    if (sessionTokens.cacheRead)     seg.push(`cR:${fmt(sessionTokens.cacheRead)}`);
    if (sessionTokens.cacheCreation) seg.push(`cW:${fmt(sessionTokens.cacheCreation)}`);
    line2.push(c(C.gray, seg.join(' ')));
  }

  if (typeof cost === 'number' && !Number.isNaN(cost)) line2.push(c(C.yellow, `$${cost.toFixed(4)}`));

  const dur = formatDuration(durationMs);
  if (dur) line2.push(c(C.gray, dur));

  // Wrap at the model name: line 1 above it, line 2 from the model onward. Drop an empty
  // line1 (no project/budget/branch) so no leading blank line is emitted.
  return [line1.join(' | '), line2.join(' | ')].filter(Boolean).join('\n');
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
  // Fast path: fresh cache, skip config/network entirely. Discard any cache entry that
  // isn't this schema version (e.g. a pre-upgrade string-shaped value) instead of trusting it.
  try {
    const cacheRaw = await readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(cacheRaw);
    const validShape = cache.schema === CACHE_SCHEMA
      && typeof cache.value === 'object' && cache.value !== null
      && typeof cache.value.text === 'string';
    if (validShape && Date.now() - cache.ts < CACHE_TTL_MS) {
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
  const { baseUrl } = profile ?? {};
  // codeMieUrl now lives on the scope-level workspace object (migration 006), and
  // userEmail is a top-level MultiProviderConfig field — neither is per-profile anymore.
  const codeMieUrl = config.workspace?.codeMieUrl;
  const userEmail = config.userEmail;
  if (!profile || !codeMieUrl || !baseUrl || !userEmail) {
    return { budget: null, budgetError: null }; // no CodeMie profile configured → skip silently
  }

  let headers;
  try {
    headers = await getAuthHeadersImpl(codeMieUrl);
  } catch (e) {
    return { budget: null, budgetError: e.message };
  }
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
    await writeFile(CACHE_FILE, JSON.stringify({ schema: CACHE_SCHEMA, ts: Date.now(), value: budget }), 'utf8');
    return { budget, budgetError: null };
  } catch (e) {
    return { budget: null, budgetError: e.message };
  }
}

// --- Cumulative session token totals (network-free; dependencies injectable for tests) ---

/**
 * Sum input/output/cache tokens across every MetricDelta the live sync pipeline has written for
 * this session, at ~/.codemie/sessions/{codemieSessionId}_metrics.jsonl. Unlike the context_window
 * snapshot (main-thread-only, resets on compaction), this is cumulative and cache-aware.
 *
 * Returns null — segment omitted — whenever there is nothing trustworthy to show: no session id,
 * no correlation record (e.g. a non-SSO-proxy run), no metrics file yet (before the first sync
 * flush), or a zero total. Never throws: the statusline must never crash Claude Code.
 *
 * Caveats, intentionally not papered over: totals lag by the proxy sync interval, and subagent
 * turns are included only insofar as the live deltas already carry sidechain usage.
 */
export async function resolveSessionTokens(claudeSessionId, {
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  readdir = fs.readdir,
  stat = fs.stat,
} = {}) {
  if (!claudeSessionId) return null;

  // Fast path: fresh cache for this exact Claude session — skip the dir scan entirely.
  try {
    const cache = JSON.parse(await readFile(TOKENS_CACHE_FILE, 'utf8'));
    if (cache.schema === TOKENS_CACHE_SCHEMA
      && cache.sessionId === claudeSessionId
      && typeof cache.value === 'object' && cache.value !== null
      && Date.now() - cache.ts < TOKENS_CACHE_TTL_MS) {
      return cache.value;
    }
  } catch {}

  try {
    // Reverse-map the Claude session id → CodeMie session id via the correlation records at
    // ~/.codemie/sessions/{sessionId}.json (or completed_{sessionId}.json once finalized).
    let files;
    try {
      files = await readdir(SESSIONS_DIR);
    } catch {
      return null; // sessions dir absent → nothing to show
    }

    // Newest-first by mtime, bounded, so the just-written active session record is checked first.
    const stated = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue; // records are .json; metrics/conversations are .jsonl
      try {
        const st = await stat(path.join(SESSIONS_DIR, f));
        stated.push({ f, mtime: st.mtimeMs });
      } catch {}
    }
    stated.sort((a, b) => b.mtime - a.mtime);

    let codemieSessionId = null;
    for (const { f } of stated.slice(0, TOKENS_MAX_SCAN)) {
      let record;
      try {
        record = JSON.parse(await readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      if (record?.correlation?.agentSessionId === claudeSessionId) {
        codemieSessionId = record.sessionId ?? path.basename(f, '.json').replace(/^completed_/, '');
        break;
      }
    }
    if (!codemieSessionId) return null;

    let raw;
    try {
      raw = await readFile(path.join(SESSIONS_DIR, `${codemieSessionId}_metrics.jsonl`), 'utf8');
    } catch {
      return null; // no metrics yet (e.g. before the first sync flush)
    }

    const totals = { in: 0, out: 0, cacheRead: 0, cacheCreation: 0 };
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let delta;
      try { delta = JSON.parse(line); } catch { continue; }
      const t = delta?.tokens;
      if (!t) continue;
      totals.in += t.input ?? 0;
      totals.out += t.output ?? 0;
      totals.cacheRead += t.cacheRead ?? 0;
      totals.cacheCreation += t.cacheCreation ?? 0;
    }

    if (totals.in + totals.out + totals.cacheRead + totals.cacheCreation === 0) return null;

    try {
      await writeFile(TOKENS_CACHE_FILE, JSON.stringify({
        schema: TOKENS_CACHE_SCHEMA, ts: Date.now(), sessionId: claudeSessionId, value: totals,
      }), 'utf8');
    } catch {}

    return totals;
  } catch {
    return null;
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
  const [budgetResult, branch, sessionTokens] = await Promise.all([
    resolveBudget(),
    branchPromise,
    resolveSessionTokens(basic.sessionId),
  ]);

  process.stdout.write(buildStatusLine({ ...basic, branch, ...budgetResult, sessionTokens }));
}

// Compares decoded paths (not raw strings) so this correctly matches even when the
// script's path contains characters import.meta.url percent-encodes (e.g. spaces).
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return fileURLToPath(metaUrl) === argv1;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  // Statusline must never crash Claude Code — swallow any unexpected error.
  main().catch(() => { process.stdout.write(''); });
}
