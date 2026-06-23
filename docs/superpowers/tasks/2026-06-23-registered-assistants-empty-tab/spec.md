# Spec — Fix Registered Assistants Empty Tab

## Problem

`ConfigLoader.load()` calls `loadGlobalConfigProfile()` and `loadLocalConfigProfile()`, both of which return only the selected `ProviderProfile` spread. `codemieAssistants` and `codemieSkills` are stored at the `MultiProviderConfig` root (not inside any profile), so they are silently dropped on every `load()` call.

The save path (`saveAssistantsToProjectConfig`) writes to the correct root location — saves are correct. Reads are broken. As a result, `setupAssistants()` always receives `codemieAssistants: undefined`, the Registered tab shows empty, and any assistants that were registered appear to be gone.

## Acceptance Criteria

- After setup, navigating to Registered Assistants shows the previously registered assistants.
- `ConfigLoader.load()` returns `codemieAssistants` and `codemieSkills` from the `MultiProviderConfig` root when they are present.
- Local config without these fields does not overwrite global values (existing `removeUndefined()` behaviour in `load()` guarantees this).
- No regression to profile selection, env-var priority, or CLI-override behaviour.

## Changes

### `src/env/types.ts`

Add `codemieSkills?: CodemieSkill[]` to `ProviderProfile` alongside the existing `codemieAssistants` entry:

```typescript
// In-memory assistants/skills state (not persisted here; stored at MultiProviderConfig level)
codemieAssistants?: CodemieAssistant[];
codemieSkills?: CodemieSkill[];
```

This is required because `CodeMieConfigOptions = ProviderProfile`, so the field must exist on the type to survive the return from `loadGlobalConfigProfile` / `loadLocalConfigProfile`.

### `src/utils/config.ts`

**`loadGlobalConfigProfile` (line 228)** — include top-level fields in the return:

```typescript
// codemieAssistants and codemieSkills live at MultiProviderConfig root, not inside a profile
return {
  ...rawConfig.profiles[profile],
  name: profile,
  codemieAssistants: rawConfig.codemieAssistants,
  codemieSkills: rawConfig.codemieSkills,
};
```

**`loadLocalConfigProfile` (line 255)** — same change:

```typescript
// codemieAssistants and codemieSkills live at MultiProviderConfig root, not inside a profile
return {
  ...rawConfig.profiles[profile],
  name: profile,
  codemieAssistants: rawConfig.codemieAssistants,
  codemieSkills: rawConfig.codemieSkills,
};
```

When local config does not define these fields the values are `undefined`. `removeUndefined()` in `load()` strips `undefined` values before `Object.assign`, so a local config without these fields will not overwrite values loaded from global config.

## Out of Scope

- Moving `codemieAssistants`/`codemieSkills` into profiles (data-migration scope).
- Changes to save paths — they already write to the correct root location.
- Changes to `setupAssistants`, `fetchRegisteredFromConfig`, or the UI layer — they already handle the data correctly once `ConfigLoader.load()` returns it.
