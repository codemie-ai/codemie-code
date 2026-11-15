# Claude prompt-cache 1h TTL: consistent, visible, diagnosable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the existing `ENABLE_PROMPT_CACHING_1H=1` default, and add one resolver of the effective prompt-cache setup used by a launch debug line and a `codemie doctor` check.

**Architecture:** A new module `src/agents/plugins/claude/prompt-cache.ts` owns the two shared default rules and the resolver (one ordered precedence table, structured result). `beforeRun` calls it for defaults and the debug line; a new doctor check calls the same resolver. Settings layers come from the existing layered reader, extended.

**Tech Stack:** TypeScript ES modules (`.js` import suffixes, `@/` alias), Vitest, `logger.debug`, no `any`.

**Spec:** `docs/superpowers/tasks/2026-11-14-claude-prompt-cache-1h-ttl/spec.md` (+ gate decision: unit tests for the resolver and the doctor check are in scope).

Commit per task using the repository's existing convention.

## Global Constraints

- AC2: env and args produced at launch are identical to today for every provider/agent pair. Values and gating of `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and every other default are unchanged.
- Do not touch `src/agents/core/` (`resolveHook`, `lifecycle-helpers.ts`, `BaseAgentAdapter.ts`), any provider template, the SSO proxy, pricing, statusline or analytics readers.
- `ENABLE_PROMPT_CACHING_1H` stays the only injected cache variable; never inject `CLAUDE_CODE_PROMPT_CACHE_TTL`. No profile/CLI setting.
- The resolver and doctor never write a settings file, spawn a process or send a model request. No console output at launch — debug log only.
- No text anywhere (comments, doctor messages) claims lower spend.
- Precedence order is the spec's Intent order, unverified against the binary (recorded spec risk): keep it in the single table so a correction is one edit.
- Consequence of the bedrock non-goal: bedrock + `claude` runs no agent default `beforeRun`, so it gets no debug line either. Do not work around it.

## Review Focus

1. A settings layer that is valid JSON but whose `env` is not an object (array, string) → `unknown`, naming that file (Task 2 test).
2. `ENABLE_PROMPT_CACHING_1H=0` / `yes` from the shell → `unknown` with the value shown, not `5m` and not `1h` (Task 2 test).
3. A settings `env` entry in a higher layer overriding the shell value → source names the highest file, not the shell (Task 2 test).
4. The resolver throwing or a settings read failing during launch must not fail or delay-fail the launch (Task 3 test).
5. `ConfigLoader.load()` throwing in doctor → one `warn`, `success: true` (Task 4 test).

---

### Task 1: Shared cache defaults + pinned 1h default

**Files:**
- Create: `src/agents/plugins/claude/prompt-cache.ts`
- Modify: `src/agents/plugins/claude/claude.plugin.ts:70` (move `TOOL_SEARCH_VERIFIED_PROVIDERS` and its comment into the new module, import it back; keep any existing export via re-export), `:287-289`, `:351-353`
- Test: `src/agents/plugins/claude/__tests__/claude.plugin.prompt-cache.test.ts` (new; same mocks and `runBeforeRun(env)` helper as `claude.plugin.tool-search.test.ts`)

**Interfaces — Produces:**

```ts
/** Pure. Returns only the keys CodeMie would set, i.e. those empty/unset in `env`. */
export function claudeCacheDefaults(env: NodeJS.ProcessEnv):
  { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?: string; ENABLE_PROMPT_CACHING_1H?: string };
