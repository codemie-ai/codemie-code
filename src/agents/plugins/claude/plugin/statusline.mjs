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
  if (typeof cost === 'number' && !Number.isNaN(cost)) stats.push(`$${cost.toFixed(4)}`);
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
  const { codeMieUrl, baseUrl, userEmail } = profile ?? {};
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
