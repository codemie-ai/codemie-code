# Headless Registration for Assistants and Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `codemie setup assistants` and `codemie setup skills` a non-interactive branch behind explicit flags, and make both modes abort the whole run before the first write when a requested item is not available.

**Architecture:** Flags go on the existing command factories (`assistants/setup/index.ts:37`, `skills/setup/index.ts:16`), so both wiring sites — `cli/commands/setup.ts:27-28` and `agents/core/AgentCLI.ts:115-116` — inherit them with no edit. Shared logic (mode detection, flag validation, identifier matching, all-or-nothing writes) lands in `src/cli/commands/shared/` and serves both trees. Fail-fast is achieved by removing partial tolerance at its three sources, not by layering over them.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `@/` alias, explicit export return types, no `any`), commander, Vitest (`npx vitest run --project unit <file>`), co-located `__tests__/*.test.ts`, dynamic `await import()` of the module under test inside the test body after spies are installed.

**Spec:** `docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Headless when any headless flag or `-y/--yes` is present, or `process.stdin.isTTY` is not `true` (pattern: `skills/add.ts:52`).
- `--scope`, `--agent`, and (assistants only) `--mode` are **required** in headless mode. No defaults, no auto-detection — `detectInstalledTargets()` must not run on this path.
- Multi-value flags are comma-separated single values, matching `--agent <agents>` (`assistants/setup/index.ts:45`).
- No new verb, no new top-level command; flags go on the existing `setup` subcommands.
- No `process.stdin.setRawMode` call may be reachable in headless mode.
- Untouched by every task: `*/setup/selection/`, `codemie skills add|update|remove|list|find`, `skills/lib/skills-metrics.ts`, `--json` output, `src/migrations/`, and the known defects at `assistants/setup/index.ts:95`, `utils/config.ts:939-941`, `skills/setup/helpers.ts:80`.

---

### Task 1: Headless mode detection and flag validation

**Files:** Create `src/cli/commands/shared/headless.ts`; modify `src/utils/errors.ts` (append after `AnalyticsSourceError`, line 48); test `src/cli/commands/shared/__tests__/headless.test.ts`.

**Produces:**
```ts
export interface HeadlessFlags { yes?: boolean; scope?: string; agent?: string; assistant?: string; skill?: string; mode?: string }
export function isHeadlessMode(flags: HeadlessFlags, isTty: boolean): boolean;
export function requireFlag(value: string | undefined, flagName: string): string;  // else ConfigurationError naming the flag
export function parseScopeFlag(value: string): StorageScope;                       // 'global' | 'local', else ConfigurationError
export function parseListFlag(value: string): string[];                           // comma-split, trimmed, de-duped, non-empty
// src/utils/errors.ts
export class RegistrationItemNotFoundError extends CodeMieError { constructor(kind: 'assistant' | 'skill', identifier: string) }
export class AmbiguousIdentifierError extends CodeMieError { constructor(kind: 'assistant' | 'skill', identifier: string, candidates: { id: string; name: string }[]) }
```

**Test-first: yes** — `headless.test.ts` fails: `@/cli/commands/shared/headless.js` does not exist.

- [ ] **Step 1: Write the failing tests.** `isHeadlessMode` is true when `yes` is set, when any of `scope|agent|assistant|skill|mode` is set, and when `isTty` is false; false for `{}` at a TTY. `requireFlag(undefined, '--scope')` throws `ConfigurationError` whose message contains `--scope`. `parseScopeFlag('LOCAL')` → `StorageScope.LOCAL`; `parseScopeFlag('repo')` throws. `parseListFlag('a, b ,a')` → `['a','b']`; `parseListFlag(' ')` throws. Assert error class **and** message.
- [ ] **Step 2: Run the file — expect FAIL (module not found).**
- [ ] **Step 3: Implement** the two error classes (`AmbiguousIdentifierError` lists each candidate as `name (id)`) and the four helpers.
- [ ] **Step 4: Re-run — expect PASS.**
- [ ] **Step 5: Commit.**

---

### Task 2: Identifier resolution by id, slug, or exact name

**Files:** Create `src/cli/commands/shared/identifier-resolution.ts`; test `src/cli/commands/shared/__tests__/identifier-resolution.test.ts`.

**Consumes:** Task 1's error classes. **Produces:**
```ts
export interface ResolvableItem { id: string; name: string; slug?: string }
export function resolveIdentifiers<T extends ResolvableItem>(kind: 'assistant' | 'skill', identifiers: string[], catalog: T[]): T[];
```
Case-insensitive, matched id → slug → exact name, result ordered like `identifiers`. No match throws `RegistrationItemNotFoundError`; a name matching several catalog entries throws `AmbiguousIdentifierError` listing every candidate — it never picks one.

**Test-first: yes** — resolution test fails: `identifier-resolution.ts` does not exist.

- [ ] **Step 1: Write the failing tests.** Fixture of three items, two sharing a `name`. Assert: id match; slug match; case-insensitive name match; requested order preserved across a mixed batch; unknown identifier → `RegistrationItemNotFoundError` naming it; duplicated name → `AmbiguousIdentifierError` whose message contains both candidate ids; an id match wins over a name collision.
- [ ] **Step 2: Run the file — expect FAIL (module not found).**
- [ ] **Step 3: Implement** `resolveIdentifiers` with one pass building id/slug/name-bucket maps.
- [ ] **Step 4: Re-run — expect PASS.**
- [ ] **Step 5: Commit.**

---

### Task 3: Paged catalog fetch, and fail-fast on an unfetchable item

**Files:** Modify `src/cli/commands/assistants/setup/data.ts` (add `fetchAllVisibleAssistants`; `fetchAssistantsByIds` at lines 147-189 must stop swallowing) and `src/cli/commands/skills/setup/data.ts` (add `fetchAllVisibleSkills`; replace the `per_page: 100` client-side filter at lines 122-136); tests `src/cli/commands/assistants/setup/__tests__/data.test.ts`, `src/cli/commands/skills/setup/__tests__/data.test.ts`.

**Produces:** `fetchAllVisibleAssistants(): Promise<AssistantBase[]>` on `DataFetcher` and `fetchAllVisibleSkills(): Promise<SkillListItem[]>` on `SkillDataFetcher` — both page `listPaginated` until `pages` is exhausted, reusing the existing `API_SCOPE.VISIBLE_TO_USER` scope and the `assertApiListResponse` guard so a stale SSO session surfaces as its own error rather than as "not available".

**Test-first: yes** — the `fetchAllVisible*` tests fail (method undefined) and the amended `fetchAssistantsByIds` test fails because the rejection is swallowed today at `data.ts:173-175`.

- [ ] **Step 1: Write the failing tests.** A mocked client returning `pages: 2` yields both pages concatenated with `listPaginated` called twice. `await expect(fetchAssistantsByIds([...], []))` **rejects** when `client.assistants.get` rejects, instead of resolving to a short array. `fetchSkillsByIds` finds an id that lives on page two.
- [ ] **Step 2: Run both files — expect FAIL.**
- [ ] **Step 3: Implement** the two paging methods; drop the try/catch swallow in `fetchAssistantsByIds`, keeping the `logger.debug` trace; route `fetchSkillsByIds` through `fetchAllVisibleSkills`.
- [ ] **Step 4: Re-run — expect PASS.**
- [ ] **Step 5: Commit.**

---

### Task 4: All-or-nothing writes that report what was already written

**Files:** Modify `src/cli/commands/shared/helpers.ts` (add `executeWithSpinnerStrict` beside `executeWithSpinner`, lines 6-37, leaving that function's behaviour intact), `src/utils/errors.ts`, `src/cli/commands/assistants/setup/helpers.ts:66-127`, `src/cli/commands/skills/setup/helpers.ts:58-90`, `src/cli/commands/assistants/setup/index.ts:185-197`, `src/cli/commands/skills/setup/index.ts:131-138`; test `src/cli/commands/shared/__tests__/registration-writes.test.ts`.

**Produces:**
```ts
export async function executeWithSpinnerStrict<T>(spinnerMessage: string, operation: () => Promise<T>, successMessage: string, errorMessage: string, onError?: (e: unknown) => void): Promise<T>;
export async function registerAllOrAbort<TItem, TResult>(items: TItem[], nameOf: (item: TItem) => string, writeOne: (item: TItem) => Promise<TResult>): Promise<TResult[]>;
export class PartialRegistrationError extends CodeMieError { constructor(written: string[], cause: unknown) }  // src/utils/errors.ts
```
`registerAllOrAbort` stops at the first rejection and throws `PartialRegistrationError` naming, in order, the items already written. There is no rollback — those artifacts stay on disk (spec non-goal).

**Test-first: yes** — the helper test fails: `executeWithSpinnerStrict`, `registerAllOrAbort` and `PartialRegistrationError` do not exist.

- [ ] **Step 1: Write the failing tests.** `executeWithSpinnerStrict` rethrows the original error after stopping the spinner and still calls `onError`. `registerAllOrAbort` over three items whose third rejects throws `PartialRegistrationError` listing exactly the first two names and not the third; an all-success batch returns three results in order.
- [ ] **Step 2: Run the file — expect FAIL.**
- [ ] **Step 3: Implement** the strict spinner, the error class and `registerAllOrAbort`. Switch `registerAssistant` and `registerSkill` to the strict spinner and tighten their return types to non-nullable. Replace the register loop in `assistants/setup/index.ts:188-197` and the one in `skills/setup/index.ts:132-138` with `registerAllOrAbort`, and replace `if (!fullAssistant) continue;` (line 190) with a thrown `RegistrationItemNotFoundError`. Unregister paths keep `executeWithSpinner` unchanged.
- [ ] **Step 4: Re-run, plus `assistants/setup/__tests__/index.test.ts` — expect PASS.**
- [ ] **Step 5: Commit.**

---

### Task 5: Headless branch in `setupAssistants`

**Files:** Modify `src/cli/commands/assistants/setup/index.ts` (factory options at lines 40-46, `SetupCommandOptions` at lines 23-29, new branch at the head of `setupAssistants`, line 62) and `src/cli/commands/assistants/constants.ts` (new `MESSAGES.SETUP` strings for the flags); test `src/cli/commands/assistants/setup/__tests__/headless.test.ts`.

**Consumes:** Tasks 1-4. New flags `--assistant <ids>`, `--scope <scope>`, `--mode <mode>` (`agent|skill`, per `manualConfiguration/types.ts:9`), `-y, --yes`. **Produces:** `setupAssistantsHeadless(options, hostAgent?)`, exported for test.

Pre-flight first, writes second: validate flags → `getAuthenticatedClient` → `fetchAllVisibleAssistants` → `resolveIdentifiers` → `parseAgentSetupTarget(options.agent)` → only then `applyChanges` and `saveAssistantsToProjectConfig`. Every prompt (`promptAssistantSelection`, `promptModeSelection`, `promptManualConfiguration`, `promptStorageScope`, `resolveAgentSetupTargets`) is skipped.

**Test-first: yes** — the test fails because commander rejects `--assistant` as an unknown option and `setupAssistantsHeadless` is not exported.

- [ ] **Step 1: Write the failing tests.** With the prompts and `detectInstalledTargets` spied: a full flag set registers both requested assistants and calls no spy. Missing `--scope`, missing `--agent`, missing `--mode` each reject with `ConfigurationError` naming that flag. An identifier absent from the catalog rejects with `RegistrationItemNotFoundError` **before** any generator or `saveAssistantsToProjectConfig` spy runs. `createAssistantsSetupCommand()` and `createAssistantsSetupCommand('claude')` expose an identical option-name set (flag parity across both wiring sites).
- [ ] **Step 2: Run the file — expect FAIL.**
- [ ] **Step 3: Implement** the flags and the branch, dispatching on `isHeadlessMode(options, process.stdin.isTTY === true)`; the interactive path below it is unchanged.
- [ ] **Step 4: Re-run, plus `assistants/setup/__tests__/index.test.ts` and `assistants/__tests__/setup.test.ts` — expect PASS.**
- [ ] **Step 5: Commit.**

---

### Task 6: Headless branch in `setupSkills`

**Files:** Modify `src/cli/commands/skills/setup/index.ts` (factory options at lines 19-23, new branch at the head of `setupSkills`, line 90; `showDisclaimer` at line 39 unchanged); test `src/cli/commands/skills/setup/__tests__/headless.test.ts`.

**Consumes:** Tasks 1-4. New flags `--skill <ids>`, `--scope <scope>`, `-y, --yes`. **Produces:** `setupSkillsHeadless(options, hostAgent?)`, exported for test.

Same pre-flight order as Task 5, via `fetchAllVisibleSkills` + `resolveIdentifiers('skill', …)`. The skills notice is informational, not a consent gate: headless prints the same text through `console.log` and continues; the Enter gate stays on the interactive path only.

**Test-first: yes** — the test fails because commander rejects `--skill` as an unknown option and `setupSkillsHeadless` is not exported.

- [ ] **Step 1: Write the failing tests.** Spy `process.stdin.setRawMode` and assert it is never called. A full flag set registers the requested skills and saves once. Missing `--scope` and missing `--agent` each reject naming the flag. An unknown identifier rejects with `RegistrationItemNotFoundError` before `saveSkillsToProjectConfig` runs. The notice text appears in `console.log` output. `createSkillsSetupCommand()` and `createSkillsSetupCommand('claude')` expose an identical option-name set.
- [ ] **Step 2: Run the file — expect FAIL.**
- [ ] **Step 3: Implement** the flags and the branch.
- [ ] **Step 4: Re-run, plus `skills/setup/__tests__/data.test.ts` — expect PASS.**
- [ ] **Step 5: Commit.**

---

## Negative-constraint pass

- **No new verb / no top-level command** — Tasks 5-6 add options to the existing factories only.
- **Wizard not rebuilt** — no task lists a file under `*/setup/selection/`; Tasks 5-6 branch above the interactive path and leave it as-is.
- **Upstream `skills` wrapper untouched** — no task lists a file under `src/cli/commands/skills/` outside `setup/`.
- **No telemetry** — `skills/lib/skills-metrics.ts` is in no Files block; `SkillCommand` is unchanged.
- **No `--json`** — the added flags are exactly `--assistant`, `--skill`, `--scope`, `--mode`, `-y/--yes` (plus the pre-existing `--agent`).
- **No schema change or migration** — Tasks 5-6 persist through the existing `saveAssistantsToProjectConfig` / `saveSkillsToProjectConfig`; `src/migrations/` is in no Files block.
- **No filesystem rollback** — Task 4 reports already-written items and explicitly leaves them.
- **No auto-detection in headless** — Tasks 5-6 call `parseAgentSetupTarget` directly and assert `detectInstalledTargets` is never reached.
- **Known defects left alone** — `assistants/setup/index.ts:95`, `utils/config.ts:939-941`, `skills/setup/helpers.ts:80` appear in no task.
- **No coverage backfill beyond the new paths** — every new test file exercises a path this plan introduces or changes.
