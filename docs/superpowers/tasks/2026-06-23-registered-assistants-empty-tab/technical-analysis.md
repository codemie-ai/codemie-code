# Technical Analysis — Registered Assistants Empty Tab

## Codebase Findings

### Root Cause

`ConfigLoader.loadGlobalConfigProfile()` (line 228) and `loadLocalConfigProfile()` (line 255–256) in `src/utils/config.ts` spread only the per-profile data when returning:

```typescript
return { ...rawConfig.profiles[profile], name: profile };
```

`codemieAssistants` is stored at the **top level** of `MultiProviderConfig` (not inside a profile), so it is silently dropped on every `ConfigLoader.load()` call. The field is always `undefined` in the returned `CodeMieConfigOptions`.

### Save Path (correct, unaffected)

`saveAssistantsToProjectConfig()` (line 858) loads the raw `MultiProviderConfig` via `loadConfigByScope()`, sets `config.codemieAssistants = assistants`, and writes it back. This is correct — saves land in the right place.

### Read Path (broken)

`setupAssistants()` calls `ConfigLoader.load()` → receives `codemieAssistants: undefined` → `registeredAssistants = []` → passes empty config to `createDataFetcher()` → `fetchRegisteredFromConfig()` returns `[]` → Registered tab appears empty.

### Affected Files

| File | Role | Change needed |
|---|---|---|
| `src/utils/config.ts:228` | `loadGlobalConfigProfile` return | Add `codemieAssistants: rawConfig.codemieAssistants` |
| `src/utils/config.ts:255` | `loadLocalConfigProfile` return | Add `codemieAssistants: rawConfig.codemieAssistants` |
| `src/cli/commands/assistants/setup/data.ts:106` | `fetchRegisteredFromConfig` | No change needed |
| `src/cli/commands/assistants/setup/index.ts:69` | `setupAssistants` | No change needed |

### Secondary: codemieSkills

`MultiProviderConfig.codemieSkills` (line 172, `src/env/types.ts`) has the same structural gap — also a top-level field not returned by either load helper. Fix both fields together.

### Type Safety

`ProviderProfile.codemieAssistants` already exists with comment "In-memory assistants/skills state (not persisted here; stored at MultiProviderConfig level)" (`src/env/types.ts:123–124`). No type changes required.

### Testing Landscape

- No existing test exercises `ConfigLoader.load()` → `codemieAssistants` propagation end-to-end.
- Data-layer tests mock config directly (bypassing `ConfigLoader.load()`), so the bug was invisible to them.
- A round-trip test (`saveAssistantsToProjectConfig` → `ConfigLoader.load()` → assert field present) in `config-project-override.test.ts` would prevent recurrence.

## Risk Indicators

1. `codemieSkills` has the identical gap — fix both together
2. `loadLocalConfigProfile`: `rawConfig.codemieAssistants` may be `undefined` when local config doesn't define it; `removeUndefined()` in `ConfigLoader.load()` safely strips it before `Object.assign`
3. No regression test guards this path — easy to re-break
4. Once fixed, the selection UI will correctly default to the Registered panel (not Project) when assistants exist — behavioral change reviewers should note
