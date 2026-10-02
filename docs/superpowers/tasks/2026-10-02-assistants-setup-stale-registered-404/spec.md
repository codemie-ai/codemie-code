# Spec: tolerate stale registered assistants in interactive `codemie setup assistants`

## Problem

The interactive wizard pre-selects every registered assistant (`assistants/setup/selection/index.ts:63`) and then fetches each selected id via `fetchAssistantsByIds(selectedIds, [])` (`assistants/setup/index.ts:106`). Since #568 that fetch propagates every rejection (`assistants/setup/data.ts:153-194`), so one registered assistant that now returns 404 aborts the whole wizard with the SDK's generic `Resource with unknown not found`.

## Behavior

### Fetcher: reports, no policy

`fetchAssistantsByIds(selectedIds, existingAssistants)` keeps its arguments and changes its result:

```ts
interface FetchByIdsResult {
  found: (Assistant | AssistantBase)[]; // selectedIds order
  missing: string[];                    // ids whose get() rejected with NotFoundError, selectedIds order
}
```

1. When `client.assistants.get(id)` rejects with `codemie-sdk` `NotFoundError`, the id goes to `missing` and the loop continues, so partial results are kept.
2. Any other rejection (auth, 5xx, network) propagates unchanged.
3. The fetcher does not distinguish registered from newly selected ids. Its only caller is `index.ts:106`. Headless (`setupAssistantsHeadless`) does not call it and is unchanged.

### Consumer: owns the policy

A pure helper in `assistants/setup/helpers.ts` classifies the missing ids:

```ts
function resolveMissingAssistants(
  missing: string[],
  registered: CodemieAssistant[],
): CodemieAssistant[]; // stale registered entries, missing order
```

4. Each missing id that is in `registered` is stale and is returned with its local-config entry.
5. If any missing id is not registered (a new selection), the helper throws `RegistrationItemNotFoundError('assistant', id)` (`src/utils/errors.ts:50`) for the first such id.

`setupAssistants` calls the helper with `missing` and `registeredAssistants` (`index.ts:96`). Then, for each stale entry, it:

6. prints one `chalk.yellow` warning naming the assistant's local-config name and id (new `MESSAGES.SETUP` entry in `assistants/constants.ts`);
7. removes the id from `selectedIds` before the mode prompts and `applyChangesAndSave`. Existing code then treats it exactly like a user deselection: `determineChanges` lists it in `toUnregister`, `unregisterAssistant` removes its artifacts by slug, and `selectedRegistered` (`index.ts:167`) no longer carries it over.

8. `found` replaces the former array as `selectedAssistants`. If every selection is stale, the mode prompt is skipped by the existing `selectedAssistants.length > 0` guard, and the run proceeds to scope selection and unregistration.
9. Cancelling at any later prompt leaves config untouched, as it does today.

### Ruled out: reusing loaded rows instead of refetching

The wizard keeps calling `fetchAssistantsByIds` with `[]`. Seeding `existingAssistants` with the config-derived Registered-panel rows would skip the fetch for registered ids. A deleted assistant would then be re-registered silently, with no warning, and those rows lack the fields `getFullAssistant` and the generators need (analysis §6).

## Skills: same fix for interactive `codemie setup skills`

The skills wizard has the same abort. It pre-selects registered skills (`skills/setup/selection/index.ts:59`), and `fetchSkillsByIds` (`skills/setup/data.ts:192-218`) turns any 404 into `RegistrationItemNotFoundError('skill', id)`, so `setupSkills` (`skills/setup/index.ts:156`) aborts on one stale registered skill. The design mirrors the assistants one.

### Fetcher

`fetchSkillsByIds(ids, registeredSkills)` keeps its arguments and returns:

```ts
interface FetchSkillsByIdsResult {
  found: SkillDetail[]; // ids order
  missing: string[];    // ids whose get() rejected with NotFoundError, ids order
}
```

10. Fetching stays parallel. Each per-id task catches `NotFoundError` and resolves to a "missing" marker. `Promise.all` then splits the markers into `found` and `missing` and preserves `ids` order.
11. Any other rejection, including the `assertApiListResponse` shape check, still rejects `Promise.all` unchanged.
12. The fetcher no longer throws `RegistrationItemNotFoundError`; the consumer decides that.