```

Betas: `'0'` when `TOOL_SEARCH_VERIFIED_PROVIDERS.has(env.CODEMIE_PROVIDER ?? '')`, else `'1'`. Cache: `'1'`.

**Test-first: yes — `beforeRun` on `ai-run-sso`, `litellm`, `ollama` sets `ENABLE_PROMPT_CACHING_1H='1'`; a shell value `'0'` or `'true'` is kept; `''` becomes `'1'`; `claudeCacheDefaults` returns `{}` when both keys are set and betas `'0'`/`'1'` by provider.** The default/explicit/empty cases pass against today's code (they pin behaviour); the `claudeCacheDefaults` cases fail until the module exists.

- [ ] Step 1: Write the test file; run `npx vitest run src/agents/plugins/claude/__tests__/claude.plugin.prompt-cache.test.ts` — the `claudeCacheDefaults` cases fail on import.
- [ ] Step 2: Create the module and function. In `beforeRun`, replace the two guarded assignments at `:287-289` and `:351-353` with one `Object.assign(env, claudeCacheDefaults(env))` at the position of the betas block (it must stay before the tool-search default); keep `toolSearchVerified` for `ENABLE_TOOL_SEARCH`. Keep the existing betas comment; add the cache comment in its neighbours' style: why (1h TTL instead of upstream 5m), opt-out (set the variable in the shell; a non-empty value is kept), upstream needs Claude Code v2.1.108+, which is below the supported minimum at `:44-54`, doc URL `https://code.claude.com/docs/en/settings`.
- [ ] Step 3: Re-run the new file plus `claude.plugin.tool-search.test.ts` — all pass.

