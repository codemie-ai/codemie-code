DONE

## Commit
19df4a25af — fix(cli): page catalog fetch fully and stop swallowing fetch failures

## Changed files
- /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/src/cli/commands/assistants/setup/data.ts
- /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/src/cli/commands/assistants/setup/__tests__/data.test.ts
- /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/src/cli/commands/skills/setup/data.ts
- /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/src/cli/commands/skills/setup/__tests__/data.test.ts

`git show --stat HEAD` confirms exactly these 4 files.

## Test command (exact)
```
npx vitest run --project unit src/cli/commands/assistants/setup/__tests__/data.test.ts src/cli/commands/skills/setup/__tests__/data.test.ts > /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log 2>&1; echo "EXIT=$?"; tail -25 /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log
```

Final: `EXIT=0`, "Test Files 2 passed (2)", "Tests 47 passed (47)".

`npx tsc --noEmit`: EXIT=0, clean.

## TDD process followed
1. Wrote implementation first by mistake, caught it, then used `git stash push -- <the two data.ts files>` to revert just the implementation (keeping the new/amended tests in place) so the tests would run against the real pre-fix code.
2. Ran the test command against the reverted implementation — RED, 9 failing for the expected reasons:
   - `fetcher.fetchAllVisibleAssistants is not a function` / `fetcher.fetchAllVisibleSkills is not a function` (methods undefined).
   - `fetchAssistantsByIds` "should reject when an individual assistant fetch fails" — promise resolved with `[asst-1, asst-3]` instead of rejecting (rejection swallowed today).
   - `fetchSkillsByIds` "finds an id that lives on page two" — returned `[]` instead of the page-two skill (single-page client-side filter can't see page two).
3. `git stash pop` to restore the implementation.
4. Re-ran the same command — GREEN, EXIT=0, 47/47 passed.

## Exposed method signatures (for Tasks 5-6)
- `DataFetcher.fetchAllVisibleAssistants: () => Promise<AssistantBase[]>` (src/cli/commands/assistants/setup/data.ts)
- `SkillDataFetcher.fetchAllVisibleSkills: () => Promise<SkillListItem[]>` (src/cli/commands/skills/setup/data.ts)

Both are also returned from `createDataFetcher()` / `createSkillDataFetcher()` factory objects respectively, alongside the existing methods (unchanged signatures for `fetchAssistants`, `fetchAssistantsByIds`, `fetchSkills`, `fetchSkillById`, `fetchSkillsByIds`).

## Pre-existing tests amended (not just added)
- `src/cli/commands/assistants/setup/__tests__/data.test.ts`:
  - "should create data fetcher with required methods" — added assertion that `fetchAllVisibleAssistants` is a function.
  - "should continue on API error for individual assistant" — replaced with "should reject when an individual assistant fetch fails, instead of silently dropping it", now asserting the call rejects (this is the brief's required amendment; the old assertion codified the swallow-and-drop behavior being removed).
- `src/cli/commands/skills/setup/__tests__/data.test.ts`: no pre-existing test needed behavioral amendment beyond what's listed above; "filters the bulk-fetched skills by the requested IDs" still passes unchanged since it mocks a single page (`pages: 1`), which is a subset of the new paged behavior.

## Implementation notes
- `fetchAssistantsByIds`: removed the `try { … } catch (error) { logger.error(...) }` around `deps.client.assistants.get(id)`; kept both existing `logger.debug` calls (before the loop, and after each successful fetch) exactly as the brief instructed. `logger.error` is no longer called from this function — a rejection now propagates to the caller unmodified.
- `fetchAllVisibleAssistants`: pages `deps.client.assistants.listPaginated` with `scope: API_SCOPE.VISIBLE_TO_USER` (same scope constant already used by `fetchAssistants` for the PROJECT panel) and `assertApiListResponse(response, isAssistantListResponse, 'visible assistants')`, looping while `page < pages` (from `response.pagination.pages`), starting `pages` at 1 so the do/while always issues at least one request.
- `fetchAllVisibleSkills`: pages `client.skills.listPaginated({ page, per_page: 100 })` — same param shape the old single-page fetch used (no `scope`/`filters`, matching what existing skills fetch methods use for this endpoint), guarded by the existing `assertApiListResponse(response, isSkillListResponse, 'skills')`, looping on `response.pages` the same way.
- `fetchSkillsByIds` now calls `fetchAllVisibleSkills()` and filters the concatenated result by id, replacing the old single `per_page: 100` call.
- Did not touch `src/utils/errors.ts`, `src/cli/commands/shared/headless.ts`, `src/cli/commands/shared/identifier-resolution.ts`, `src/utils/config.ts`, `src/cli/commands/skills/setup/helpers.ts`, `*/setup/selection/*`, or `*/setup/index.ts` / `*/setup/helpers.ts`.

## Concerns
- None. Note for the record: skills' own `API_SCOPE` constant (`src/cli/commands/skills/setup/selection/constants.ts`) only defines `PROJECT`/`MARKETPLACE`, not `VISIBLE_TO_USER` — there is no SDK-level "visible to user" scope filter for skills' `listPaginated`. So `fetchAllVisibleSkills` reuses the exact no-scope param shape the pre-existing `fetchSkillsByIds` already used (which returns everything visible to the caller by omitting `scope`/`filters`), just paginated. `API_SCOPE.VISIBLE_TO_USER` is used verbatim only in `fetchAllVisibleAssistants`, matching the brief's "reuse them exactly as the existing fetch methods in the same files already do."
