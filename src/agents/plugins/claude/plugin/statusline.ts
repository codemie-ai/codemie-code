#!/usr/bin/env node
// CodeMie statusline — shows model, project, branch, context, session cost/duration,
// and (when a CodeMie profile is configured) the CLI budget for the authenticated user.
// When the request was routed to a different backend model, the actual model is read from
// the routing headers the proxy injects into the transcript and shown alongside the nominal
// one — see resolveActualModel().
//
// Deployed to ~/.claude/ by `codemie install statusline` (also triggered by the `--status`
// CLI flag, which calls the same installer). Runs standalone — Claude Code invokes it as
// `node <path>` from ~/.claude/settings.json as a detached process after the CLI itself has
// already exited, with no node_modules resolution available. This source file is nonetheless
// normal TypeScript with normal project imports: a bundling build step (esbuild) is planned to
// bundle it into a single self-contained ESM file at build time, which the installer would then
// deploy as one flat artifact with no sibling files or shims — see the statusline-installer.ts
// and scripts/ directory for the current state of that pipeline.
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from '@/utils/exec.js';
// Bundled directly into the artifact by scripts/bundle-statusline.mjs — the same modules the rest
// of the CLI imports unbundled, so routing headers, Bedrock regional pricing, and credential
// decryption are each resolved in exactly one place, read here and there rather than re-derived.
// credential-crypto.js specifically (not security.js, which also owns it) — security.ts pulls in
// the optional `keytar` native module, which esbuild cannot bundle at all (see that file's own
// header comment); importing security.js here breaks the build outright.
import { parseRoutingHeaders } from '@/utils/routing-headers.mjs';
import { parseBackendModelName, applyBedrockRegionalPremium } from '@/utils/bedrock-pricing.mjs';
import { deriveMachineEncryptionKey, decryptWithKey, deriveUrlStorageKey, deriveLegacyUrlStorageKey } from '@/utils/credential-crypto.js';

const HOME = process.env.CODEMIE_HOME || path.join(os.homedir(), '.codemie');
const CACHE_FILE = path.join(HOME, 'budget-cache.json');
const CONFIG_FILE = path.join(HOME, 'codemie-cli.config.json');
const CREDS_DIR = path.join(HOME, 'credentials');
const CACHE_TTL_MS = 60_000;
const CACHE_SCHEMA = 2; // bump when the cache.value shape changes, to discard stale pre-upgrade entries

const ENCRYPTION_KEY = deriveMachineEncryptionKey();

async function readCredsFile(filePath) {
  try {
    return JSON.parse(decryptWithKey(await fs.readFile(filePath, 'utf8'), ENCRYPTION_KEY));
  } catch {
    return null;
  }
}

/**
 * Reads whichever of the current (`deriveUrlStorageKey`) or legacy (`deriveLegacyUrlStorageKey`)
 * storage keys has a file on disk — CredentialStore migrates a credential from the legacy key to
 * the current one on first read but only ever writes through the CLI itself, so a set of
 * credentials this statusline finds only under the legacy key (not yet migrated) must still be
 * readable here. `deriveUrlStorageKey`/`deriveLegacyUrlStorageKey` already return the `sso-`
 * prefixed key CredentialStore uses for SSO cookies; `jwtPrefix` adds the extra `jwt-` layer it
 * uses for JWT tokens (`jwt-sso-<hash>.enc`).
 */
async function readStoredCredsFile(jwtPrefix, codeMieUrl) {
  const current = await readCredsFile(path.join(CREDS_DIR, `${jwtPrefix}${deriveUrlStorageKey(codeMieUrl)}.enc`));
  if (current) return current;
  return readCredsFile(path.join(CREDS_DIR, `${jwtPrefix}${deriveLegacyUrlStorageKey(codeMieUrl)}.enc`));
}

