#!/usr/bin/env node
// CodeMie statusline — shows model, project, branch, context, session cost/duration,
// and (when a CodeMie profile is configured) the CLI budget for the authenticated user.
// When the request was routed to a different backend model (CodeMie Switchyard or the
// LiteLLM router), the actual model is read from the routing headers the proxy injects
// into the transcript and shown alongside the nominal one — see resolveActualModel().
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
    transcriptPath: ctx?.transcript_path ?? '',
    modelId: ctx?.model?.id ?? '',
    model: ctx?.model?.display_name ?? '',
    ctxPct: ctx?.context_window?.used_percentage ?? null,
    tokIn: ctx?.context_window?.total_input_tokens ?? null,
    tokOut: ctx?.context_window?.total_output_tokens ?? null,
    cost: ctx?.cost?.total_cost_usd ?? null,
    durationMs: ctx?.cost?.total_duration_ms ?? null,
  };
}

// --- Actual (routed) model resolution ---
//
// Claude Code's own stdin JSON only ever reports the nominal model (`model.id`, the
// alias/tier the session was started with). When CodeMie Switchyard or the LiteLLM router
// dispatches a turn to a different backend model, that can surface two ways in the transcript's
// most recent assistant turn (transcript_path):
//   1. Routing headers — the proxy's routing-header-injector plugin copies the upstream
//      router's response headers onto the response body (see
//      src/providers/plugins/sso/proxy/plugins/routing-header-injector.plugin.ts), which
//      Claude Code then persists verbatim. Authoritative when present: the proxy tags these
//      explicitly, so they win over the body-model heuristic below.
//   2. The response body's own `model` field — every Anthropic-compatible response reports
//      the model that actually generated it. A router that doesn't emit routing headers (or
//      a deployment where this proxy isn't involved at all) still shows the truth here, so
//      it's a fallback signal rather than depending on headers alone.
//
// Header field precedence mirrors src/cli/commands/analytics/cost/usage-readers.ts's
// `routedModel` so the statusline and the analytics report agree when both are present.

const ROUTED_MODEL_TAIL_BYTES = 65_536; // last 64KB — comfortably covers the most recent turn(s)

// Claude model family names, used to tell "genuinely routed to a different tier" apart from
// "alias resolved to its concrete dated/region-qualified snapshot", which happens on every
// request regardless of routing and must never be shown as if it were routing.
const MODEL_FAMILY_PATTERN = /(opus|sonnet|haiku|fable)/i;

/** Pulls the actual dispatched model out of a transcript line's `message` object, if present. */
export function extractRoutedModel(message) {
  if (!message || typeof message !== 'object') return null;
  return message.x_codemie_routing_capable_model ?? message['x-litellm-router-routed-model'] ?? null;
}

function modelFamily(modelId) {
  const match = modelId ? MODEL_FAMILY_PATTERN.exec(modelId) : null;
  return match ? match[1].toLowerCase() : null;
}

/** Strips Bedrock region/provider qualifiers (`converse/global.anthropic.` / `eu.anthropic.`) and its `-v1:0` suffix. */
export function normalizeModelId(modelId) {
  if (!modelId) return '';
  return modelId
    .toLowerCase()
    .replace(/^converse\//, '')
    .replace(/^[a-z0-9-]+\.anthropic\./, '')
    .replace(/-v\d+:\d+$/, '');
}

/**
 * True when two model identifiers name the same tier — either a recognized family (opus/
 * sonnet/haiku/fable) matches on both sides, or, when neither side matches a known family,
 * the Bedrock-normalized identifiers are identical. Used to avoid flagging an alias's normal
 * resolution to its concrete provider snapshot as if it were routing.
 */
export function sameModelFamily(a, b) {
  if (!a || !b) return false;
  const famA = modelFamily(a);
  const famB = modelFamily(b);
  if (famA && famB) return famA === famB;
  return normalizeModelId(a) === normalizeModelId(b);
}

/**
 * Scans transcript JSONL text backwards for the most recent assistant turn and returns the
 * response body's own model plus any header-injected routed model. The first (partial) line
 * of a tail read is expected to fail JSON.parse when the read didn't start at a line boundary
 * — that's normal, not an error, so parse failures are skipped rather than treated as a reason
 * to stop scanning.
 */
export function parseLastAssistantTurn(tailText) {
  if (!tailText) return null;
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = parsed?.message;
    if (parsed?.type === 'assistant' && message?.model) {
      return { responseModel: message.model, headerRoutedModel: extractRoutedModel(message) };
    }
  }
  return null;
}

async function defaultReadTail(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(length), position: start });
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Resolves the actual routed model for the current session, or null when there is nothing
 * useful to show — no transcript, an unreadable transcript, or the best available signal
 * (routing headers, falling back to the response body's own model) names the same tier as
 * `nominalModelId`. Never throws: the statusline must keep rendering even if the transcript
 * is mid-write or has already rotated away.
 */
export async function resolveActualModel(transcriptPath, nominalModelId, { readTail = defaultReadTail } = {}) {
  if (!transcriptPath) return null;
  let tail;
  try {
    tail = await readTail(transcriptPath, ROUTED_MODEL_TAIL_BYTES);
  } catch {
    return null;
  }
  const turn = parseLastAssistantTurn(tail);
  if (!turn) return null;
  const candidate = turn.headerRoutedModel ?? turn.responseModel;
  if (!candidate) return null;
  const nominal = nominalModelId || turn.responseModel;
  // Display the Bedrock-stripped form — the raw candidate may be a fully qualified backend
  // id (e.g. `converse/global.anthropic.claude-haiku-4-5-20251001-v1:0`), which is accurate
  // but not what a human wants to read in a one-line statusline.
  return sameModelFamily(nominal, candidate) ? null : normalizeModelId(candidate);
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

export function buildStatusLine({ projectName, branch, model, actualModel, ctxPct, tokIn, tokOut, cost, durationMs, budget, budgetError }) {
  const parts = [];

  if (projectName) parts.push(c(C.purple, `[${projectName}]`));
  if (budget)            parts.push(c(budgetColor(budget.pct), budget.text));
  else if (budgetError)  parts.push(c(C.yellow, `⚠ ${budgetError}`));
  if (branch) parts.push(c(C.blue, `(${branch})`));
  if (model)  parts.push(c(C.cyan, `[${actualModel ? `${model} → ${actualModel}` : model}]`));

  const bar = ctxBar(ctxPct);
  if (bar) parts.push(bar);

  const stats = [];
  if (tokIn != null)  stats.push(`in:${fmt(tokIn)}`);
  if (tokOut != null) stats.push(`out:${fmt(tokOut)}`);
  if (stats.length) parts.push(c(C.gray, stats.join(' ')));

  if (typeof cost === 'number' && !Number.isNaN(cost)) parts.push(c(C.yellow, `$${cost.toFixed(4)}`));

  const dur = formatDuration(durationMs);
  if (dur) parts.push(c(C.gray, dur));

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
  const [budgetResult, branch, actualModel] = await Promise.all([
    resolveBudget(),
    branchPromise,
    resolveActualModel(basic.transcriptPath, basic.modelId),
  ]);

  process.stdout.write(buildStatusLine({ ...basic, branch, actualModel, ...budgetResult }));
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
