# Technical Research

**Task**: assistants setup registration
**Generated**: 2026-10-02
**Research path**: filesystem

---

## 1. Original Context

Fix `codemie setup assistants` crashing with "❌ Resource with unknown not found" when a previously-registered assistant no longer exists on the server (GET /v1/assistants/{id} returns 404).
Root cause: commit 2d91509 (#568, headless registration) removed the try/catch in `fetchAssistantsByIds` (src/cli/commands/assistants/setup/data.ts) so any rejection propagates. The interactive wizard (src/cli/commands/assistants/setup/index.ts:106) calls `fetchAssistantsByIds(selectedIds, [])`, where selectedIds is pre-seeded with every already-registered assistant (selection/index.ts:63). One stale registered entry (deleted/inaccessible assistant) aborts the whole interactive setup. Verified: assistant 0368dce9-3987-49ac-b12e-41ce45623a20 returns 404 via codemie-sdk, which throws NotFoundError("Resource","unknown") for every 404 (node_modules/codemie-sdk/dist/index.js:234).
Required behaviour:
- Keep strict propagation for newly selected assistants and for headless mode (do not regress #568 intent).
- For assistants pre-selected only because already registered, a 404 (NotFoundError) must not abort: warn the user naming the assistant (name/id from local config) and treat it as stale — unregister it (or offer to) rather than crashing.
- Avoid needless refetch: pass assistants already loaded by the wizard instead of [] where feasible.
- Errors surfaced for genuinely failing fetches should name the assistant id instead of the SDK's generic message.
- Unit tests (vitest; follow existing __tests__/data.test.ts patterns).
Also check whether the skills setup flow (`codemie setup skills` or similar) has the same pattern and note it.

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/assistants/setup/data.ts` — `createDataFetcher(deps)` returns `{ fetchAssistants, fetchAssistantsByIds, fetchAllVisibleAssistants }`.
  - `fetchAssistantsByIds(selectedIds, existingAssistants)` (l.153–194): builds a map from `existingAssistants`, sequentially `await deps.client.assistants.get(id)` for each missing id with no try/catch (comment l.167–170 documents intentional propagation), returns results in `selectedIds` order. Has no knowledge of which ids are registered vs newly selected. `deps.config.codemieAssistants` (registered list) is available inside the closure.
  - `fetchRegisteredFromConfig` (l.125) maps local config entries to `AssistantBase` (`id, name, description, slug, project`) — not full `Assistant` objects.
  - `fetchAllVisibleAssistants` (l.227) crawls `visible_to_user` + `marketplace`; used only by headless.
- `src/cli/commands/assistants/setup/index.ts`
  - `setupAssistants` (interactive, l.85–186): `registeredAssistants = loadRegisteredAssistants()` (merged cross-scope view) → `promptAssistantSelection` → l.106 `fetcher.fetchAssistantsByIds(selectedIds, [])` → mode prompts → `applyChangesAndSave({ selectedIds, allAssistants: selectedAssistants, registeredInScope: registeredAssistants, carryOver: withoutWritten(selectedRegistered, …) })`. `selectedRegistered` = registered filtered by `selectedIds` (l.167).
  - `setupAssistantsHeadless` (l.225+): uses `fetchAllVisibleAssistants` + `resolveIdentifiers`; **does not call `fetchAssistantsByIds`**.
  - `applyChanges` (l.~330): `determineChanges` → `toUnregister` = registered not in `selectedIds`; `toReregister` = registered in `selectedIds`; each is written via `writeOneAssistant`, which calls `getFullAssistant` and throws `RegistrationItemNotFoundError('assistant', id)` (l.404) when a registered id has no full record in `allAssistants`.
  - `promptManualConfiguration(selectedAssistants, registeredIds, registeredAssistants)` (l.138) consumes `selectedAssistants`.
- `src/cli/commands/assistants/setup/selection/index.ts` — `initializeState` seeds `selectedIds: new Set(registeredIds)` (l.63); `promptAssistantSelection` returns only `{ selectedIds, action }` (l.139). Panel data lives in `state.panels[].data`, overwritten per page/search by `src/cli/commands/shared/selection/actions.ts` (l.85), so only the last-viewed page per panel is retained. Registered panel data is the config-derived `AssistantBase`.
- `src/cli/commands/shared/helpers.ts` — generic `determineChanges` (l.127), `handleSetupError` (l.152: logs, prints `formatErrorForUser`, `process.exit(1)`), `registerAllOrAbort`, `persistPartialWrites`.
- `src/utils/errors.ts:50` — `RegistrationItemNotFoundError(kind: 'assistant'|'skill', identifier)` → message `No ${kind} found matching "${identifier}"`; extends `CodeMieError`.
- `node_modules/codemie-sdk/dist/index.js:233` — `processFailedResponse`: any 404 → `throw new NotFoundError("Resource", "unknown")`. `NotFoundError` is exported from `codemie-sdk` (extends `ApiError`).
- `src/cli/commands/assistants/constants.ts` — `MESSAGES` object (e.g. `SHARED.ERROR_ASSISTANT_NOT_FOUND(id)`, `SETUP.*`); user-facing strings live here.

### Skills flow (same pattern — confirmed)
- `src/cli/commands/skills/setup/selection/index.ts:59` also seeds `selectedIds: new Set(registeredIds)`.
- `src/cli/commands/skills/setup/index.ts:156` interactive: `fetcher.fetchSkillsByIds(selectedIds, registeredSkills)`.
- `src/cli/commands/skills/setup/data.ts:192–218` `fetchSkillsByIds` (`_registeredSkills` param unused) uses `Promise.all` over `client.skills.get(id)`; on `NotFoundError` rethrows `RegistrationItemNotFoundError('skill', id)`. So a stale registered skill also aborts interactive `codemie setup skills`, though with an id-naming message rather than the SDK generic one. Skills is already the precedent for NotFoundError → named error mapping.

### Architecture and Layers Affected
- CLI command layer: `assistants/setup/index.ts` (interactive orchestration).
- Data layer: `assistants/setup/data.ts` (`fetchAssistantsByIds`).
- Selection UI layer: `assistants/setup/selection/index.ts` (only if loaded data is surfaced to the caller).
- Shared: `utils/errors.ts`, `assistants/constants.ts` (messages).

### Integration Points
- `codemie-sdk` `client.assistants.get(id)` / `NotFoundError`.
- `ConfigLoader.saveAssistantsToProjectConfig`, `unregisterAssistant` (`setup/helpers.ts:38`, removes Claude/Codex/Gemini artifacts by slug).

### Patterns and Conventions
- Dependency-injected fetcher factory (`createDataFetcher({config, client, options})`).
- Errors typed via `CodeMieError` subclasses in `@/utils/errors.js`; top-level `handleSetupError`.
- Comments explain *why* (e.g. propagation rationale) — keep that density.
- Path alias `@/` and `.js` import suffixes (ESM TS).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists with subdirs `architecture/ development/ integration/ security/ standards/ testing/ usage/` (not opened; no file named for assistants setup).
- `docs/COMMANDS.md`, `docs/SKILLS.md` document CLI commands generally.

### Architectural Decisions
- data.ts l.167–170 inline decision: fetch rejections must propagate so partial access does not report success (#568).
- index.ts l.407 comment: re-registration removes old artifacts immediately before writing the replacement.
- skills data.ts l.199–202: unknown id aborts the run rather than filtering silently.

### Derived Conventions
- Map SDK `NotFoundError` to `RegistrationItemNotFoundError(kind, id)` (skills precedent).
- User-facing strings in `MESSAGES`; `chalk.yellow` for warnings.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/assistants/setup/__tests__/data.test.ts` — `describe('fetchAssistantsByIds')` (l.602–787): existing-only, fetch-missing, multiple, reject-on-failure (asserts `.rejects.toThrow('Assistant not found')` — message-coupled), empty ids, empty existing, ordering.
- `__tests__/headless.test.ts` — mocks `createDataFetcher` (incl. `fetchAssistantsByIds: vi.fn()`), asserts `RegistrationItemNotFoundError` abort.
- `__tests__/index.test.ts` — only command shape/options; no tests of interactive `setupAssistants`.
- `skills/setup/__tests__/data.test.ts:123` — `NotFoundError('Resource','unknown')` → `RegistrationItemNotFoundError` test (template for assistants).

### Testing Framework and Patterns
- vitest; `vi.mock('@/utils/logger.js')`; mock client `{ assistants: { listPaginated: vi.fn(), get: vi.fn() } } as any`; `mockConfig.codemieAssistants` seeded with `registered-1`, `registered-2`; Arrange/Act/Assert comments; `NotFoundError` importable from `codemie-sdk` in tests.

### Coverage Gaps
- Interactive `setupAssistants` flow (stale handling, unregister of stale entries, carry-over) has no tests.
- No assistants test for NotFoundError specifically.
- Skills interactive stale path untested.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_DEBUG` (set by `--verbose`).

### Configuration Files
- Registered assistants stored per scope via `ConfigLoader` (`loadRegisteredAssistants` merged view for interactive; `loadAssistantsByScope` for headless).

### Feature Flags and Deployment Concerns
- None.

---

## 6. Risk Indicators

- `fetchAssistantsByIds` has no registered/new distinction; the classification source is `deps.config.codemieAssistants` (populated at index.ts:97) — tolerance must not apply in headless (which does not call this function, so the risk is limited to future callers).
- Speculative: dropping a stale id from `selectedIds` after the fetch is sufficient for unregistration — `determineChanges` then puts it in `toUnregister`, `unregisterAssistant` removes its artifacts, and `selectedRegistered` (l.167) no longer carries it over. If it stays in `selectedIds`, `writeOneAssistant` throws `RegistrationItemNotFoundError` at l.404 instead.
- Passing wizard-loaded data instead of `[]` is limited: `promptAssistantSelection` returns only ids; panel `data` holds only the last page per panel; Registered-panel rows are config-derived `AssistantBase` lacking fields generators need (`getFullAssistant`, generators). Feeding Registered-panel rows as `existingAssistants` would skip the fetch and break re-registration.
- Interactive `loadRegisteredAssistants` is a cross-scope merged view; unregistering a stale entry saves to the scope the user picks — a stale entry from the other scope may persist there.
- Existing test `rejects.toThrow('Assistant not found')` will break if errors are rewrapped with the id.
- `index.ts:122` `return setupAssistants(options)` on Back drops `hostAgent` (adjacent, pre-existing).
- Skills interactive flow has the identical abort for stale registered skills.

---

## 7. Summary for Complexity Assessment

The bug sits in two files: `assistants/setup/data.ts` (`fetchAssistantsByIds`, sequential `client.assistants.get` with no error handling) and the interactive orchestration in `assistants/setup/index.ts` (l.106 passing `[]` and the pre-seeded `selectedIds`). Downstream code (`determineChanges`, `applyChanges`, `withoutWritten`) already unregisters any registered id missing from `selectedIds`, so stale handling can reuse existing machinery. Headless mode uses `fetchAllVisibleAssistants`, not `fetchAssistantsByIds`, so #568 strictness is structurally isolated. Optional touch: `selection/index.ts` if wizard-loaded rows are surfaced.

No novel patterns: the skills fetcher already maps SDK `NotFoundError` to `RegistrationItemNotFoundError(kind, id)`, giving a direct precedent. Test posture is good for the data layer (`data.test.ts` has a `fetchAssistantsByIds` block with mock client and registered config fixtures) but the interactive `setupAssistants` flow has no tests, and one existing test asserts the raw error message.

Key risks: correctly distinguishing registered-only pre-selections from new selections, not feeding config-derived `AssistantBase` rows as full assistants, and cross-scope merged registrations. The skills interactive flow (`skills/setup/index.ts:156`, `data.ts:203`) has the same abort-on-stale behaviour and is a candidate follow-up or parallel fix.

---

## 8. External References

None named by the task (all cited paths are in-repo; `node_modules/codemie-sdk/dist/index.js:233–235` confirmed: `if (status === 404) { throw new NotFoundError("Resource", "unknown"); }`).
