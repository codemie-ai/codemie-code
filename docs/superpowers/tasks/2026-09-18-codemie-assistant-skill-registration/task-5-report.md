DONE

## Commit

`26b4448bf8` — feat(cli): add headless branch to setup assistants

## Changed files

- `src/cli/commands/assistants/setup/index.ts` — new flags on `createAssistantsSetupCommand`, headless branch at the head of `setupAssistants`, new exported `setupAssistantsHeadless`, new local `parseRegistrationModeFlag`.
- `src/cli/commands/assistants/constants.ts` — `MESSAGES.SETUP.OPTION_ASSISTANT`, `OPTION_SCOPE`, `OPTION_MODE`, `OPTION_YES`.
- `src/cli/commands/assistants/setup/__tests__/headless.test.ts` — new (test-first).
- `src/cli/commands/assistants/setup/__tests__/index.test.ts` — amended (see below).
- `src/cli/commands/assistants/__tests__/setup.test.ts` — amended (see below).

`git show --stat HEAD` lists exactly these 5 files — matches the brief's declared files plus the two pre-existing tests I had to amend.

## Pre-existing tests amended and why

Both `assistants/setup/__tests__/index.test.ts` and `assistants/__tests__/setup.test.ts` hardcoded `expect(command.options).toHaveLength(5)` (4 original options + `--verbose`). Adding `--assistant`, `--scope`, `--mode`, and `-y/--yes` grows the option surface to 9, so both assertions (2 occurrences in each file) were changed from `toHaveLength(5)` to `toHaveLength(9)`. No other assertions in either file were touched.

## Test commands

```
npx vitest run --project unit src/cli/commands/assistants/setup/__tests__/headless.test.ts src/cli/commands/assistants/setup/__tests__/index.test.ts src/cli/commands/assistants/__tests__/setup.test.ts
```
EXIT=0 (3 files passed, 58 tests passed)

```
npx vitest run --project unit src/cli/commands/shared src/cli/commands/assistants src/cli/commands/skills
```
EXIT=0 (45 files passed, 932 tests passed) — no regression to Tasks 1-4 or the skills side.

`npx tsc --noEmit` — clean (exit 0).

## Flags added

- `--assistant <ids>` — "Assistant identifier(s) to register, comma-separated (id, slug, or exact name); enables non-interactive mode"
- `--scope <scope>` — "Storage scope for non-interactive registration: global or local"
- `--mode <mode>` — "Registration mode for non-interactive registration: agent or skill"
- `-y, --yes` — "Run non-interactively, skipping all prompts"

(`--agent <agents>` already existed and was not re-declared, per the binding ruling.)

## setupAssistantsHeadless signature

```ts
export async function setupAssistantsHeadless(
  options: SetupCommandOptions,
  hostAgent?: TargetAgent
): Promise<void>
```

`hostAgent` is accepted for signature parity with `setupAssistants`/the wizard entry point and is passed through to `logger.debug` for diagnostics; it is not used to resolve the agent target in headless mode (the target always comes from the required `--agent` flag via `parseAgentSetupTarget`).

## Pre-flight ordering