export async function getAuthHeaders(codeMieUrl) {
  const sso = await readStoredCredsFile('', codeMieUrl);
  if (sso?.cookies) {
    return { cookie: Object.entries(sso.cookies).map(([k, v]) => `${k}=${v}`).join(';') };
  }

  const jwt = await readStoredCredsFile('jwt-', codeMieUrl);
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
// alias/tier the session was started with). When the CodeMie proxy's router dispatches a
// turn to a different backend model, that can surface two ways in the transcript's most
// recent assistant turn (transcript_path):
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
// Header parsing itself (case 1) is `parseRoutingHeaders()`, imported from routing-headers.mjs
// — the same function the analytics report's cost engine
// (src/cli/commands/analytics/cost/usage-readers.ts) calls, so the two can no longer drift on
// which header wins or how it's normalized.

const ROUTED_MODEL_TAIL_BYTES = 65_536; // starting window — covers the common case in one read
// Upper bound on how far resolveActualModel() will grow the tail window looking for the last
// assistant turn (see there). Large enough to comfortably contain a multi-megabyte pasted
// image/file attachment without resorting to reading arbitrarily large transcripts on every
// render, which happens every few seconds.
const ROUTED_MODEL_TAIL_MAX_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * Strips Bedrock region/provider qualifiers (`converse/global.anthropic.` / `eu.anthropic.` /
 * Switchyard's `bedrock/us.anthropic.` alias, which carries no version suffix) and any
 * `-v1:0` inference-profile version suffix.
 */
export function normalizeModelId(modelId) {
  if (!modelId) return '';
  return modelId
    .toLowerCase()
    .replace(/^(?:converse|bedrock)\//, '')
    .replace(/^[a-z0-9-]+\.anthropic\./, '')
    .replace(/-v\d+:\d+$/, '');
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
    // Claude Code inserts local placeholder assistant turns (interrupted/timed-out/no-response)
    // with the literal model id "<synthetic>" — these never went through the proxy, so they
    // carry no real routing signal and must not be mistaken for the last real API response.
    if (parsed?.type === 'assistant' && message?.model && message.model !== '<synthetic>') {
      return { responseModel: message.model, headerRoutedModel: parseRoutingHeaders(message)?.routedModel ?? null };
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
 * Parses the live CodeMie catalog's router-id list, set once at session start by
 * claude.plugin.ts's `beforeRun` hook (see `listRouterModelIds()` in claude.models.ts) and
 * inherited here via process env since this script runs detached and cannot query the catalog
 * itself. Never throws; an unset, empty, or malformed value yields an empty set.
 */
export function parseRouterModelIds(env) {
  if (!env.CODEMIE_ROUTER_MODEL_IDS) return new Set();
  try {
    const parsed = JSON.parse(env.CODEMIE_ROUTER_MODEL_IDS);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * True only when `modelId` — the model Claude Code currently reports, which may have changed
 * mid-session via its own `/model` command — is itself a router (a Switchyard virtual router or
 * a declared LiteLLM auto-router). Checked against the live list on every render rather than a
 * boolean baked in at session start, since `/model` does not re-run claude.plugin.ts's
 * `beforeRun` hook.
 *
 * Gates {@link resolveActualModel} so the "routed to" widget only ever runs for a model that can
 * actually be routed — resolveActualModel itself shows whatever the transcript reports
 * unconditionally, even when it happens to name the same tier as the request (a router
 * legitimately dispatching "capable" back to the requested model is still worth confirming). A
 * plain, non-router deployment must never show the widget at all: its response `model` can differ
 * from the request for reasons that mean nothing (Bedrock region snapshots, LiteLLM replica
 * naming) rather than an actual routing decision, and this is the only thing telling those apart.
 */
export function isRoutingConfigured(env, modelId) {
  return parseRouterModelIds(env).has(modelId);
}

/**
 * The live CodeMie catalog's id → display-label map, set once at session start by
 * claude.plugin.ts's `beforeRun` hook (see `buildModelLabelMap()` in claude.models.ts) and
 * inherited here via process env, same mechanism as {@link isRoutingConfigured}.
 *
 * Exists because neither of the two model names this script would otherwise show is
 * necessarily human-readable: `ctx.model.display_name` is Claude Code's own best guess for an
 * id it may not recognize (a Switchyard router's custom `base_name`, for instance — it can
 * surface a capable-tier family name the id only happens to embed, unrelated to what the router
 * actually is), and the routed-to model resolved by {@link resolveActualModel} is an id/base_name
 * rather than a display label at all. The catalog's own label is the one name CodeMie actually
 * configured, so callers prefer it whenever the lookup succeeds.
 *
 * Never throws; an unset, empty, or malformed value yields `{}`, so a lookup miss always falls
 * back to whatever the caller already had.
 */
export function parseModelLabels(env) {
  if (!env.CODEMIE_MODEL_LABELS) return {};
  try {
    const parsed = JSON.parse(env.CODEMIE_MODEL_LABELS);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the actual routed model for the current session's most recent turn, or null when
 * there is nothing to show — no transcript, an unreadable transcript, or no model signal on the
 * last assistant turn. Only ever called for a router (see {@link isRoutingConfigured}), so the
 * result is shown unconditionally — even when it names the same tier the router was asked for,
 * since that is itself useful confirmation ("routed to capable, as requested") rather than noise
 * to suppress. Never throws: the statusline must keep rendering even if the transcript is
 * mid-write or has already rotated away.
 *
 * Grows the read window geometrically when the last assistant turn isn't found, rather than
 * trusting a single fixed-size tail. Claude Code interleaves non-conversation bookkeeping lines
 * (attachments, cost-state, mode/latch markers, ...) after the assistant turn, and a pasted
 * image or large file attachment can push hundreds of KB — even several MB — of that bookkeeping
 * between the turn we want and EOF. A fixed 64KB tail then reads only bookkeeping and never sees
 * the turn at all: observed live where a 187KB attachment line alone buried a turn sitting well
 * inside 200KB of EOF. Stops growing once a turn is found, the whole file has been read (the
 * returned tail is shorter than requested), or {@link ROUTED_MODEL_TAIL_MAX_BYTES} is hit.
 */
export async function resolveActualModel(transcriptPath, { readTail = defaultReadTail, labels = {} } = {}) {
  if (!transcriptPath) return null;
  let turn: ReturnType<typeof parseLastAssistantTurn> = null;
  let bytes = ROUTED_MODEL_TAIL_BYTES;
  for (;;) {
    let tail;
    try {
      tail = await readTail(transcriptPath, bytes);
    } catch {
      return null;
    }
    turn = parseLastAssistantTurn(tail);
    // Buffer.byteLength (not tail.length) — a JS string's UTF-16 length under-counts multi-byte
    // UTF-8 content, which would otherwise mistake "we only got fewer bytes than we asked for
    // because the file is smaller than the window" for a false positive on non-ASCII transcripts.
    if (turn || Buffer.byteLength(tail, 'utf8') < bytes || bytes >= ROUTED_MODEL_TAIL_MAX_BYTES) break;
    // Clamp to the cap rather than multiplying past it — otherwise the next read is issued at
    // the post-multiply size before this loop's own break check ever sees it, so the 8x growth
    // from just under the cap (e.g. 4MB) can overshoot to 32MB before stopping.
    bytes = Math.min(bytes * 8, ROUTED_MODEL_TAIL_MAX_BYTES);
  }
  if (!turn) return null;
  const candidate = turn.headerRoutedModel ?? turn.responseModel;
  if (!candidate) return null;
  // Display the Bedrock-stripped form as a fallback — the raw candidate may be a fully
  // qualified backend id (e.g. `converse/global.anthropic.claude-haiku-4-5-20251001-v1:0`),
  // which is accurate but not what a human wants to read in a one-line statusline. Prefer the
  // catalog's own label over either form when the lookup succeeds — try the raw candidate
  // first, since it is closer to how the catalog names a deployment than the stripped form.
  const normalized = normalizeModelId(candidate);
  return labels[candidate] ?? labels[normalized] ?? normalized;
}

// --- Session cost ---
//
// Claude Code's stdin JSON carries `cost.total_cost_usd`, priced against the model the session
// was *started* with. Behind a router alias (`claude-smart-router`) that id has no rate card
// upstream at all, so Claude Code falls back to a guess — measured $3.2558 against a real
// $0.3959 on a mixed haiku/sonnet session, 8x over. Price the transcript ourselves instead,
// attributing every message to whichever model actually answered it.
//
// Two things a naive sum gets wrong:
//   1. Claude Code appends a transcript line per streaming update, so one assistant message can
//      appear several times carrying identical usage. Dedupe by `message.id` or it multi-counts.
//   2. Cache-creation tokens arrive either as a flat `cache_creation_input_tokens` or, when the
//      upstream populates it, split into 5m/1h buckets that bill at different rates. Prefer the
//      split when it is non-zero, since 1h writes cost more than the flat rate assumes.
//
// The rate card is `pricing.json`, deployed next to this script by the statusline installer so
// there is one source of truth for rates. Without it we fall back to Claude Code's figure.

const PRICING_FILENAME = 'codemie-pricing.json';
const COST_CACHE_FILE = path.join(HOME, 'statusline-cost-cache.json');
const COST_CACHE_SCHEMA = 1; // bump when the cached shape changes, to discard pre-upgrade entries

/**
 * Identity of the transcript set as it is on disk right now: path, size and mtime of each file.
 * Any append, truncation or new subagent file changes it, so a matching signature means the parsed
 * total cannot have changed — which is what makes the cached total safe to reuse.
 */
async function sourceSignature(paths, stat) {
  const parts: string[] = [];
  for (const p of paths) {
    try {
      const { size, mtimeMs } = await stat(p);
      parts.push(`${p}:${size}:${mtimeMs}`);
    } catch {
      parts.push(`${p}:absent`); // absence is itself part of the identity
    }
  }
  return parts.join('|');
}

async function defaultReadPrices() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(await fs.readFile(path.join(here, PRICING_FILENAME), 'utf8'));
}

// Both sides of the lookup must be folded the same way. The id is lowercased and its dots turned to
// dashes, so the table keys have to be too — otherwise a dotted key (`gemini-3.7-flash`, `glm-4.7`,
// `minimax-m2.5`: 14 of them in the shipped card) can never match, and every turn answered by one of
// those models silently prices at $0. Built once per table object rather than per message.
const NORMALIZED_TABLES = new WeakMap();

function normalizedTable(table) {
  const cached = NORMALIZED_TABLES.get(table);
  if (cached) return cached;
  const normalized = new Map();
  for (const [key, rate] of Object.entries(table)) {
    if (key.startsWith('_')) continue; // _meta and similar
    normalized.set(normalizeModelId(key).replace(/\./g, '-'), rate);
  }
  NORMALIZED_TABLES.set(table, normalized);
  return normalized;
}

/** Claude pricing tiers whose per-tier rate has stayed flat across every `-4-*` version bump seen so far. */
const CLAUDE_TIERS = ['claude-opus', 'claude-sonnet', 'claude-haiku'];

/**
 * Parse the version segments trailing a tier prefix into a numeric tuple for comparison, e.g.
 * `claude-sonnet-4-8` under tier `claude-sonnet` -> `[4, 8]`. Returns null for keys that don't
 * fit the plain `<tier>(-<digits>)*` shape — non-numeric segments (`-latest`) or a long numeric
 * segment (a pinned date snapshot like `-20250514`, 8 digits).
 */
function tierVersionTuple(key: string, tier: string): number[] | null {
  const rest = key.slice(tier.length);
  if (!rest) return [0];
  const segments = rest.split('-').filter(Boolean);
  const nums: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment) || segment.length >= 8) return null;
    nums.push(Number(segment));
  }
  return nums;
}

function compareVersionTuples(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fall back to the latest known rate within the same Claude tier (opus/sonnet/haiku) when `name`
 * matches no table entry at all — e.g. a brand-new major-version model (`claude-sonnet-5`) that
 * shares no version segment with any `-4-*` key. Mirrors src/utils/pricing.ts's
 * claudeTierFallback(); duplicated here because this file is bundled standalone and cannot import
 * that module.
 */
function claudeTierFallback(name: string, rates: Map<string, unknown>) {
  const tier = CLAUDE_TIERS.find((t) => name === t || name.startsWith(`${t}-`));
  if (!tier) return null;
  let best: { key: string; version: number[]; rate: unknown } | null = null;
  for (const [key, rate] of rates.entries()) {
    if (key !== tier && !key.startsWith(`${tier}-`)) continue;
    const version = tierVersionTuple(key, tier);
    if (version === null) continue;
    if (!best || compareVersionTuples(version, best.version) > 0) best = { key, version, rate };
  }
  return best ? best.rate : null;
}

/**
 * Longest table key that aligns to a `-`-delimited segment boundary, so `claude-haiku` never
 * matches mid-token, falling back to the latest same-tier Claude rate when even that misses —
 * the same three-tier resolution order as src/utils/pricing.ts's lookupPrice().
 */
export function lookupRate(table, modelId) {
  if (!table) return null;
  const name = normalizeModelId(modelId).replace(/\./g, '-');
  if (!name) return null;
  const rates = normalizedTable(table);
  const exact = rates.get(name);
  if (exact) return applyBedrockRegionalPremium(exact, modelId);
  let best: string | null = null;
  for (const key of rates.keys()) {
    if (key.length > name.length) continue;
    const idx = name.indexOf(key);
    if (idx === -1) continue;
    const before = idx === 0 ? '-' : name[idx - 1];
    const after = idx + key.length === name.length ? '-' : name[idx + key.length];
    if (before === '-' && after === '-' && (!best || key.length > best.length)) best = key;
  }
  const rate = best ? rates.get(best) : null;
  if (rate) return applyBedrockRegionalPremium(rate, modelId);
  const tierFallback = claudeTierFallback(name, rates);
  return tierFallback ? applyBedrockRegionalPremium(tierFallback, modelId) : null;
}

function messageCost(rate, usage) {
  // The deployed card is the built table, whose cache-write field is `cacheCreation`. Accept the raw
  // `cacheWrite` spelling too, so a card deployed by an older install still prices cache writes
  // instead of silently charging zero for them.
  const cacheWriteRate = rate.cacheCreation ?? rate.cacheWrite ?? 0;
  const split = usage.cache_creation;
  const write5m = split?.ephemeral_5m_input_tokens ?? 0;
  const write1h = split?.ephemeral_1h_input_tokens ?? 0;
  const cacheWrite = write5m || write1h
    ? write5m * cacheWriteRate + write1h * (rate.cacheWrite1h ?? cacheWriteRate)
    : (usage.cache_creation_input_tokens ?? 0) * cacheWriteRate;
  return (
    (usage.input_tokens ?? 0) * (rate.input ?? 0) +
    (usage.output_tokens ?? 0) * (rate.output ?? 0) +
    (usage.cache_read_input_tokens ?? 0) * (rate.cacheRead ?? 0) +
    cacheWrite
  ) / 1_000_000;
}

/**
 * Sums the real spend for a session from its transcript. Returns `{ cost, exact }` — `exact` is
 * false when at least one message named a model the rate card has no entry for, so the caller can
 * mark the figure an estimate rather than presenting a silent undercount. Returns null when there
 * is nothing to price or the rate card is unavailable, leaving the caller on Claude Code's number.
 * Never throws: the statusline must keep rendering even mid-write.
 */
export async function computeSessionCost(transcriptPath, {
  readFile = fs.readFile,
  readDir = fs.readdir,
  writeFile = fs.writeFile,
  stat = fs.stat,
  readPrices = defaultReadPrices,
} = {}) {
  if (!transcriptPath) return null;

  // Only a missing rate card leaves us unable to price at all — that is the one case that falls
  // back to Claude Code's figure. An unreadable transcript does NOT: Claude Code writes the file
  // lazily, so a session that has not made a billable call yet has no transcript on disk. Treating
  // that as "cannot price" marked every fresh session `~$0.0000`, implying an estimate where the
  // honest answer is simply zero.
  let table;
  try {
    table = await readPrices();
  } catch {
    return null;
  }

  // Subagents bill against the session but are written to their own transcripts, in a sibling
  // directory named for the session: <dir>/<sessionId>/subagents/agent-<id>.jsonl. They never
  // appear in the main transcript — no `isSidechain` rows, nothing — so summing only the main
  // file silently drops every dispatched agent. Measured on one session: $0.79 counted against
  // $3.71 actually spent, 79% of it invisible.
  const subagentDir = path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, '.jsonl'),
    'subagents'
  );
  const sourcePaths = [transcriptPath];
  try {
    for (const name of await readDir(subagentDir)) {
      if (name.endsWith('.jsonl')) sourcePaths.push(path.join(subagentDir, name));
    }
  } catch {
    // No subagents dispatched in this session.
  }

  // Every render would otherwise re-read and re-JSON.parse the whole transcript plus each subagent
  // file, growing without bound with session length — the render path trading the HTTP round trip
  // this statusline dropped for unbounded disk I/O. Key a cached total on each source's size+mtime:
  // a stat per file is cheap next to a full parse, and an unchanged session re-renders for free.
  // Capping how much is read (or how many agent files) was the alternative, but any cap silently
  // undercounts real spend, which is the bug this whole path exists to fix.
  const signature = await sourceSignature(sourcePaths, stat);
  try {
    const cached = JSON.parse(await readFile(COST_CACHE_FILE, 'utf8'));
    if (
      cached.schema === COST_CACHE_SCHEMA &&
      cached.signature === signature &&
      typeof cached.cost === 'number' &&
      typeof cached.exact === 'boolean'
    ) {
      return { cost: cached.cost, exact: cached.exact };
    }
  } catch {
    // No cache, unreadable, or a stale schema — recompute below.
  }

  const sources: string[] = [];
  for (const sourcePath of sourcePaths) {
    try {
      sources.push(await readFile(sourcePath, 'utf8'));
    } catch {
      // The main transcript may not exist yet, and one unreadable agent transcript must not lose
      // the rest of the session's cost.
    }
  }

  const byMessage = new Map();
  let anon = 0;
  for (const raw of sources) {
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line)?.message;
      } catch {
        continue; // a torn final line while Claude Code is mid-write
      }
      if (!message?.usage) continue;
      const id = message.id ?? `anon:${anon++}`;
      // Prefer the raw backend id (x-litellm-model-name, falling back to the routed/response
      // model) over the CodeMie-cleaned routedModel: the clean name is what lookupRate wants for
      // the base price, but pricing ALSO needs the region qualifier the clean name strips — see
      // isBedrockRegionalPremium() below. normalizeModelId() inside lookupRate strips the same
      // qualifier for the price lookup itself, so using the raw id here changes nothing about
      // which rate is selected.
      const model = parseBackendModelName(message) ?? parseRoutingHeaders(message)?.routedModel ?? message.model ?? '';
      byMessage.set(id, { model, usage: message.usage });
    }
  }
  // A readable transcript with no priced turns yet is a session that has genuinely spent nothing
  // — report an exact zero. Returning null here would fall back to Claude Code's figure and mark
  // a fresh session `~$0.0000`, implying an estimate where there is simply no spend.
  let cost = 0;
  let exact = true;
  for (const { model, usage } of byMessage.values()) {
    const rate = lookupRate(table, model);
    if (!rate) { exact = false; continue; }
    cost += messageCost(rate, usage);
  }

  const result = { cost, exact };
  try {
    await writeFile(COST_CACHE_FILE, JSON.stringify({ schema: COST_CACHE_SCHEMA, signature, ...result }), 'utf8');
  } catch {
    // A cache we cannot write only costs us the next render's parse.
  }
  return result;
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

export function ctxBar(pct) {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? C.red : clamped >= 70 ? C.yellow : C.green;
  const filled = Math.floor(clamped / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${c(color, bar)} ${pct}%`;
}

// The CLI budget segment is intentionally not rendered. resolveBudget() and its helpers are kept
// (and still covered by __tests__/statusline.test.ts) so the segment can be restored by calling it
// from main() again, but main() no longer does, so no HTTP request is made per render.
export function buildStatusLine({ projectName, branch, model, actualModel, ctxPct, tokIn, tokOut, cost, costExact, durationMs }) {
  const parts: string[] = [];

  if (projectName) parts.push(c(C.purple, `[${projectName}]`));
  if (branch) parts.push(c(C.blue, `(${branch})`));
  if (model)  parts.push(c(C.cyan, `[${actualModel ? `${model} → ${actualModel}` : model}]`));

  const bar = ctxBar(ctxPct);
  if (bar) parts.push(bar);

  const stats: string[] = [];
  if (tokIn != null)  stats.push(`in:${fmt(tokIn)}`);
  if (tokOut != null) stats.push(`out:${fmt(tokOut)}`);
  if (stats.length) parts.push(c(C.gray, stats.join(' ')));

  // `costExact` is set when the figure was priced from the transcript by computeSessionCost()
  // — every message attributed to the model that actually answered it. It is false when we fell
  // back to Claude Code's own `total_cost_usd`, which prices the whole session against the model
  // the session *requested*: on a router alias Claude Code has no rate card for that id and
  // guesses, measured 8x over the real spend. Only then is the number marked an estimate.
  if (typeof cost === 'number' && !Number.isNaN(cost)) {
    parts.push(c(C.yellow, `${costExact ? '' : '~'}$${cost.toFixed(4)}`));
  }

  const dur = formatDuration(durationMs);
  if (dur) parts.push(c(C.gray, dur));

  return parts.join(' | ');
}

function readStdin(): Promise<string> {
  return new Promise<string>(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function gitBranch(cwd) {
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'], { cwd, timeout: 2000 });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Detached HEAD (symbolic-ref fails) — fall through to rev-parse.
  }
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', 'rev-parse', '--short', 'HEAD'], { cwd, timeout: 2000 });
    return stdout.trim() || '';
  } catch {
    return '';
  }
}

// --- Budget resolution (network/filesystem; dependencies injectable for tests) ---

export async function resolveBudget({
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  fetchImpl = fetch,
  getAuthHeadersImpl = getAuthHeaders,
} = {}) {
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return { budget: null, budgetError: null }; // no CodeMie config at all → skip silently
  }

  // Which profile is this session actually running on? `config.activeProfile` is global mutable
  // state: any other command — a benchmark run, a second terminal doing `codemie profile use` —
  // repoints it underneath a session that is already running, and the statusline then reports
  // the budget for a profile this session never used. CodeMie exports the launch profile as
  // CODEMIE_PROFILE_NAME (see AgentCLI.ts), and Claude Code passes its environment down to the
  // statusline subprocess, so prefer that and fall back to the global only when it is absent or
  // names a profile that no longer exists.
  const sessionProfile = process.env.CODEMIE_PROFILE_NAME;
  const profileName = sessionProfile && config.profiles?.[sessionProfile]
    ? sessionProfile
    : config.activeProfile;

  // Fast path: fresh cache, skip the network. Discard any entry that isn't this schema version
  // (e.g. a pre-upgrade string-shaped value) or that was written for a different profile —
  // budgets are per-profile, and two sessions on different profiles share this one cache file.
  try {
    const cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    const validShape = cache.schema === CACHE_SCHEMA
      && cache.profile === profileName
      && typeof cache.value === 'object' && cache.value !== null
      && typeof cache.value.text === 'string';
    if (validShape && Date.now() - cache.ts < CACHE_TTL_MS) {
      return { budget: cache.value, budgetError: null };
    }
  } catch {
    // No cache, unreadable, or a stale/mismatched schema — fall through to a live lookup below.
  }

  const profile = config.profiles?.[profileName];
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
    return { budget: null, budgetError: e instanceof Error ? e.message : String(e) };
  }
  if (!headers) {
    return { budget: null, budgetError: 'reauthenticate' };
  }

  try {
    const res = await fetchImpl(`${baseUrl}/v1/analytics/budget_usage`, {
      headers: { 'Content-Type': 'application/json', 'X-CodeMie-Client': 'codemie-cli', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // A 200 does not guarantee JSON. When the profile's baseUrl points at something that is not
    // the CodeMie API — a local gateway, an SSO login page — the body comes back as HTML with a
    // 200, and res.json() would surface a raw parser dump ("Unexpected token '<' ...") into the
    // status bar. That is not a budget outage worth a permanent warning slot: it means this
    // profile has no CodeMie budget API, the same situation as the unconfigured-profile checks
    // above, so skip the segment silently the way those do. Genuine failures — HTTP errors, auth
    // — still surface, because those are cases where a budget was expected and did not arrive.
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('json')) return { budget: null, budgetError: null };

    const json = await res.json() as { data?: { rows?: unknown[] } };
    const row = matchBudgetRow(json?.data?.rows, userEmail);
    if (!row) throw new Error('budget row not found');

    const budget = formatBudgetSegment(row);
    await writeFile(CACHE_FILE, JSON.stringify({ schema: CACHE_SCHEMA, profile: profileName, ts: Date.now(), value: budget }), 'utf8');
    return { budget, budgetError: null };
  } catch (e) {
    // Node collapses every transport failure into a bare "fetch failed" and hides the real
    // reason on `cause` — ECONNREFUSED, ENOTFOUND, a TLS error. On its own that message names
    // nothing the reader can check. Surface the cause code instead, so the segment says which
    // failure it was and points at the profile's baseUrl.
    const code = e instanceof Error && e.cause && typeof e.cause === 'object' && 'code' in e.cause
      ? (e.cause as { code: unknown }).code
      : undefined;
    const message = e instanceof Error ? e.message : String(e);
    return { budget: null, budgetError: code ? `budget: ${code}` : message };
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

  // Prefer the CodeMie catalog's own label over Claude Code's guessed display_name whenever
  // one is configured for this id — see parseModelLabels().
  const labels = parseModelLabels(process.env);
  const nominalLabel = labels[basic.modelId];
  if (nominalLabel) basic.model = nominalLabel;

  // resolveBudget() is deliberately not called: the budget segment is not rendered, and it was the
  // only network request the statusline made — one HTTP round trip on every single render.
  const branchPromise = basic.cwd ? gitBranch(basic.cwd) : Promise.resolve('');
  const [branch, actualModel, priced] = await Promise.all([
    branchPromise,
    isRoutingConfigured(process.env, basic.modelId) ? resolveActualModel(basic.transcriptPath, { labels }) : Promise.resolve(null),
    computeSessionCost(basic.transcriptPath),
  ]);

  // Prefer our own per-model figure; fall back to Claude Code's (marked `~`) when the transcript
  // or the rate card could not be read.
  const cost = priced ? priced.cost : basic.cost;
  const costExact = priced ? priced.exact : false;

  process.stdout.write(buildStatusLine({ ...basic, branch, actualModel, cost, costExact }));
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