### Consumer

A sibling pure helper in `skills/setup/helpers.ts`:

```ts
function resolveMissingSkills(missing: string[], registered: CodemieSkill[]): CodemieSkill[];
```

13. It follows the rules of items 4-5: registered missing ids are returned as stale, in `missing` order. The first unregistered missing id throws `RegistrationItemNotFoundError('skill', id)`.
14. `setupSkills` calls it with `missing` and `registeredSkills` (`index.ts:146`). For each stale entry it prints one `chalk.yellow` warning naming the skill's local-config name and id. It then removes the id from `selectedIds` before `determineChanges` (`index.ts:158`), so the skill lands in `toUnregister`, `unregisterSkill` removes it, and the `carriedOver` filter (`index.ts:176`) drops it. `found` replaces `selectedSkills`.
15. The skills wizard picks its storage scope before selection, and `registeredSkills` is per-scope, so the stale entry is removed from the scope it lives in.
16. Headless skills setup (`setupSkillsHeadless`, `index.ts:303`) resolves skills from the catalog and never calls `fetchSkillsByIds`; it is unchanged.

## Acceptance criteria

- AC1: Interactive setup with one stale registered assistant and other valid selections completes. The stale one gets a warning with its name and id and is unregistered on save.
- AC2: `fetchAssistantsByIds` returns `{ found, missing }`. A 404 puts the id in `missing`, and the loop continues for the remaining ids.
- AC3: `found` and `missing` each keep `selectedIds` order. Ids already in `existingAssistants` are not fetched.
- AC4: A non-404 rejection from `get` propagates unchanged from `fetchAssistantsByIds`.
- AC5: `resolveMissingAssistants` returns the registered entries for missing registered ids, and returns `[]` for empty `missing`.
- AC6: `resolveMissingAssistants` throws `RegistrationItemNotFoundError` whose message contains the id when any missing id is not registered.
- AC7: Headless behavior and its tests are unchanged.
- AC8: Vitest coverage: `assistants/setup/__tests__/data.test.ts` covers AC2-AC4 using `NotFoundError('Resource', 'unknown')` from `codemie-sdk`. Its existing `fetchAssistantsByIds` expectations are updated to the `{ found, missing }` shape. AC5-AC6 have their own unit tests for the helper, with no interactive UI involved.
- AC9: Interactive skills setup with one stale registered skill and other valid selections completes. The stale one gets a warning with its name and id and is unregistered on save.
- AC10: `fetchSkillsByIds` returns `{ found, missing }`. A 404 puts the id in `missing`, while the other ids are still fetched in parallel.
- AC11: For `fetchSkillsByIds`, `found` and `missing` each keep `ids` order, and empty `ids` returns `{ found: [], missing: [] }`.
- AC12: A non-404 rejection from `client.skills.get`, or a failed response-shape assertion, propagates unchanged from `fetchSkillsByIds`.
- AC13: `resolveMissingSkills` returns the registered entries for missing registered ids, and returns `[]` for empty `missing`.
- AC14: `resolveMissingSkills` throws `RegistrationItemNotFoundError` whose message contains the id when any missing id is not registered.
- AC15: Headless skills setup and `skills/setup/__tests__/headless.test.ts` are unchanged.
- AC16: Vitest coverage: `skills/setup/__tests__/data.test.ts` covers AC10-AC12. Its existing `fetchSkillsByIds` expectations (l.99-160, including the `RegistrationItemNotFoundError` cases) are updated to the `{ found, missing }` shape. AC13-AC14 have their own unit tests for the helper, with no interactive UI involved.

## Non-goals

- Removing stale entries from the scope the user did not pick in the storage prompt (existing cross-scope behavior for deselections applies).
- Prompting the user to confirm stale removal; it is automatic on save.
- Treating 403 or other errors as stale.
- Reusing wizard panel data to avoid the refetch.
- Fixing `return setupAssistants(options)` dropping `hostAgent` on Back (`index.ts:122`).
- Tests for the full interactive `setupAssistants` flow beyond what AC8 requires.
