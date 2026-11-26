# EPMCDME-17853 Model env-override display — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use `- [ ]`.

**Goal:** `codemie profile status` (plain and `--show-sources`) and every agent banner show the model a launch uses and mark a `CODEMIE_MODEL` override with its origin (shell, `.env`, Copilot saved pick), in one wording.

**Architecture:** A dependency-free `src/utils/model-origin.ts` owns the origin type, the two new env var names, the origin records and the only origin-to-text helper. `ConfigLoader` gets one private layered resolve read by `load()`, `loadWithSources()` and a public override lookup. `AgentCLI` exports the origin and replaced profile model; the banner and status format them with the shared helper.

**Tech Stack:** TypeScript ES modules (`.js` imports), dotenv 16.6.1, Vitest 4, chalk.

**Spec:** `docs/superpowers/tasks/2026-11-25-epmcdme-17853-model-env-override-display/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Marker copy, exact: `<model> (CODEMIE_MODEL from shell env overrides profile: <profile>)`, `<model> (CODEMIE_MODEL from .env overrides profile: <profile>)`, `<model> (your saved codemie-copilot --model pick, overrides profile: <profile>)`. Empty profile model renders `N/A`.
- `load()` return shape unchanged; `renderProfileInfo()` unchanged; `CODEMIE_MODEL_SOURCE` stays `cli|env|default`, its four readers untouched.
- `config.ts` must not import `agents/core/event-fields/identity-fields.js` (import cycle).
- Tests clear ambient `CODEMIE_*` (incl. empty `CODEMIE_MODEL`), call `resetModelOriginRecords()`, and snapshot/restore `process.env` as in `src/agents/core/__tests__/project-parity.test.ts:77-107`.

## Review Focus

- Two `load()` calls in one process (AgentCLI, launch identity): the second must still report `dotenv`, because the record is by value, not re-derived from dotenv's return. Task 2 test.
- A later write to `process.env.CODEMIE_MODEL` after `.env` was loaded must read `shell`, not `.env`. Task 1 test.
- `--profile` with `CODEMIE_MODEL` set: no marker anywhere and source `default`. Task 4 test.
- Provider that blanks `CODEMIE_MODEL` (anthropic-subscription): both new vars empty. Task 4 test.
- Model text containing control characters is sanitized like the Project row (`sanitizeDisplayText`). Task 1 test.

---

### Task 1: Origin module and shared model text

**Files:** Create `src/utils/model-origin.ts`; Test `src/utils/__tests__/model-origin.test.ts`

**Interfaces — Produces** (pattern: `src/utils/project-binding.ts:16-26`):

```ts
export type ModelEnvOrigin = 'shell' | 'dotenv' | 'saved';
export const MODEL_ENV_ORIGIN_ENV = 'CODEMIE_MODEL_ENV_ORIGIN';
export const PROFILE_MODEL_ENV = 'CODEMIE_PROFILE_MODEL';
export function parseModelEnvOrigin(value: unknown): ModelEnvOrigin | undefined;
export function recordDotenvValues(applied: Record<string, string>): void; // keys dotenv added, with values
export function isFromDotenv(key: string, env?: NodeJS.ProcessEnv): boolean; // true only while env[key] === recorded value
export function recordSavedModelPick(model: string): void;
export function resolveModelEnvOrigin(env?: NodeJS.ProcessEnv): ModelEnvOrigin | undefined; // dotenv, then saved, then shell; undefined when CODEMIE_MODEL empty
export function resetModelOriginRecords(): void;
export function describeModel(model: string, origin: ModelEnvOrigin | undefined, profileModel: string | undefined): string;
```

Test-first: yes — `describeModel` returns the three Global-Constraints strings, plain model when origin is undefined or model equals profile model, `N/A` for empty profile; `resolveModelEnvOrigin` returns `dotenv` after `recordDotenvValues`, `shell` once `CODEMIE_MODEL` changes, `saved` after `recordSavedModelPick`, `undefined` for `''`; control characters stripped.

- [ ] Write the tests; run `npx vitest run src/utils/__tests__/model-origin.test.ts` — FAIL (module missing).
- [ ] Implement the module; records are module-level `Map`/value; reuse `sanitizeDisplayText` from `project-binding.ts`. Run again — PASS.

### Task 2: One layered resolve in ConfigLoader, `.env` labels

**Files:** Modify `src/utils/config.ts:141-265` (`load`), `:1538-1695` (`loadWithSources`, `showWithSources`), `:1765-1775` (`getSourceColor`); `src/env/types.ts:219-222`; docs `.ai-run/guides/usage/project-config.md:15`, `docs/CONFIGURATION.md` (add `(.env)` to the label list). Test `src/utils/__tests__/config-project-override.test.ts`.

**Interfaces — Consumes:** Task 1 `recordDotenvValues`, `isFromDotenv`. **Produces:**
- `ConfigWithSource.source` gains `'dotenv'` (printed `(.env)`, colour `chalk.greenBright`).
- `export interface ModelResolution { envModelUsed: boolean; profileModel?: string }` and `static modelResolutionOf(config: CodeMieConfigOptions): ModelResolution | undefined` — backed by a `WeakMap` that `load()` fills; a mocked plain object yields `undefined`.
- `loadWithSources(workingDir, cliOverrides?, envDir = workingDir)`, `showWithSources(workingDir = process.cwd(), envDir = workingDir)`.

Test-first: yes — with a real tmp `.env` setting `CODEMIE_MODEL`: `loadWithSources().sources.model.source === 'dotenv'` and `modelResolutionOf(load())` is `{ envModelUsed: true, profileModel: <stored> }`; shell value gives `'env'`; shell and `.env` both set → shell wins (`'env'`); `cliOverrides.name` set → `envModelUsed: false`; a local profile laid over a global one of the same name → `profileModel` is the field-merged pre-env value; a second `load()` still labels `dotenv`.

- [ ] Write the tests (setup per Global Constraints); run `npx vitest run src/utils/__tests__/config-project-override.test.ts` — new cases FAIL.
- [ ] Extract private `resolveLayered(workingDir, cliOverrides, envDir): Promise<{ config; sources; preEnvModel?: string }>` from `load()`: an `apply(layer, source)` step does the `Object.assign` and records each non-null key's `{ value, source }`; identity-key deletion (`:191-193`, `:207-210`) and the profile-name filter (`:214-253`) delete from `sources` too; workspace applies as two labelled parts (workspace scope, `resolution.identitySource`) as `loadWithSources` does today (`:1573-1587`). Snapshot `preEnvModel` before the env layer. Around `dotenv.config` (after the `await fs.access`, same synchronous block): note which keys exist, call it, pass the newly added `parsed` keys to `recordDotenvValues`. Env-layer keys label `'dotenv'` when every `CODEMIE_*` variable feeding the key (`loadFromEnv`, `:619-659`) `isFromDotenv`, else `'env'`. `load()` returns `config` and fills the WeakMap (`envModelUsed` = final `sources.model` is `env`/`dotenv`); `loadWithSources()` returns the resolve's sources plus `hasLocalConfig`. Built-in defaults now list as `(default)`; if an existing assertion encoded the old drift, update it and say so in the commit body.
- [ ] Run the whole file plus `src/utils/__tests__/config-per-profile-identity.test.ts` — PASS.

### Task 3: Launch exports origin and replaced profile model; Copilot records its pick

**Files:** Modify `src/agents/core/AgentCLI.ts:436-444`, `bin/codemie-copilot.js:90-96`. Create test `src/agents/core/__tests__/model-override-parity.test.ts` (real tmp config, `CODEMIE_HOME` stub, `.git` marker, spied `run` capturing env, as `project-parity.test.ts:77-107,399-411`).

**Interfaces — Consumes:** Task 1 constants, `resolveModelEnvOrigin`, `recordSavedModelPick`; Task 2 `ConfigLoader.modelResolutionOf`.

Test-first: yes — captured env for: shell override → `CODEMIE_MODEL_SOURCE=env`, origin `shell`, `CODEMIE_PROFILE_MODEL=<stored>`; `.env` override → origin `dotenv`; no / empty `CODEMIE_MODEL` → `default`, both new vars `''`; env equal to profile model → `env`, `describeModel` of captured values is the plain model; `--profile` + env → `default`, vars `''`; `--model` → `cli`, vars `''`; `recordSavedModelPick` + matching `CODEMIE_MODEL` → origin `saved`; `exportProviderEnvVars` spied to blank `CODEMIE_MODEL` → vars `''`. Each case also asserts `describeModel(...)` of the captured three values.

- [ ] Write the tests; run `npx vitest run src/agents/core/__tests__/model-override-parity.test.ts` — FAIL.
- [ ] In AgentCLI set `CODEMIE_MODEL_SOURCE` to `cli` / (`modelResolutionOf(config)?.envModelUsed` → `env`) / `default`; always set both new vars, filled (`resolveModelEnvOrigin(process.env) ?? ''`, `profileModel ?? ''`) only when source is `env` and `providerEnv.CODEMIE_MODEL` is non-empty. In `bin/codemie-copilot.js` import `recordSavedModelPick` from `../dist/utils/model-origin.js` and call it beside `:95`. Run the new file and `AgentCLI-model-source.test.ts` — PASS.

### Task 4: Banner marker

**Files:** Modify `src/agents/core/BaseAgentAdapter.ts:639`; Test `src/agents/core/__tests__/BaseAgentAdapter.test.ts`.

Test-first: yes — using the `RunPipelineAdapter` setup (`:434`) and the mocked `renderProfileInfo` (`:68`), `run([], { CODEMIE_MODEL: 'claude-opus-4-8[1m]', CODEMIE_MODEL_ENV_ORIGIN: 'dotenv', CODEMIE_PROFILE_MODEL: 'claude-sonnet-5' })` calls it with `model: 'claude-opus-4-8[1m] (CODEMIE_MODEL from .env overrides profile: claude-sonnet-5)'`; with both vars `''` the model is plain.

- [ ] Write tests; run `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts` — FAIL.
- [ ] `model = describeModel(env.CODEMIE_MODEL || 'unknown', parseModelEnvOrigin(env[MODEL_ENV_ORIGIN_ENV]), env[PROFILE_MODEL_ENV] || undefined)`. Run — PASS.

### Task 5: Status shows the effective model, launcher's config dir

**Files:** Modify `src/cli/commands/profile/index.ts:17-23,116-180`, `src/cli/commands/profile/display.ts:27-30,113-135`; Tests `model-override-parity.test.ts` (Task 3 file), `src/cli/commands/profile/__tests__/index.test.ts`.

**Interfaces — Produces:** `export async function loadStatusConfig(cwd: string): Promise<{ configDir: string; config: CodeMieConfigOptions; modelText: string }>` in `profile/index.ts`; `ProfileIdentityDisplay.model?: string`.

Test-first: yes — `loadStatusConfig(cwd).modelText` equals the banner text `describeModel` built from Task 3's captured env, for shell, `.env` and no-override scenarios; run from a repo subfolder it uses the repo-root `.codemie` (`configDir` equals the launcher's). In `index.test.ts`: `formatStatus(info, undefined, { model: 'X (CODEMIE_MODEL from shell env overrides profile: Y)' })` renders that text, and falls back to `profile.model || 'N/A'` without it.

- [ ] Write tests; run both files — FAIL.
- [ ] `loadStatusConfig`: dynamic-import `findNearestConfigDir` from `../../../agents/core/event-fields/identity-fields.js` (as `AgentCLI.ts:233`), `ConfigLoader.load(configDir, undefined, cwd)`, then `describeModel(config.model || 'N/A', res?.envModelUsed ? resolveModelEnvOrigin() : undefined, res?.profileModel)`. `handleStatus` uses it and passes `configDir` to `listProfiles`, `getActiveProfileName`, `hasLocalConfig`, `resolveIdentityDisplay`, adding `model: modelText` to the identity. `handleStatusWithSources` calls `showWithSources(configDir, process.cwd())`. `formatStatus` uses `identity.model ?? (profile.model || 'N/A')`. Run — PASS.
