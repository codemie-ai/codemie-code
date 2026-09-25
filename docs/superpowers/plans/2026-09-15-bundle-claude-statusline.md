# Bundle the Claude Statusline as a Compiled Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Claude statusline's hand-maintained plain-JS + flat-sibling-file deployment with a normal TypeScript source file bundled by esbuild into one self-contained artifact, eliminating the `routing-headers.mjs`/`bedrock-pricing.mjs` re-export shims.

**Architecture:** Rename `src/agents/plugins/claude/plugin/statusline.mjs` → `statusline.ts` with normal `@/utils/...` imports. Add `scripts/bundle-statusline.mjs` (esbuild, Node API) that bundles it into `dist/agents/plugins/claude/plugin/statusline.bundle.mjs` as part of `npm run build`. `statusline-installer.ts` deploys only that one bundled file (plus the pre-existing `codemie-pricing.json` sidecar, unchanged). Delete the two shim files now that nothing needs flat-sibling relative imports to resolve.

**Tech Stack:** esbuild 0.28.1 (already present transitively via vite/vitest; pinned as an explicit devDependency), TypeScript, Vitest.

**Verified during planning:** the exact TS conversion below was written to the real file location, typechecked (`tsc --noEmit`) to a clean pass, bundled with esbuild using the project's real `tsconfig.json` (confirming `@/*` path-alias resolution works inside the bundler), and smoke-tested by piping a sample stdin payload through the bundle — it rendered `[testproj] | [Claude Sonnet 5] | ██░░░░░░░░ 10% | ~$0.0100 | 0m 5s`, byte-for-byte the same shape the current implementation produces. The scratch files from that verification were removed before this plan was written; no repo state was left behind.

---

### Task 1: Add esbuild as an explicit devDependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Edit `package.json`'s `devDependencies` block (alphabetical, so it lands between `@vitest/ui` and `eslint`):

```json
    "@vitest/ui": "^4.1.5",
    "esbuild": "^0.28.1",
    "eslint": "^9.38.0",
```

- [ ] **Step 2: Install and verify the lockfile picks up an explicit (not just transitive) entry**

Run: `npm install`
Expected: exits 0; `package-lock.json`'s top-level `"esbuild"` devDependency entry is now a direct dependency of the root package (it was already present transitively via vite/vitest at the same `0.28.1` version, so this should not change the resolved version — verify with `npm ls esbuild` showing no version conflicts).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(build): add esbuild as an explicit devDependency for statusline bundling"
```

---

### Task 2: Convert `statusline.mjs` to TypeScript with real project imports

**Files:**
- Create: `src/agents/plugins/claude/plugin/statusline.ts` (full content below)
- Delete: `src/agents/plugins/claude/plugin/statusline.mjs`

This is a rename + minimal-diff conversion of the current `statusline.mjs`. Three kinds of changes only:
1. The two relative imports (`./routing-headers.mjs`, `./bedrock-pricing.mjs`) become `@/utils/...` imports.
2. The top-of-file header comment is updated to describe the new bundle-based deploy path instead of the old flat-sibling one.
3. Six small type annotations added at points where TypeScript's strict mode (specifically `useUnknownInCatchVariables` and empty-array/`null`-initializer inference — the project's `noImplicitAny: false` does not cover either of these) would otherwise fail `tsc --noEmit`. Every annotation was found by actually running `tsc --noEmit` against this exact file during planning (see the plan header) — there are no other diffs anywhere else in the file. No behavior changes.

- [ ] **Step 1: Read the current file so the Edit/Write tool has it in context**

Run: `cat src/agents/plugins/claude/plugin/statusline.mjs` (or use the Read tool) to load current content — required before Write can create the new path from it in your editing tool of choice. (If your tool requires reading the exact target path before writing, read `src/agents/plugins/claude/plugin/statusline.mjs` — the content is reproduced in full below regardless.)

- [ ] **Step 2: Create `src/agents/plugins/claude/plugin/statusline.ts` with this exact content**

```typescript
#!/usr/bin/env node
// CodeMie statusline — shows model, project, branch, context, session cost/duration,
// and (when a CodeMie profile is configured) the CLI budget for the authenticated user.
// When the request was routed to a different backend model (CodeMie Switchyard or the
// LiteLLM router), the actual model is read from the routing headers the proxy injects
// into the transcript and shown alongside the nominal one — see resolveActualModel().
//
// Deployed to ~/.claude/ by `codemie install statusline` (also triggered by the `--status`
// CLI flag, which calls the same installer). Runs standalone — Claude Code invokes it as
// `node <path>` from ~/.claude/settings.json as a detached process after the CLI itself has
// already exited, with no node_modules resolution available. This source file is nonetheless
// normal TypeScript with normal project imports: scripts/bundle-statusline.mjs (esbuild) bundles
// it into a single self-contained ESM file at build time, and statusline-installer.ts deploys
// only that bundled artifact — no sibling files, no shims. See both for the deploy path.
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
// Bundled directly into the artifact by scripts/bundle-statusline.mjs — the same two modules the
// analytics cost engine (src/cli/commands/analytics/cost/usage-readers.ts, src/utils/pricing.ts)
// imports unbundled, so routing headers and Bedrock regional pricing are each resolved in exactly
// one place, read here and there rather than re-derived.
import { parseRoutingHeaders } from '@/utils/routing-headers.mjs';
import { parseBackendModelName, applyBedrockRegionalPremium } from '@/utils/bedrock-pricing.mjs';

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
// Header parsing itself (case 1) is `parseRoutingHeaders()`, imported from routing-headers.mjs
// — the same function the analytics report's cost engine
// (src/cli/commands/analytics/cost/usage-readers.ts) calls, so the two can no longer drift on
// which header wins or how it's normalized.

