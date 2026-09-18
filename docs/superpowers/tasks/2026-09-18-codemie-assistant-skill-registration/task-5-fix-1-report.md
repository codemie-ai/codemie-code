DONE

## Commit

`1076fabe80` — fix(cli): make headless assistant registration purely additive

## Changed files

- `src/cli/commands/assistants/setup/index.ts` — `setupAssistantsHeadless` now scopes what it hands `applyChanges` to the requested ids only, and reconciles untouched registrations back in afterward.
- `src/cli/commands/assistants/setup/__tests__/headless.test.ts` — new covering test with a non-empty `registeredAssistants` fixture.

## Test commands and results

```
npx vitest run --project unit src/cli/commands/assistants/setup/__tests__/headless.test.ts src/cli/commands/assistants/setup/__tests__/index.test.ts src/cli/commands/assistants/__tests__/setup.test.ts
```
EXIT=0 (3 files passed, 59 tests passed)

```
npx vitest run --project unit src/cli/commands/shared src/cli/commands/assistants src/cli/commands/skills
```
EXIT=0 (45 files passed, 933 tests passed — 932 baseline + 1 new)

```
npx tsc --noEmit
```
EXIT=0

Pre-commit hook (lint-staged: eslint, scoped vitest, typecheck, gitleaks) also ran clean on commit.

## RED output (new test against pre-fix code)

Test: "is purely additive: an already-registered assistant not named in --assistant is never unregistered and survives the save" — fixture: `loadRegisteredAssistants`/`ConfigLoader.load` return an already-registered assistant `id-3` (mode `skill`); `--assistant` names only `id-1`.

```
AssertionError: expected "vi.fn()" to not be called with arguments: [ …(4) ]

Received:

  1st vi.fn() call:

  [
    {
      "agentTargets": ["claude"],
      "description": "Assistant Three description",
      "id": "id-3",
      "name": "Assistant Three",
      "project": "proj",
      "registeredAt": "2025-01-01T00:00:00.000Z",
      "registrationMode": "skill",
      "slug": "assistant-three",
    },
    "global",
    "/Users/Nikita_Levyankov/repos/codemie-ai/codemie-code",
    ["claude"],
  ]

Number of calls: 1
```

`unregisterAssistant` was called for `id-3` even though it was never named in `--assistant` — confirming the finding (the pre-fix code passed the full `registeredAssistants` list into `applyChanges`, so `determineChanges` classified `id-3` as `toUnregister`).

## How the union was built, and why it deviates from a literal "union of all ids"

I first traced what a literal reading — `selectedIds = union(all registeredAssistants ids, resolvedIds)`, `registeredAssistants` argument to `applyChanges` left as the full list — would actually do, before writing it, because `applyChanges` has a second removal-adjacent computation beyond `determineChanges`:

```ts
const toReregister = registeredAssistants.filter(a => selectedSet.has(a.id));
...
for (const assistant of [...toUnregister, ...toReregister]) {
  await unregisterAssistant(assistant, scope, workingDir, target);
}
```

Widening `selectedIds` to include every already-registered id does make `determineChanges`'s `toUnregister` empty, but it also makes `toReregister` equal to *every* registered assistant (since `selectedSet` becomes a superset of all registered ids by construction) — so `unregisterAssistant` would still fire on the untouched assistant (failing the covering test), the untouched assistant's mode would get silently overwritten with this run's single `--mode` flag value (a correctness problem beyond the covering test), and if the untouched assistant weren't present in the freshly fetched catalog, `getFullAssistant` would return `null` and `registerAllOrAbort` would throw `RegistrationItemNotFoundError`/`PartialRegistrationError` for an assistant nobody asked to touch.

So instead of widening `selectedIds`, I scoped the *set of already-registered assistants handed to `applyChanges`* down to only the overlap with the request:

```ts
const selectedIds = Array.from(new Set(resolvedAssistants.map(assistant => assistant.id)));
const selectedIdSet = new Set(selectedIds);
const registeredInScope = registeredAssistants.filter(a => selectedIdSet.has(a.id));
const untouchedRegistered = registeredAssistants.filter(a => !selectedIdSet.has(a.id));
```

`registeredInScope`'s ids are by construction a subset of `selectedIds` (the "union" of the requested ids and the already-registered ids that overlap them collapses to `selectedIds` itself), so `determineChanges`'s `toUnregister` is provably empty and `applyChanges`'s local `toReregister` is scoped to only the requested-and-already-registered items. `untouchedRegistered` never enters `applyChanges` at all — `unregisterAssistant`/`registerAssistant` are never called on it — and it's spliced back into the saved list unchanged: `allRegistered = [...untouchedRegistered, ...newRegistrations]`, replacing the old `keptAssistants` computation (which is no longer needed since every id in scope now always lands in `newRegistrations`). Requested-item order is preserved via `resolvedAssistants.map(...)` before de-duplication.

This still reuses `applyChanges`/`registerAllOrAbort` verbatim (no fresh write loop) and adds no merge logic beyond the ids-in-scope / ids-out-of-scope split above.

## Concerns

- The fix deviates from the literal wording "union of the already-registered assistant ids and the newly resolved ids" passed as `selectedIds` — a literal full-list union does not actually satisfy the binding ruling once `applyChanges`'s `toReregister` is accounted for (see RED trace above; I verified this empirically, not just by inspection). I scoped the "already-registered" side of the union to the overlap instead, which does satisfy both the letter ("determineChanges yields an empty toUnregister") and the spirit (nothing outside `--assistant` is ever touched) of the instruction. Flagging in case a different resolution was intended for Task 6's mirror-image fix on the skills side.
- Interactive path (`setupAssistants`) was not touched; its full-replacement `keptAssistants`/`selectedIds` logic is untouched and still shares `applyChanges` unmodified.
