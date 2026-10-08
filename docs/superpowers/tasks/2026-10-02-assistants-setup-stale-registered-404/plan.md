# Stale Registered Assistants in Interactive Setup — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` syntax.

**Goal:** A registered assistant that now 404s no longer aborts interactive `codemie setup assistants`; it is warned about and unregistered on save.

**Architecture:** `fetchAssistantsByIds` reports 404s as `missing` instead of throwing (no policy). A pure helper in `assistants/setup/helpers.ts` classifies `missing` against the registered list: registered ids are stale, any other id throws. `setupAssistants` warns and drops stale ids from the selection, and the existing deselection machinery unregisters them.

**Tech Stack:** TypeScript (ESM, `@/` alias, `.js` suffixes), vitest, `codemie-sdk` (`NotFoundError`).

**Spec:** `docs/superpowers/tasks/2026-10-02-assistants-setup-stale-registered-404/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Only `codemie-sdk` `NotFoundError` counts as missing. 403, 5xx and network errors propagate unchanged.
- The wizard keeps calling `fetchAssistantsByIds(…, [])`. Do not seed it with panel rows.
- Headless (`setupAssistantsHeadless`) and `headless.test.ts` stay unchanged.
- No confirmation prompt for stale removal.
- User-facing strings go in `MESSAGES.SETUP` (`assistants/constants.ts`), and warnings use `chalk.yellow`.

## Review Focus

- Every selection is stale: the mode prompt is skipped (`selectedAssistants.length > 0` guard, `index.ts:110`), and scope selection plus unregistration still run.
- A stale registered id and a 404ing new selection in the same run: the run must throw for the new id before any prompt or write.
- Cancel after the stale warning: config stays untouched.
- Missing ids come back in `selectedIds` order even when they are interleaved with found ones.

---

### Task 1: `resolveMissingAssistants` helper + stale warning message

**Files:**
- Modify: `src/cli/commands/assistants/setup/helpers.ts` (add export after `determineChanges`, ~l.30–36; import `RegistrationItemNotFoundError` from `@/utils/errors.js`)
- Modify: `src/cli/commands/assistants/constants.ts:54+` (`MESSAGES.SETUP`)
- Test: `src/cli/commands/assistants/setup/__tests__/helpers.test.ts` (new `describe('resolveMissingAssistants')`)

**Interfaces:**
- Produces: `resolveMissingAssistants(missing: string[], registered: CodemieAssistant[]): CodemieAssistant[]`, which returns the stale entries in `missing` order.
- Produces: `MESSAGES.SETUP.WARNING_STALE_ASSISTANT: (name: string, id: string) => string`. The message states that the assistant no longer exists on the server and will be unregistered.

Test-first: yes. The tests fail until the helper exists: (a) `[]` for empty `missing`; (b) the registered entries for missing registered ids, in `missing` order; (c) a throw of `RegistrationItemNotFoundError` whose message contains `"new-id"` when `missing` holds an unregistered id, including when a stale registered id precedes it.

- [ ] Write the three tests in the existing Arrange/Act/Assert style and run `npx vitest run src/cli/commands/assistants/setup/__tests__/helpers.test.ts`. They should fail with "not a function".
- [ ] Implement the helper. Build an id→entry map from `registered`, iterate `missing`, throw `new RegistrationItemNotFoundError('assistant', id)` on the first id that is not registered, and otherwise collect the entry. Then add the message. The tests should pass.

### Task 2: Fetcher returns `{ found, missing }`; wizard drops stale ids

**Files:**
- Modify: `src/cli/commands/assistants/setup/data.ts:153-194` (`fetchAssistantsByIds`), including the propagation comment at l.167–170
- Modify: `src/cli/commands/assistants/setup/index.ts:106-173`
- Test: `src/cli/commands/assistants/setup/__tests__/data.test.ts:602-787`

**Interfaces:**
- Consumes: `resolveMissingAssistants` and `MESSAGES.SETUP.WARNING_STALE_ASSISTANT` (Task 1).
- Produces:

```ts
export interface FetchByIdsResult {
  found: (Assistant | AssistantBase)[];
  missing: string[];
}
```

`fetchAssistantsByIds(selectedIds: string[], existingAssistants: (Assistant | AssistantBase)[]): Promise<FetchByIdsResult>`

Test-first: yes. In `data.test.ts`, `get` rejecting with `new NotFoundError('Resource', 'unknown')` for the middle of three ids resolves `{ found: [a, c], missing: ['b'] }`, and `get` is called for c. A generic `Error('boom')` still rejects with `'boom'`. Ids that are already in `existingAssistants` are not fetched.

- [ ] Update the existing `fetchAssistantsByIds` expectations to `.found` / `missing: []`. Add the NotFoundError test, an interleaved-order test (two missing ids among found ones) and the non-404 propagation test, keeping the existing reject-on-failure test as the non-404 case. Run `npx vitest run src/cli/commands/assistants/setup/__tests__/data.test.ts`. The new tests should fail.
- [ ] In the fetch loop, wrap `deps.client.assistants.get(id)` in try/catch. On `error instanceof NotFoundError`, push the id to `missing` and continue. Rethrow anything else. Return `found` in `selectedIds` order. Reword the l.167–170 comment: 404s are reported for the caller to decide, and other failures still propagate (#568). The data tests should pass.
- [ ] In `index.ts`, after l.106, destructure `{ found: selectedAssistants, missing }`. Call `resolveMissingAssistants(missing, registeredAssistants)`, print `chalk.yellow(MESSAGES.SETUP.WARNING_STALE_ASSISTANT(entry.name, entry.id))` per stale entry, and derive `activeIds = selectedIds.filter(id => !staleIds.has(id))`. Use `activeIds` in place of `selectedIds` at l.167 (`selectedRegistered`) and l.170 (`applyChangesAndSave`). The mode-prompt guard at l.110 stays as is. Run `npx tsc --noEmit` to confirm no other caller of `fetchAssistantsByIds` breaks (`headless.test.ts` only mocks it).

### Task 3: `resolveMissingSkills` helper

**Files:**
- Modify: `src/cli/commands/skills/setup/helpers.ts` (add export after `determineChanges`, ~l.25–32; import `RegistrationItemNotFoundError` from `@/utils/errors.js`)
- Create: `src/cli/commands/skills/setup/__tests__/helpers.test.ts` (mock `@/utils/logger.js` and the three skill generator modules, as `assistants/setup/__tests__/helpers.test.ts:11-28` does)

**Interfaces:**
- Produces: `resolveMissingSkills(missing: string[], registered: CodemieSkill[]): CodemieSkill[]`, which returns the stale entries in `missing` order (spec item 13).

Test-first: yes. The tests fail until the helper exists: (a) `[]` for empty `missing`; (b) the registered entries for missing registered ids, in `missing` order; (c) a throw of `RegistrationItemNotFoundError` whose message contains `"new-id"` when `missing` holds an unregistered id, including when a stale registered id precedes it.

- [ ] Write the three tests and run `npx vitest run src/cli/commands/skills/setup/__tests__/helpers.test.ts`. They should fail.
- [ ] Implement the helper with the same logic as `resolveMissingAssistants`, using kind `'skill'`. The tests should pass.

### Task 4: `fetchSkillsByIds` returns `{ found, missing }`; skills wizard drops stale ids

**Files:**
- Modify: `src/cli/commands/skills/setup/data.ts:192-218`, including the comment at l.199–202
- Modify: `src/cli/commands/skills/setup/index.ts:155-176`
- Test: `src/cli/commands/skills/setup/__tests__/data.test.ts:99-160`

**Interfaces:**
- Consumes: `resolveMissingSkills` (Task 3).
- Produces:

```ts
export interface FetchSkillsByIdsResult {
  found: SkillDetail[];
  missing: string[];
}
```

`fetchSkillsByIds(ids: string[], _registeredSkills: CodemieSkill[]): Promise<FetchSkillsByIdsResult>`

Test-first: yes. In `data.test.ts`, `skills.get` rejecting with `new NotFoundError('Resource', 'unknown')` for the middle of three ids resolves `{ found: [a, c], missing: ['b'] }`, and `get` is called for all three ids. Empty `ids` resolves `{ found: [], missing: [] }`. A generic `Error('boom')` and a response that fails `assertApiListResponse` both still reject unchanged.

- [ ] Rewrite the existing `fetchSkillsByIds` cases at l.99–160 for the `{ found, missing }` shape. Replace the `RegistrationItemNotFoundError` expectations with `missing` assertions. Add the interleaved-order, empty-ids, non-404 and shape-failure cases, then run `npx vitest run src/cli/commands/skills/setup/__tests__/data.test.ts`. The new tests should fail.
- [ ] In the `Promise.all` map, catch `NotFoundError` per id and resolve a marker such as `{ missing: id }`. Rethrow everything else. After `Promise.all`, partition the results into `found` and `missing`, keeping `ids` order. Remove the `RegistrationItemNotFoundError` import if it is now unused. Reword the l.199–202 comment: 404s are reported for the caller to decide. The data tests should pass.
- [ ] In `index.ts`, after l.156, destructure `{ found: selectedSkills, missing }`. Call `resolveMissingSkills(missing, registeredSkills)`, print one `chalk.yellow` line per stale entry naming `entry.name` and `entry.id` (inline string, following the file's existing inline messages), and derive `activeIds = selectedIds.filter(id => !staleIds.has(id))`. Use `activeIds` in `determineChanges` (l.158) and in the `carriedOver` filter (l.176). Run `npx tsc --noEmit`.

## Negative-constraint pass

- No 403/other errors treated as stale: Tasks 2 and 4 catch only `instanceof NotFoundError`.
- No reuse of panel data: Task 2 keeps `fetchAssistantsByIds(selectedIds, [])`.
- Headless unchanged: no task touches `setupAssistantsHeadless` or `setupSkillsHeadless` (AC7, AC15).
- No confirm prompt: Tasks 2 and 4 warn and remove the entry automatically.
- Other-scope cleanup and the `hostAgent`-on-Back fix are not touched.
- No full interactive-flow tests: only the helpers and fetchers are unit-tested, per AC8 and AC16.