### Task 2: Settings layers + effective-setup resolver

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.ts:39-86` — add the exported layer reader below; `readClaudeSettingsEnv` keeps its signature and results (it may be rebuilt on top of the new function).
- Modify: `src/agents/plugins/claude/prompt-cache.ts`
- Test: `src/agents/plugins/claude/__tests__/prompt-cache.test.ts` (new); one added case in `src/agents/plugins/claude-code-otlp/__tests__/claude-settings-env.test.ts`

**Interfaces — Consumes:** `claudeCacheDefaults` (Task 1). **Produces:**

```ts
// claude-settings-env.ts — same order as settingsLayerPaths (lowest to highest precedence)
export interface ClaudeSettingsLayer { path: string; state: 'ok' | 'absent' | 'unreadable'; settings?: Record<string, unknown> }
export function readClaudeSettingsLayers(cwd: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<ClaudeSettingsLayer[]>;

// prompt-cache.ts
export type CacheTtl = '1h' | '5m' | 'disabled' | 'unknown';
export type CacheSource =
  | { kind: 'shell' | 'codemie-default' | 'upstream-default' }
  | { kind: 'settings'; path: string };
export interface PromptCacheSetup {
  ttl: CacheTtl;
  decidedBy: string;            // variable or settings key, e.g. 'FORCE_PROMPT_CACHING_5M', 'promptCacheTtl', 'upstream default'
  value?: string;               // raw deciding value
  source: CacheSource;
  confirmed: boolean;           // false when resolved CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is '1'/'true'
  subagent?: { ttl: CacheTtl; decidedBy: string; source: CacheSource }; // only when a subagent override exists
  variables: Record<string, string>; // every cache variable + the betas switch, as resolved
}
export interface PromptCacheInput { env: NodeJS.ProcessEnv; codemieDefaults: boolean }
/** Pure. `env` is the environment BEFORE CodeMie defaults. */
export function decidePromptCacheSetup(input: PromptCacheInput, layers: ClaudeSettingsLayer[]): PromptCacheSetup;
export function resolvePromptCacheSetup(input: PromptCacheInput & { cwd: string }): Promise<PromptCacheSetup>;
export function describePromptCacheSource(source: CacheSource): string; // 'shell', 'CodeMie default', 'Claude Code default', or the file path
```

Rules for `decidePromptCacheSetup`:
- Resolved value of a variable: the highest `ok` layer whose `settings.env` defines it (source `settings`), else `env` (`shell`), else — when `codemieDefaults` — `claudeCacheDefaults(env)` (`codemie-default`).
- Any layer `unreadable`, or an `ok` layer whose `env` is not a plain object → `ttl: 'unknown'`, `decidedBy: 'unreadable settings'`, source that file. Checked before the table.
- One exported ordered table `PROMPT_CACHE_PRECEDENCE`, first matching row decides (truthy = `1`/`true`, case-insensitive):
  1. any variable starting `DISABLE_PROMPT_CACHING` truthy → `disabled`
  2. `FORCE_PROMPT_CACHING_5M` truthy → `5m`
  3. `CLAUDE_CODE_PROMPT_CACHE_TTL` → `1h` / `5m`, any other non-empty value `unknown`
  4. settings key `promptCacheTtl` (highest `ok` layer) → same mapping
  5. `ENABLE_PROMPT_CACHING_1H` → `1`/`true` gives `1h`; any other non-empty value `unknown`
  6. nothing matched → `5m`, `decidedBy: 'upstream default'`, source `upstream-default`
- `subagent`: `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, then settings key `subagentPromptCacheTtl`, same mapping; absent when neither is set.

**Test-first: yes — a table-driven test of `decidePromptCacheSetup`: one case per precedence row, each pair of adjacent rows set together (the earlier wins), CodeMie default → `1h`/`codemie-default`, shell `1` → `shell`, `codemieDefaults: false` with empty env → `5m`/`upstream-default`, `confirmed` true on `ai-run-sso` and false on `ollama` and when the shell sets betas `1`, the subagent override, and Review Focus 1-3; plus `readClaudeSettingsLayers` returning four-plus layers with `absent`/`unreadable`/`ok` and paths honouring `CLAUDE_CONFIG_DIR`.**

- [ ] Step 1: Write both tests; run `npx vitest run src/agents/plugins/claude/__tests__/prompt-cache.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-settings-env.test.ts` — new cases fail.
- [ ] Step 2: Implement `readClaudeSettingsLayers`, then the table and the three functions. `resolvePromptCacheSetup` = `readClaudeSettingsLayers(cwd, env)` + `decidePromptCacheSetup`.
- [ ] Step 3: Re-run — all pass, existing `claude-settings-env` cases unchanged.

### Task 3: Launch debug line

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts` — `beforeRun` (`:273`, at the Task 1 call site)
- Test: `src/agents/plugins/claude/__tests__/claude.plugin.prompt-cache.test.ts`

**Interfaces — Consumes:** `resolvePromptCacheSetup`, `describePromptCacheSource` (Task 2).

Copy the env before defaults are applied (`{ ...env }`), then after them await `resolvePromptCacheSetup({ env: copy, codemieDefaults: true, cwd: process.cwd() })` inside `try/catch` and write exactly one `logger.debug('[claude] prompt cache', { ttl, decidedBy, source: describePromptCacheSource(source), confirmed, variables })`. On a throw, write one `logger.debug` with the error message instead. Nothing goes to the console; `env` is not modified by this step.

**Test-first: yes — with `logger` mocked, `beforeRun` on `ai-run-sso` logs exactly one `'[claude] prompt cache'` line with `ttl: '1h'`, `source: 'CodeMie default'`; with `FORCE_PROMPT_CACHING_5M=1` it logs `ttl: '5m'`, `source: 'shell'`; with `resolvePromptCacheSetup` mocked to reject, `beforeRun` still resolves and the env equals the no-log run (Review Focus 4).**

- [ ] Step 1: Add the cases; run the file — they fail (no log line).
- [ ] Step 2: Implement as above.
- [ ] Step 3: Re-run the file — all pass.

### Task 4: `codemie doctor` prompt-cache check

**Files:**
- Create: `src/cli/commands/doctor/checks/PromptCacheCheck.ts`
- Modify: `src/cli/commands/doctor/checks/index.ts:5-15` (re-export), `src/cli/commands/doctor/index.ts:10-22` (import) and `:93-105` (append `new PromptCacheCheck()` after `AgentsCheck` in the `checks` array — the array is what runs a check)
- Test: `src/cli/commands/doctor/checks/__tests__/PromptCacheCheck.test.ts` (new; mock `ConfigLoader`, `AgentRegistry` and `@/agents/plugins/claude/prompt-cache.js`)

**Interfaces — Consumes:** `resolvePromptCacheSetup`, `describePromptCacheSource`, `PromptCacheSetup` (Task 2); `HealthCheck`, `HealthCheckResult` from `../types.js`.

`class PromptCacheCheck implements HealthCheck`, `name = 'Claude Prompt Cache'`. `run()`:
1. Claude not among `AgentRegistry.getInstalledAgents()` → one `info` detail ("Claude Code not installed (skipped)"), return.
2. `config = await ConfigLoader.load()`; `provider = config.provider`; call the resolver with `env: { ...process.env, CODEMIE_PROVIDER: provider }`, `codemieDefaults: provider !== 'bedrock'`, `cwd: process.cwd()`.
3. First detail, `info`: profile name and working directory evaluated.
4. Outcome detail:
   - `1h` and `confirmed` → `ok`, naming the source.
   - `1h` and not `confirmed` → `info`: "1h requested, not confirmed on this provider path".
   - provider `bedrock` and `source.kind === 'upstream-default'` → `info`: CodeMie's 1h default is not applied on bedrock (known gap).
   - otherwise (`5m`, `disabled`, `unknown`) → `warn`, message names `decidedBy`, its value and `describePromptCacheSource(source)`; `hint` says how to remove it (unset the variable, or delete the key from the named file; for an unreadable file, fix its JSON/permissions).
   - `subagent` present with `ttl !== '1h'` → an additional `warn` of the same shape.
5. Last detail, always, `info`: confirm what is billed with `codemie-claude -p "hi" --output-format json` and compare `usage.cache_creation.ephemeral_1h_input_tokens` with `ephemeral_5m_input_tokens`.
6. Any thrown error → one `warn` with the message. `success` is always `true`.

**Test-first: yes — one case per outcome: not installed → single `info`; `ai-run-sso` clean → `ok`; `ollama` clean → `info` "not confirmed"; bedrock upstream default → `info` known gap; shell `FORCE_PROMPT_CACHING_5M`, a settings-file source, `disabled` and `unknown` (unreadable layer) → `warn` whose message contains the variable/file; every installed-case result ends with the confirming-command detail and has `success: true`; resolver called with `codemieDefaults: false` on bedrock; `ConfigLoader.load()` rejecting → `warn`, `success: true` (Review Focus 5).**

- [ ] Step 1: Write the test file; run `npx vitest run src/cli/commands/doctor/checks/__tests__/PromptCacheCheck.test.ts` — fails on import.
- [ ] Step 2: Implement the check, the re-export and the array entry.
- [ ] Step 3: Re-run — all pass.

---

## Negative-constraint pass

| Constraint (spec) | Honoured by |
|---|---|
| No bedrock fix / no `resolveHook`, core or template change | Global Constraints; Task 3 logs from the agent default only; Task 4 reports the gap as `info` |
| No per-profile or CLI setting | no task adds one |
| No editing of user settings; no process spawn; no model request | Task 2 reads only; Task 4 prints a command, runs none |
| No console warning at launch | Task 3 uses `logger.debug` only |
| No change to betas or other defaults' value or gating | Task 1 moves two rules verbatim, pinned by its tests and `tool-search` tests |
| `CLAUDE_CODE_PROMPT_CACHE_TTL` not injected | Task 1 returns two keys only |
| No proxy, pricing, statusline, analytics change | no task touches them |
| No claim about lower spend | Global Constraints (comment and doctor copy) |
| Resolver has no provider list of its own for "not confirmed" | Task 2 derives `confirmed` from the resolved betas value |
| Doctor never sets `success: false` | Task 4 step 6 and tests |