Implemented exactly as specified: validate flags (`parseListFlag`/`parseScopeFlag`/`parseRegistrationModeFlag` via `requireFlag`, including a presence-only `requireFlag(options.agent, '--agent')`) → `ConfigLoader.load` → `getAuthenticatedClient` → `loadRegisteredAssistants` → `fetcher.fetchAllVisibleAssistants()` → `resolveIdentifiers('assistant', ...)` → `parseAgentSetupTarget(options.agent)` → only then `applyChanges` (which internally uses Task 4's `registerAllOrAbort`) → `ConfigLoader.saveAssistantsToProjectConfig`.

This ordering is asserted by tests in `headless.test.ts`:
- The three missing-flag tests (`--scope`, `--agent`, `--mode`) assert `getAuthenticatedClient` was never called, proving flag validation happens before any I/O.
- The unresolvable-identifier test asserts `getAuthenticatedClient` and `fetchAllVisibleAssistants` WERE called (proving the catalog fetch ran), but `registerAssistant`, `unregisterAssistant`, `ConfigLoader.saveAssistantsToProjectConfig`, and `displaySummary` were NOT called, proving `resolveIdentifiers` aborts before any write.

`detectInstalledTargets`/`setRawMode` unreachability: `detectInstalledTargets` is a private, non-exported function in `agent-targets.ts` only reachable through `resolveAgentSetupTargets`. The test mocks `resolveAgentSetupTargets` itself and asserts it is never called in the full-flag-set test, which transitively proves `detectInstalledTargets` (and therefore any `process.stdin.setRawMode` call inside the agent-target-selection UI, which is only reachable from the same function) is never reached. The same test also asserts `promptAssistantSelection`, `promptModeSelection`, `promptManualConfiguration`, and `promptStorageScope` are never called.

## Design note (not explicitly specified by the brief)

`--assistant <ids>` is treated as the complete desired selection for this invocation (mirroring the interactive multi-select's `selectedIds` semantics exactly, by reusing `applyChanges` unmodified) — i.e. `selectedIds = resolvedAssistants.map(a => a.id)`, not a union with previously-registered ids. This means, like the interactive flow, a previously-registered assistant not named in `--assistant` would be computed as `toUnregister` by `determineChanges`. This was the simplest option that reuses `applyChanges`/`registerAllOrAbort` verbatim without inventing new merge logic, and it wasn't covered by the brief's test list (all headless tests use an empty `registeredAssistants` fixture, so this path isn't exercised by my tests). Flagging it in case the intended headless semantics were meant to be purely additive — that would need explicit reconciliation logic layered on top of `applyChanges`, which Task 6 (skills, mirror-image) should probably decide consistently with whatever is confirmed here.

## Concerns

None blocking. The one open design question is the additive-vs-full-replacement semantics of `--assistant` noted above.

---

## Fix 1 (finding): headless registration must be purely additive

Ruling (binding): headless mode never unregisters anything. `--assistant` names items to add/refresh; it is not a full-replacement selection.

Root cause: `setupAssistantsHeadless` set `selectedIds = resolvedAssistants.map(a => a.id)` and passed the *full* `registeredAssistants` list into `applyChanges`. `determineChanges` computed every registered assistant not in `selectedIds` as `toUnregister`, and `applyChanges` calls `unregisterAssistant` on every entry in `toUnregister`.

Naive fix considered and rejected: simply widening `selectedIds` to `union(all registeredAssistants ids, resolvedIds)` does make `determineChanges`'s `toUnregister` empty, but `applyChanges` *also* computes a local `toReregister = registeredAssistants.filter(a => selectedSet.has(a.id))` and unregisters+re-registers everything in it — with a naive full-list union, that becomes *every* previously-registered assistant, not just the requested ones. That would still call `unregisterAssistant` on untouched assistants (failing the covering test), and would silently overwrite their registration mode with this run's single `--mode` flag value, and could throw `RegistrationItemNotFoundError` for an untouched assistant no longer present in the visible catalog.

Actual fix: scope what's handed to `applyChanges` to the requested ids only.
- `selectedIds = dedup(resolvedAssistants.map(a => a.id))` (the requested ids; a full union with all registered ids can't be used for the reason above).
- `registeredInScope = registeredAssistants.filter(a => selectedIds includes a.id)` — the already-registered ids that overlap the request (this is the "already-registered" side of the union; since it's already a subset of `selectedIds`, the union is exactly `selectedIds`) — passed as `applyChanges`'s `registeredAssistants` argument instead of the full list. This makes `determineChanges`'s `toUnregister` provably empty (its inputs are a subset of `selectedIds` by construction) and keeps `toReregister` scoped to only the requested-and-already-registered items.
- `untouchedRegistered = registeredAssistants.filter(a => !selectedIds includes a.id)` — assistants registered outside the request. These never enter `applyChanges`, so `unregisterAssistant`/`registerAssistant` are never called on them, and they're spliced back into the final list unchanged: `allRegistered = [...untouchedRegistered, ...newRegistrations]` (replacing the old `keptAssistants` computation, which is no longer needed since every id in scope now always ends up in `newRegistrations`).

This still reuses `applyChanges`/`registerAllOrAbort` verbatim — no new write loop, no new merge logic beyond the ids-in-scope/ids-out-of-scope split described above.

Commit: see `git log` for the fix commit following this one; report details in `task-5-fix-1-report.md`.