const ROUTED_MODEL_TAIL_BYTES = 65_536; // last 64KB — comfortably covers the most recent turn(s)

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
 */
export async function resolveActualModel(transcriptPath, { readTail = defaultReadTail, labels = {} } = {}) {
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

/** Longest table key that aligns to a `-`-delimited segment boundary, so `claude-haiku` never matches mid-token. */
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
  return rate ? applyBedrockRegionalPremium(rate, modelId) : null;
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

// The CLI budget segment is intentionally not rendered. resolveBudget() and its helpers are kept
// (and still covered by __tests__/statusline.test.ts) so the segment can be restored by calling it
// from main() again, but main() no longer does, so no HTTP request is made per render.
export function buildStatusLine({ projectName, branch, model, actualModel, ctxPct, cost, costExact, durationMs }) {
  const parts: string[] = [];

  if (projectName) parts.push(c(C.purple, `[${projectName}]`));
  if (branch) parts.push(c(C.blue, `(${branch})`));
  if (model)  parts.push(c(C.cyan, `[${actualModel ? `${model} → ${actualModel}` : model}]`));

  const bar = ctxBar(ctxPct);
  if (bar) parts.push(bar);

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
  } catch {}

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
  } catch (e: any) {
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

    // A 200 does not guarantee JSON. When the profile's baseUrl points at something that is not
    // the CodeMie API — a local gateway, an SSO login page — the body comes back as HTML with a
    // 200, and res.json() would surface a raw parser dump ("Unexpected token '<' ...") into the
    // status bar. That is not a budget outage worth a permanent warning slot: it means this
    // profile has no CodeMie budget API, the same situation as the unconfigured-profile checks
    // above, so skip the segment silently the way those do. Genuine failures — HTTP errors, auth
    // — still surface, because those are cases where a budget was expected and did not arrive.
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('json')) return { budget: null, budgetError: null };

    const json = await res.json() as any;
    const row = matchBudgetRow(json?.data?.rows, userEmail);
    if (!row) throw new Error('budget row not found');

    const budget = formatBudgetSegment(row);
    await writeFile(CACHE_FILE, JSON.stringify({ schema: CACHE_SCHEMA, profile: profileName, ts: Date.now(), value: budget }), 'utf8');
    return { budget, budgetError: null };
  } catch (e: any) {
    // Node collapses every transport failure into a bare "fetch failed" and hides the real
    // reason on `cause` — ECONNREFUSED, ENOTFOUND, a TLS error. On its own that message names
    // nothing the reader can check. Surface the cause code instead, so the segment says which
    // failure it was and points at the profile's baseUrl.
    const code = e.cause?.code;
    return { budget: null, budgetError: code ? `budget: ${code}` : e.message };
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
```

- [ ] **Step 3: Delete the old `.mjs` source**

```bash
rm src/agents/plugins/claude/plugin/statusline.mjs
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0 with no `statusline.ts` diagnostics. (Verified during planning — see plan header.)

- [ ] **Step 5: Lint**

Run: `npx eslint 'src/agents/plugins/claude/plugin/statusline.ts'`
Expected: exits 0, no warnings (the project lints with `--max-warnings=0`; `npm run lint` covers this file automatically since it's now `src/**/*.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/agents/plugins/claude/plugin/statusline.ts
git rm src/agents/plugins/claude/plugin/statusline.mjs
git commit -m "refactor(claude): convert statusline.mjs to TypeScript with normal project imports"
```

---

### Task 3: Add the esbuild bundling script and wire it into `npm run build`

**Files:**
- Create: `scripts/bundle-statusline.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/bundle-statusline.mjs`**

```javascript
#!/usr/bin/env node

/**
 * Bundles the Claude Code statusline into a single self-contained ESM artifact.
 *
 * statusline.ts runs standalone: Claude Code invokes it as `node <path>` from
 * ~/.claude/settings.json as a detached process after the CLI itself has already exited, so it
 * cannot resolve node_modules or import from the rest of the project at runtime. Bundling lets
 * its source stay normal TypeScript with normal project imports (@/utils/...) while still
 * deploying as one flat file with zero sibling dependencies. statusline-installer.ts reads this
 * script's output and writes it into ~/.claude/ — see that file for the deploy path.
 *
 * Entry point is the TypeScript SOURCE (not tsc's dist/ output): esbuild transpiles TS itself
 * and resolves the project's `@/*` path alias directly from tsconfig.json, so this step has no
 * ordering dependency on `tsc`/`tsc-alias` — type-checking still happens separately via
 * `npm run typecheck` / `tsc` in the build chain, this step only needs valid syntax.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

await esbuild.build({
  entryPoints: [join(rootDir, 'src/agents/plugins/claude/plugin/statusline.ts')],
  outfile: join(rootDir, 'dist/agents/plugins/claude/plugin/statusline.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  tsconfig: join(rootDir, 'tsconfig.json'),
  logLevel: 'info',
});

console.log('Statusline bundled successfully!');
```

- [ ] **Step 2: Wire it into the build script**

In `package.json`'s `scripts` block, change:

```json
    "build": "tsc && tsc-alias && npm run copy-plugin",
    "copy-plugin": "node scripts/copy-plugins.js",
```

to:

```json
    "build": "tsc && tsc-alias && npm run copy-plugin && npm run bundle-statusline",
    "copy-plugin": "node scripts/copy-plugins.js",
    "bundle-statusline": "node scripts/bundle-statusline.mjs",
```

- [ ] **Step 3: Run the build and verify the bundle is produced**

Run: `npm run build`
Expected: exits 0; final output includes `Statusline bundled successfully!`; `dist/agents/plugins/claude/plugin/statusline.bundle.mjs` exists.

Run: `test -f dist/agents/plugins/claude/plugin/statusline.bundle.mjs && echo EXISTS`
Expected: prints `EXISTS`.

- [ ] **Step 4: Smoke-test the bundle directly**

Run:
```bash
echo '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"id":"claude-sonnet-5","display_name":"Claude Sonnet 5"},"context_window":{"used_percentage":10},"cost":{"total_cost_usd":0.01,"total_duration_ms":5000}}' | node dist/agents/plugins/claude/plugin/statusline.bundle.mjs
```
Expected: prints a colored statusline segment containing the project directory name, `[Claude Sonnet 5]`, a context bar at `10%`, a cost figure, and a duration — no stack trace, exit code 0.

Note: if invoking via a path that differs from its real (symlink-resolved) form the output can be silently empty — `isMainModule()` compares `process.argv[1]` against `fileURLToPath(import.meta.url)` exactly, and a symlinked directory (e.g. macOS `/tmp` → `/private/tmp`) makes those differ. Run this from the actual repo checkout path, not through a symlink, if output is unexpectedly empty.

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-statusline.mjs package.json
git commit -m "build(claude): bundle the statusline into a single esbuild artifact"
```

---

### Task 4: Update `statusline-installer.ts` to deploy only the bundle

**Files:**
- Modify: `src/agents/plugins/claude/statusline-installer.ts`

- [ ] **Step 1: Read the current file** (already done during planning — reproduced in full context above)

- [ ] **Step 2: Replace the filename constants and imports block**

Change:

```typescript
const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
// Must match PRICING_FILENAME in plugin/statusline.mjs — the script resolves it beside itself.
const PRICING_FILENAME = 'codemie-pricing.json';
// The two shared domain modules statusline.mjs imports by these exact relative names (see its
// own `import` lines) — must match src/utils/routing-headers.mjs / bedrock-pricing.mjs's
// filenames byte for byte, since neither this deploy step nor statusline.mjs's own import
// statements are rewritten. Sourced from dist/utils/ (scripts/copy-plugins.js copies them there
// verbatim, same as pricing.json), not from beside this installer — they are shared with the
// analytics cost engine (usage-readers.ts) and pricing.ts, not Claude-specific.
const ROUTING_HEADERS_FILENAME = 'routing-headers.mjs';
const BEDROCK_PRICING_FILENAME = 'bedrock-pricing.mjs';
const REFRESH_INTERVAL = 60;
```

to:

```typescript
const SCRIPT_FILENAME = 'codemie-budget-status.js';
const LEGACY_SCRIPT_FILENAME = 'codemie-statusline.mjs';
// Must match PRICING_FILENAME in plugin/statusline.ts — the script resolves it beside itself.
const PRICING_FILENAME = 'codemie-pricing.json';
// scripts/bundle-statusline.mjs's esbuild `outfile` — a single self-contained ESM artifact with
// zero sibling dependencies (statusline.ts's own project imports are resolved and inlined at
// build time). Keep this in sync with that script's `outfile` basename.
const BUNDLE_FILENAME = 'statusline.bundle.mjs';
const REFRESH_INTERVAL = 60;
```

- [ ] **Step 3: Replace the script-content read in `installStatusline()`**

Change:

```typescript
  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin/statusline.mjs'),
    'utf-8'
  );
  // statusline.mjs `import`s both of these by relative path, so they are as required as the
  // script itself — unlike codemie-pricing.json below, a missing copy would break every render,
  // not just cost accuracy, so neither is wrapped in a best-effort try/catch. Sourced from
  // dist/utils/, three levels up from this installer's own compiled location
  // (dist/agents/plugins/claude/) — see the filename constants' own comment for why they live
  // there instead of beside this installer.
  const utilsDir = join(getDirname(import.meta.url), '..', '..', '..', 'utils');
  const routingHeadersContent = await readFile(join(utilsDir, ROUTING_HEADERS_FILENAME), 'utf-8');
  const bedrockPricingContent = await readFile(join(utilsDir, BEDROCK_PRICING_FILENAME), 'utf-8');

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeFile(scriptPath, scriptContent, 'utf-8');
  await writeFile(join(claudeHome, ROUTING_HEADERS_FILENAME), routingHeadersContent, 'utf-8');
  await writeFile(join(claudeHome, BEDROCK_PRICING_FILENAME), bedrockPricingContent, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }
```

to:

```typescript
  // scripts/bundle-statusline.mjs (esbuild) bundles statusline.ts's project imports into this
  // single self-contained file at build time — no sibling files to deploy alongside it.
  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin', BUNDLE_FILENAME),
    'utf-8'
  );

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeFile(scriptPath, scriptContent, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }
```

- [ ] **Step 4: Simplify `uninstallStatusline()`**

Change:

```typescript
export async function uninstallStatusline(): Promise<void> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const legacyScriptPath = join(claudeHome, LEGACY_SCRIPT_FILENAME);
  const routingHeadersPath = join(claudeHome, ROUTING_HEADERS_FILENAME);
  const bedrockPricingPath = join(claudeHome, BEDROCK_PRICING_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  if (existsSync(scriptPath)) {
    await rm(scriptPath);
  }
  if (existsSync(routingHeadersPath)) {
    await rm(routingHeadersPath);
  }
  if (existsSync(bedrockPricingPath)) {
    await rm(bedrockPricingPath);
  }
  // Clean up the orphaned artifact from the old, now-removed --status flag mechanism,
  // in case it was ever written by a version prior to this consolidation.
  if (existsSync(legacyScriptPath)) {
    await rm(legacyScriptPath);
  }
```

to:

```typescript
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
```

(The rest of `uninstallStatusline()` — settings.json cleanup — is unchanged.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/agents/plugins/claude/statusline-installer.ts
git commit -m "refactor(claude): deploy the bundled statusline artifact, drop shim-file deployment"
```

---

### Task 5: Delete the shim files and filter `.ts` out of the Claude plugin asset copy

**Files:**
- Delete: `src/agents/plugins/claude/plugin/routing-headers.mjs`
- Delete: `src/agents/plugins/claude/plugin/bedrock-pricing.mjs`
- Modify: `scripts/copy-plugins.js`

With `statusline.ts` importing `@/utils/routing-headers.mjs` / `@/utils/bedrock-pricing.mjs` directly (Task 2) and bundled at build time (Task 3), nothing needs these two flat-sibling re-export shims to resolve statusline's imports when run directly from source (e.g. by `statusline.test.ts`, which now imports the compiled `../statusline.js` per Task 6 — TypeScript/Node module resolution follows the real `@/utils/...` alias, not a relative sibling).

`scripts/copy-plugins.js`'s "Claude plugin" entry recursively copies the entire `src/agents/plugins/claude/plugin/` directory into `dist/` (it ships `README.md`, `.claude-plugin/`, `hooks/`, `commands/`, and `session-status.mjs` verbatim, alongside whatever `tsc` separately compiles from any `.ts` files it finds there). Before this refactor there were no `.ts` files under that directory, so nothing needed filtering. Now that `statusline.ts` lives there, the recursive copy would also sweep the raw TypeScript source (and the `__tests__/` test file) into `dist/`, duplicating what `tsc` and `scripts/bundle-statusline.mjs` already produce there under different filenames — harmless but wasteful in the published npm package. Filter `.ts` files out of that one copy config.

- [ ] **Step 1: Delete the shims**

```bash
rm src/agents/plugins/claude/plugin/routing-headers.mjs
rm src/agents/plugins/claude/plugin/bedrock-pricing.mjs
```

- [ ] **Step 2: Add a `filter` option to the "Claude plugin" copy config**

In `scripts/copy-plugins.js`, change:

```javascript
  {
    name: 'Claude plugin',
    src: join(rootDir, 'src/agents/plugins/claude/plugin'),
    dest: join(rootDir, 'dist/agents/plugins/claude/plugin')
  },
```

to:

```javascript
  {
    name: 'Claude plugin',
    src: join(rootDir, 'src/agents/plugins/claude/plugin'),
    dest: join(rootDir, 'dist/agents/plugins/claude/plugin'),
    // statusline.ts lives in this tree as normal TS source; tsc compiles it and
    // scripts/bundle-statusline.mjs bundles it separately, both under dist/. Exclude .ts here so
    // this wholesale asset copy doesn't also duplicate the raw source (and its __tests__ file)
    // into the published package.
    filter: (src) => !src.endsWith('.ts')
  },
```

- [ ] **Step 3: Apply the `filter` option in the copy loop**

Change:

```javascript
  // Copy recursively
  console.log(`  - Copying from ${config.src}`);
  cpSync(config.src, config.dest, { recursive: true });
```

to:

```javascript
  // Copy recursively
  console.log(`  - Copying from ${config.src}`);
  cpSync(config.src, config.dest, { recursive: true, ...(config.filter ? { filter: config.filter } : {}) });
```

- [ ] **Step 4: Rebuild and verify no stray `.ts`/bundle-source duplication**

Run: `npm run build`
Expected: exits 0.

Run: `find dist/agents/plugins/claude/plugin -maxdepth 1 -name '*.ts'`
Expected: no output (empty — confirms the filter worked).

Run: `ls dist/agents/plugins/claude/plugin/ | grep -E 'routing-headers|bedrock-pricing'`
Expected: no output (confirms the shims are gone and nothing re-copies them).

Run: `ls dist/utils/ | grep -E 'routing-headers|bedrock-pricing'`
Expected: `routing-headers.mjs` and `bedrock-pricing.mjs` both listed — these two must still exist under `dist/utils/`, unrelated to this refactor, since `pricing.ts` and `usage-readers.ts` still import them directly (unbundled). `scripts/copy-plugins.js`'s existing `fileConfigs` entries for `dist/utils/routing-headers.mjs` / `dist/utils/bedrock-pricing.mjs` are untouched by this task — confirm they're still present in the file (they should not have been edited).

- [ ] **Step 5: Commit**

```bash
git add -A src/agents/plugins/claude/plugin scripts/copy-plugins.js
git commit -m "refactor(claude): delete statusline sibling-import shims, filter .ts from plugin asset copy"
```

---

### Task 6: Update the statusline unit tests for the `.ts` rename

**Files:**
- Modify: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`

Only the import path changes — every exported function name and behavior is identical to before, so no assertions change.

- [ ] **Step 1: Update the import**

Change:

```typescript
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
} from '../statusline.mjs';
```

to:

```typescript
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
```

- [ ] **Step 2: Update the stale comment above the `lookupRate` describe block**

Change:

```typescript
// The statusline is a .mjs file: package.json's lint glob covers {src,tests}/**/*.ts only, and tsc
// never compiles it. These tests are therefore the sole static or dynamic gate on the pricing path —
// an engine that overrides Claude Code's own reported spend and can otherwise be wrong silently.
describe('lookupRate', () => {
```

to:

```typescript
// statusline.ts is now a normal, type-checked, linted TS source file — but these tests remain the
// sole *behavioral* gate on the pricing path (an engine that overrides Claude Code's own reported
// spend, which typechecking and linting alone can't catch a logic error in).
describe('lookupRate', () => {
```

- [ ] **Step 3: Run the test file**

Run: `npx vitest run --project unit src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`
Expected: all tests pass (same count as before — no test bodies changed).

- [ ] **Step 4: Commit**

```bash
git add src/agents/plugins/claude/plugin/__tests__/statusline.test.ts
git commit -m "test(claude): point statusline tests at the renamed statusline.ts"
```

---

### Task 7: Update the statusline-installer unit tests for the simplified deploy

**Files:**
- Modify: `src/agents/plugins/claude/__tests__/statusline-installer.test.ts`

The installer no longer writes or removes `routing-headers.mjs`/`bedrock-pricing.mjs` — remove the assertions that expect those calls.

- [ ] **Step 1: Simplify the "deploys the script..." test**

Change:

```typescript
    it('deploys the script and reports alreadyConfigured=false when settings.json has no statusLine yet', async () => {
      mockReads({ settings: JSON.stringify({ theme: 'dark' }) });
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(false);
      expect(result.scriptPath).toBe(SCRIPT_PATH);

      // statusline.mjs imports both of these by relative path — they must land beside the
      // script itself.
      const routingHeadersWrite = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => String(p).endsWith('routing-headers.mjs')
      );
      expect(routingHeadersWrite).toBeDefined();

      const bedrockPricingWrite = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => String(p).endsWith('bedrock-pricing.mjs')
      );
      expect(bedrockPricingWrite).toBeDefined();

      const settingsWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SETTINGS_PATH);
      expect(settingsWrite).toBeDefined();
      const written = JSON.parse(settingsWrite![1] as string);
      expect(written.statusLine.type).toBe('command');
      expect(written.statusLine.refreshInterval).toBe(60);
    });
```

to:

```typescript
    it('deploys the bundled script and reports alreadyConfigured=false when settings.json has no statusLine yet', async () => {
      mockReads({ settings: JSON.stringify({ theme: 'dark' }) });
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(false);
      expect(result.scriptPath).toBe(SCRIPT_PATH);

      const scriptWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SCRIPT_PATH);
      expect(scriptWrite).toBeDefined();

      const settingsWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SETTINGS_PATH);
      expect(settingsWrite).toBeDefined();
      const written = JSON.parse(settingsWrite![1] as string);
      expect(written.statusLine.type).toBe('command');
      expect(written.statusLine.refreshInterval).toBe(60);
    });
```

- [ ] **Step 2: Simplify the `uninstallStatusline` "removes the script..." test**

Change:

```typescript
    it('removes the script, the shared domain modules, and the statusLine settings entry', async () => {
      const routingHeadersPath = join(CLAUDE_HOME, 'routing-headers.mjs');
      const bedrockPricingPath = join(CLAUDE_HOME, 'bedrock-pricing.mjs');
      vi.mocked(fsMod.existsSync).mockImplementation((p: any) =>
        p === SCRIPT_PATH || p === routingHeadersPath || p === bedrockPricingPath || p === SETTINGS_PATH
      );
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {}, theme: 'dark' }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith(SCRIPT_PATH);
      expect(fsp.rm).toHaveBeenCalledWith(routingHeadersPath);
      expect(fsp.rm).toHaveBeenCalledWith(bedrockPricingPath);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });
```

to:

```typescript
    it('removes the script and the statusLine settings entry', async () => {
      vi.mocked(fsMod.existsSync).mockImplementation((p: any) =>
        p === SCRIPT_PATH || p === SETTINGS_PATH
      );
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {}, theme: 'dark' }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith(SCRIPT_PATH);
      expect(fsp.rm).not.toHaveBeenCalledWith(expect.stringContaining('routing-headers.mjs'));
      expect(fsp.rm).not.toHaveBeenCalledWith(expect.stringContaining('bedrock-pricing.mjs'));
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });
```

- [ ] **Step 3: Run the full installer test file**

Run: `npx vitest run --project unit src/agents/plugins/claude/__tests__/statusline-installer.test.ts`
Expected: all tests pass, including the untouched "reports alreadyConfigured=true...", "creates ~/.claude when it does not exist", "throws ConfigurationError...", "also removes the legacy...", "skips removal when neither script exists", and `isStatuslineInstalled` tests.

- [ ] **Step 4: Commit**

```bash
git add src/agents/plugins/claude/__tests__/statusline-installer.test.ts
git commit -m "test(claude): drop shim-file assertions from statusline-installer tests"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: `unit`, `cli`, and `agent` projects all pass (agent project requires real auth — if it's not runnable in this environment, at minimum run `npx vitest run --project unit && npx vitest run --project cli` and confirm both pass).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exits 0, no diagnostics.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exits 0, zero warnings.

- [ ] **Step 4: Full build from clean**

Run: `rm -rf dist && npm run build`
Expected: exits 0; `dist/agents/plugins/claude/plugin/statusline.bundle.mjs` exists; no `.ts` files under `dist/agents/plugins/claude/plugin/`.

- [ ] **Step 5: End-to-end install verification**

Run (adjust `CODEMIE_HOME` to a scratch directory so this doesn't touch a real `~/.claude`):

```bash
export CODEMIE_HOME=/tmp/codemie-statusline-e2e
mkdir -p "$CODEMIE_HOME"
node -e "
const { installStatusline } = require('./dist/agents/plugins/claude/statusline-installer.js');
installStatusline().then(r => console.log('installed:', r));
"
```

Expected: prints `installed: { scriptPath: '.../.claude/codemie-budget-status.js', alreadyConfigured: false }`.

Run: `ls "$HOME/.claude/" 2>/dev/null | grep -E 'routing-headers|bedrock-pricing'` — wait, `installStatusline()` resolves `~/.claude` via `resolveHomeDir`, which uses the real OS `homedir()`, not `CODEMIE_HOME` (that env var only affects statusline's *own* runtime paths, not the installer's deploy target). Instead inspect the real `~/.claude/`:

```bash
ls ~/.claude/ | grep -E 'routing-headers|bedrock-pricing'
```
Expected: no output (confirms nothing under the real `~/.claude/` requires those two filenames anymore). If this repo's dev machine already has a prior install with those files present from before this refactor, that's pre-existing state, not a regression — this check only confirms the *new* install path doesn't recreate them. To fully verify from a clean slate instead, use a temp `HOME`:

```bash
env HOME=/tmp/codemie-statusline-e2e-home node -e "
const { installStatusline } = require('./dist/agents/plugins/claude/statusline-installer.js');
installStatusline().then(async () => {
  const fs = require('fs');
  console.log(fs.readdirSync('/tmp/codemie-statusline-e2e-home/.claude'));
});
"
```
Expected: the printed file list contains `codemie-budget-status.js`, `codemie-pricing.json`, and `settings.json` — and does NOT contain `routing-headers.mjs` or `bedrock-pricing.mjs`.

- [ ] **Step 6: Pipe a realistic payload through the deployed script and confirm rendering**

```bash
cd /tmp/codemie-statusline-e2e-home
echo '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"id":"claude-sonnet-5","display_name":"Claude Sonnet 5"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":1.23,"total_duration_ms":65000}}' | node ~/.claude/codemie-budget-status.js 2>/dev/null || \
echo '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"id":"claude-sonnet-5","display_name":"Claude Sonnet 5"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":1.23,"total_duration_ms":65000}}' | env HOME=/tmp/codemie-statusline-e2e-home node /tmp/codemie-statusline-e2e-home/.claude/codemie-budget-status.js
```
Expected: renders `[<dirname>] | [Claude Sonnet 5] | ████░░░░░░ 42% | ~$1.2300 | 1m 5s` (colors included) — confirms model label, context bar, cost (marked `~` since no real transcript exists to price), and duration all render correctly from the deployed artifact, matching the shape verified during planning.

- [ ] **Step 7: Routing-arrow and Bedrock-regional-pricing spot check**

Run this to confirm the bundled routing-headers/bedrock-pricing logic (inlined by esbuild) still resolves correctly, by exercising `lookupRate`'s Bedrock-regional path and `parseLastAssistantTurn`'s routing-header path directly against the compiled (non-bundled) module — the same logic the bundle inlines:

```bash
npx vitest run --project unit -t "resolves a Bedrock ARN back to its bare model id"
npx vitest run --project unit -t "prefers the routed model over the requested one"
```
Expected: both pass (already covered by Task 6's test run in Step 3 of Task 6 — this step re-runs them in isolation as an explicit named check against the acceptance criteria's call-out of "the routing-arrow and Bedrock-regional-pricing behavior").

- [ ] **Step 8: Clean up scratch verification state**

```bash
rm -rf /tmp/codemie-statusline-e2e /tmp/codemie-statusline-e2e-home
unset CODEMIE_HOME
```

- [ ] **Step 9: Report status**

No commit for this task — it's verification only. If any step fails, stop and fix the underlying issue in the relevant earlier task before proceeding (do not skip or weaken an assertion to force a pass).

---

## Self-Review Notes (for the plan author, not a task to execute)

- **Spec coverage:** every numbered item in the original spec's "Concrete scope" (1–8) and every "Acceptance criteria" bullet maps to a task above: bundler choice → Task 1/3; TS conversion → Task 2; build step → Task 3; installer update → Task 4; shim deletion → Task 5; pricing.json handling → confirmed as a non-issue in the plan header (statusline.ts never imports `pricing.ts`; it has always had its own independent sidecar-JSON reader keyed off its own `import.meta.url`, which continues to resolve correctly post-bundling because esbuild's ESM output preserves `import.meta.url` as the real runtime location of the deployed file — verified in Task 3, Step 4); tests still working from source → Task 6/7; end-to-end verification → Task 8.
- **`.d.mts` claim:** the acceptance criteria's "no more `.d.mts` hand-written declaration files for its own dependencies" is satisfied by construction — `statusline.ts` reuses the two *already-existing* shared `.d.mts` files (`src/utils/routing-headers.d.mts`, `src/utils/bedrock-pricing.d.mts`) that `pricing.ts`/`usage-readers.ts` already depend on regardless of this refactor. No new `.d.mts` file is created for statusline specifically, and none of the existing ones are touched.
- **Type consistency:** all function names (`buildStatusLine`, `computeSessionCost`, `resolveActualModel`, `lookupRate`, `matchBudgetRow`, `formatBudgetSegment`, `extractBasicInfo`, `formatDuration`, `ctxBar`, `resolveBudget`, `isMainModule`, `parseRouterModelIds`, `isRoutingConfigured`, `parseModelLabels`, `normalizeModelId`, `parseLastAssistantTurn`, `getAuthHeaders`) are unchanged between Task 2's new file and Task 6's test imports — verified by direct comparison against the original file read at planning time.
- **No placeholders:** every task shows complete before/after code; Task 2 embeds the full ~560-line converted source rather than a diff, since it's a rename plus scattered small edits that a diff would fragment.
