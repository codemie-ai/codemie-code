# Technical Research

**Task**: ConfigLoader profile composition project-context url
**Generated**: 2026-06-29T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Fix the cross-env profile leak in `ConfigLoader` (src/utils/config.ts).

Background:
When the user runs `codemie ... --profile <global-name>` from a repository that has a local
`.codemie/codemie-cli.config.json` declaring a different `activeProfile` with a different
`codeMieUrl`, the loader currently preserves `codeMieProject`, `codeMieIntegration`, and
`codeMieUrl` from the LOCAL team profile (via `filterProjectFields(localConfig)` and
`PROJECT_FIELDS`). The intent of PROJECT_FIELDS (added in commit c35b54a84) is to support
the "personal provider on top of team's project context" composition, which only works
when both profiles share the same `codeMieUrl`. When URLs differ (cross-env switch, e.g.
--profile preview while team is on prod), preserving any of the three fields yields wrong
records — codeMieUrl loudly (oauth2-proxy HTML breaks JSON.parse in the managed-MCP catalog
fetch, EPMCDME-13167), codeMieProject and codeMieIntegration silently (wrong DB rows).

Required fix:
Gate `filterProjectFields` on URL equality. When the local team profile's `codeMieUrl`
matches the selected global profile's `codeMieUrl`, preserve the project context as today.
When they differ, drop the project-context bundle entirely so the selected global profile
supplies everything. Normalize URLs (trailing slash, case) before comparing.

Constraint: do NOT remove PROJECT_FIELDS entirely. The same-env composition use case is
legitimate and must keep working unchanged.

Touch points already identified by manual inspection:
- src/utils/config.ts: `PROJECT_FIELDS` definition (line ~353), `filterProjectFields`
  (line ~363), `ConfigLoader.load` (lines 68-171), and a parallel block at line ~1161
  that may also need the same gate.
- Tests: any existing tests for cross-profile composition in tests/unit/utils/ or
  similar.

---

## 2. Codebase Findings

### Existing Implementations

**Primary file: `src/utils/config.ts`**

- **Line 353-357** — `PROJECT_FIELDS` constant:
  ```typescript
  private static readonly PROJECT_FIELDS: (keyof CodeMieConfigOptions)[] = [
    'codeMieProject',
    'codeMieIntegration',
    'codeMieUrl'
  ];
  ```
  No URL equality guard. All three fields are unconditionally preserved when `applyProjectOnly` is true.

- **Lines 363-373** — `filterProjectFields(config)`:
  Iterates `PROJECT_FIELDS` and copies any defined field from `config` into a new object. No parameters for comparison context. Returns up to all three fields regardless of URL match.

- **Lines 68-171** — `ConfigLoader.load()` — first call site (primary path):
  Priority stack (low to high): defaults → globalConfig (line 91-92) → localConfig filtered (lines 95-106) → env vars with profile protection (lines 109-163) → CLI overrides (lines 166-168).
  - Line 82: `selectedProfileName = await this.resolveProfileName(workingDir, cliOverrides?.name)`
  - Line 88: `localProfileName = await this.resolveLocalProfileName(workingDir, selectedProfileName)`
  - Line 91: `globalConfig = await this.loadGlobalConfigProfile(selectedProfileName)` — **global config is available here**
  - Line 92: `Object.assign(config, removeUndefined(globalConfig))` — global URL written to config
  - Line 95: `localConfig = await this.loadLocalConfigProfile(workingDir, localProfileName)`
  - Lines 100-101: `applyProjectOnly = cliOverrides?.name && localProfileName && cliOverrides.name !== localProfileName`
  - Lines 102-104: `effectiveLocalConfig = applyProjectOnly ? this.filterProjectFields(localConfig) : localConfig` — **`globalConfig` is in scope but not passed to `filterProjectFields`**
  - Line 106: `Object.assign(config, removeUndefined(effectiveLocalConfig))` — overwrites previously set globalConfig.codeMieUrl with the local team's codeMieUrl

- **Lines 120-157** — "Profile protection" env-vars block:
  When `cliOverrides.name` is set, strips `codeMieUrl`, `baseUrl`, `apiKey`, `model`, `provider`, `authMethod`, `codeMieIntegration` from env before applying. This is the existing mechanism that prevents `CODEMIE_URL` in the shell environment from overriding the selected profile. An analogous guard is needed for the local-config path but operates differently: instead of dropping env vars, it should drop the local config's codeMieUrl when URLs disagree.

- **Lines 1139-1210** — `ConfigLoader.loadWithSources()` — second call site:
  - Line 1154: `selectedProfileName` resolved
  - Line 1155: `localProfileName` resolved
  - Lines 1157-1162: `applyProjectOnly` computed, local config loaded, `filterProjectFields` applied — **global config has NOT been loaded yet**
  - Line 1173 (inside `configs` array literal): `await this.loadGlobalConfigProfile(selectedProfileName)` — global config loaded after the filter decision is already made
  - This ordering issue means the fix in `loadWithSources` must hoist global config loading to before line 1157, or pass the global URL via a separate await before the filter call.

**URL normalization helper: `src/providers/core/codemie-auth-helpers.ts`**

- **Lines 22-28** — `ensureApiBase(rawUrl: string): string`:
  ```typescript
  let base = rawUrl.replace(/\/$/, '');
  if (!/\/code-assistant-api(\/|$)/i.test(base)) {
    base = `${base}/code-assistant-api`;
  }
  return base;
  ```
  Strips trailing slash AND appends `/code-assistant-api` path. This is an API-base builder, not a bare URL normalizer. Using it for equality comparison would require both URLs to already have the `/code-assistant-api` suffix, which `codeMieUrl` stored in profiles does not have. Importing this into `config.ts` also creates a cross-layer dependency (utils -> providers). The fix should use inline normalization: `url.replace(/\/+$/, '').toLowerCase()`.

**Commit c35b54a84 (Jun 16 2026)** — the introducing commit:
Added `resolveLocalProfileName()`, `PROJECT_FIELDS`, `filterProjectFields()`, and the `applyProjectOnly` branch in both `load()` and `loadWithSources()`. Also added a Use Case 4 section to `.codemie/guides/usage/project-config.md` (a file path that no longer exists on disk — the live guides are in `.ai-run/guides/`).

### Architecture and Layers Affected

- **Config / Utilities layer** (`src/utils/config.ts`): primary change site — `filterProjectFields`, both call sites, URL normalization inline
- **Provider / SSO layer** (`src/providers/plugins/sso/sso.auth.ts`): consumer of `codeMieUrl` as credential storage key — affected by fix (correct key restored after fix)
- **CLI / Proxy layer** (`src/cli/commands/proxy/index.ts`, `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`): consumers of `config.codeMieUrl` for MCP catalog fetch and daemon startup
- **Agent layer** (`src/agents/core/AgentCLI.ts`): derives `config.baseUrl` from `config.codeMieUrl` — most dangerous silent failure path
- **Documentation** (`.ai-run/guides/usage/project-config.md`): needs one-paragraph addition describing the URL-gate constraint

### Integration Points

**Internal module dependencies (codeMieUrl consumers):**

| File | How codeMieUrl is used | Failure mode if wrong |
|---|---|---|
| `src/agents/core/AgentCLI.ts:205` | `config.baseUrl = ensureApiBase(config.codeMieUrl)` — rewrites all agent API routing | Silent: all agent calls route to wrong env |
| `src/cli/commands/proxy/index.ts:179,344` | `syncCodeMieUrl: config.codeMieUrl` passed to `spawnDaemon` | Silent: daemon registered with wrong URL |
| `src/cli/commands/proxy/index.ts:302` | `if (!config.codeMieUrl) throw ConfigurationError` — non-empty wrong URL passes this guard | Guard bypassed; wrong URL propagates |
| `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:63` | `sso.getStoredCredentials(codeMieUrl)` — lookup key for SSO creds | Silent null return → MCP catalog not fetched; EPMCDME-13167 failure |
| `src/providers/plugins/sso/sso.auth.ts:78,127` | Stored as credential storage key; `storeSSOCredentials(creds, this.codeMieUrl)` | Credentials stored under wrong key; auth fails on next call |
| `src/providers/plugins/sso/sso.health.ts:62` | `getStoredCredentials(config.codeMieUrl)` for health check | Silent null → health check skips auth verification |
| `src/providers/plugins/sso/sso.models.ts:82,113` | SSO integration lookup and `fetchIntegrations(codeMieUrl)` | Wrong DB rows returned for project integrations |
| `src/cli/commands/skills/lib/skills-search-client.ts:114,132` | SSO lookup key for skills search | Auth failure or wrong-env skills returned |
| `src/cli/commands/skills/lib/skills-metrics.ts:359` | SSO lookup key for analytics sync | Analytics silently lost or sent to wrong env |
| `src/cli/commands/skills/lib/require-auth.ts:27` | SSO lookup key for auth check | Auth check skipped or fails against wrong env |
| `src/utils/sdk-client.ts:49` | `credentialLookupUrl = config.codeMieUrl \|\| config.baseUrl` | Wrong env credentials used for SDK calls |
| `src/agents/plugins/claude/statusline-installer.ts` | Credential lookup key | Statusline not installed, no error shown |

**External dependencies:**
- No external service client changes needed — the fix is entirely within `ConfigLoader`

### Patterns and Conventions

- **Priority stack pattern**: `ConfigLoader.load` uses a sequential `Object.assign` cascade (defaults → global → local → env → CLI). The URL gate must be inserted at the local-config merge step (lines 102-104).
- **`applyProjectOnly` gate pattern**: already established at the same lines. The URL gate is an additional condition layered on top.
- **Inline URL normalization**: project convention in `config.ts` uses `replace()` directly (e.g. at line 23 of `codemie-auth-helpers.ts`). No dedicated utility function exists in `src/utils/` for base URL normalization — a one-liner `url.replace(/\/+$/, '').toLowerCase()` is consistent with the codebase style.
- **Parallel `load`/`loadWithSources` maintenance**: both methods duplicate the profile-resolution logic. Any change to one must be mirrored in the other.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- **`.ai-run/guides/usage/project-config.md`** (primary): covers ConfigLoader, config priority, profile resolution, and common patterns. Contains "Team profile with personal provider" (lines 131-139) — the condensed echo of the original Use Case 4 from commit c35b54a84. This is the file that needs a one-paragraph update.
- **`.ai-run/guides/architecture/architecture.md`**: covers the 5-layer architecture. ConfigLoader sits in the Utilities layer and is referenced generically; no profile-composition details.
- **`.ai-run/guides/development/development-practices.md`**: covers error handling and async patterns. No config-specific content relevant to this fix.
- **`.codemie/guides/` directory**: does not exist on disk. Commit c35b54a84 added Use Case 4 to `.codemie/guides/usage/project-config.md`, but that path was never migrated into `.ai-run/guides/`. The richer documentation from the original commit was lost.

### Architectural Decisions

- **Commit c35b54a84 (Jun 16 2026)**: introduced `PROJECT_FIELDS` = `['codeMieProject', 'codeMieIntegration', 'codeMieUrl']` and the `filterProjectFields`/`applyProjectOnly` mechanism. Intent: "personal provider on top of team project context" composition. The decision to include `codeMieUrl` in `PROJECT_FIELDS` implicitly assumed same-env usage; the URL-gate constraint was not implemented at that time.
- **"Profile protection" env block (lines 120-157)**: an earlier decision establishing the principle that `--profile` should insulate the selected profile's credentials from ambient env vars. The URL-gate fix extends this principle to local-config merging.

### Derived Conventions

- `codeMieUrl` is the primary SSO credential storage key across the entire codebase — every consumer uses it as a lookup key into the credential store. A wrong `codeMieUrl` silently routes all auth operations to the wrong environment.
- The `codeMieUrl` vs `baseUrl` distinction: `codeMieUrl` is the human-facing CodeMie instance URL (e.g. `https://company.codemie.ai`); `baseUrl` is the provider's AI API endpoint. They are different fields serving different consumers.
- Both `load()` and `loadWithSources()` must be kept in sync — they duplicate the priority logic intentionally (the latter adds source tracking). Changes to the merge logic in `load()` must always be reflected in `loadWithSources()`.

---

## 4. Testing Landscape

### Existing Coverage

**File: `src/utils/__tests__/config-project-override.test.ts`** — 390 lines, Vitest

Covered scenarios:
- `initProjectConfig` — creates local config file, applies `codeMieProject`/`codeMieIntegration`/`profileName` overrides
- `hasLocalConfig` / `hasProjectConfig` — true/false detection
- `loadWithSources` — returns `ConfigWithSources` structure, tracks source labels, detects local config existence, tracks project-level overrides, prioritizes CLI over project
- Priority system — CLI > env > project > global > default (using model field as the test axis)
- Field override behavior — `codeMieProject` from project overrides global, `codeMieIntegration` from project overrides global, partial overrides (only some fields set locally)

**Note**: all tests assume the SAME profile name is active in both global and local config. No test exercises the `applyProjectOnly` branch (`cliOverrides.name !== localProfileName`).

### Testing Framework and Patterns

- Framework: **Vitest** (`describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi`)
- Pattern: creates real temp directories under `process.cwd()/tmp-test-config/`, writes real JSON config files, calls `ConfigLoader` methods directly
- Mocking: `vi.spyOn(paths, 'getCodemieHome')` and `vi.spyOn(paths, 'getCodemiePath')` redirect global config reads to the temp dir
- Cleanup: `fs.rm(TEST_DIR, { recursive: true, force: true })` and `vi.restoreAllMocks()` in `afterEach`
- Env pollution prevention: manually `delete process.env.CODEMIE_*` in `beforeEach`

### Coverage Gaps

The following scenarios have no test coverage and will be needed for this fix:

1. **Cross-env URL mismatch with `--profile`**: global profile has `codeMieUrl: 'https://preview.codemie.ai'`, local team profile has `codeMieUrl: 'https://prod.codemie.ai'`, user runs with `cliOverrides.name = 'preview-profile'`. Expected: `codeMieProject`, `codeMieIntegration`, and `codeMieUrl` are all absent from the final merged config (supplied entirely by the global profile).

2. **Same-env URL match with `--profile`**: global profile and local team profile both have `codeMieUrl: 'https://prod.codemie.ai'` (possibly with trailing slash variant). Expected: `codeMieProject` and `codeMieIntegration` from local profile ARE preserved (same-env composition still works).

3. **URL present in global but absent in local**: global profile has `codeMieUrl`, local profile has none (typical when local config only sets `codeMieProject`). Expected: global's `codeMieUrl` wins; local's `codeMieProject` is preserved (URL gate should treat missing local URL as "not conflicting").

4. **`filterProjectFields` unit test**: directly tests the function with/without URL parameter to verify correct field inclusion/exclusion.

5. **`loadWithSources` with `applyProjectOnly`**: verifies that the `sources` record for `codeMieUrl` shows `'global'` (not `'project'`) when URLs differ.

---

## 5. Configuration and Environment

### Environment Variables

Relevant env vars in `ConfigLoader.loadFromEnv()`:

| Env Var | Config Field | Profile-protection behavior |
|---|---|---|
| `CODEMIE_URL` | `codeMieUrl` | Stripped from env when `--profile` explicit (line 142-144) |
| `CODEMIE_PROJECT` | `codeMieProject` | No stripping |
| `CODEMIE_INTEGRATION_ID` | `codeMieIntegration` | Stripped when `--profile` explicit (line 150-153) |
| `CODEMIE_PROVIDER` | `provider` | Stripped when `--profile` explicit |
| `CODEMIE_BASE_URL` | `baseUrl` | Stripped when `--profile` explicit |
| `CODEMIE_API_KEY` | `apiKey` | Stripped when `--profile` explicit |
| `CODEMIE_MODEL` | `model` | Stripped when `--profile` explicit |

### Configuration Files

- **`~/.codemie/codemie-cli.config.json`** (global): `MultiProviderConfig` schema `version: 2`, `activeProfile`, `profiles` map. Read by `ConfigLoader.loadGlobalConfigProfile()`.
- **`.codemie/codemie-cli.config.json`** (local, per-repo): same schema. Read by `ConfigLoader.loadLocalConfigProfile()`. This file's `activeProfile` determines `localProfileName` via `resolveLocalProfileName()`.
- **`.codemie/credentials.json`**: SSO credential store keyed by normalized `codeMieUrl`. Not read by `ConfigLoader` directly — read by `sso.auth.ts` using the `codeMieUrl` that `ConfigLoader` emits.

### Feature Flags and Deployment Concerns

- No feature flags involved.
- No deployment manifest changes needed.
- The fix is purely a runtime merge-logic change in `ConfigLoader` — no schema changes, no migration needed.
- The `codeMieUrl` stored in `.codemie/credentials.json` is not affected by this fix; credentials remain associated with their original URLs.

---

## 6. Risk Indicators

- **Both call sites must be patched**: `ConfigLoader.load()` line 103 AND `ConfigLoader.loadWithSources()` line 1161 contain identical `filterProjectFields` calls. Missing either leaves a residual leak path. The `loadWithSources` fix requires hoisting `loadGlobalConfigProfile` from inside the `configs` array (line 1173) to before the `applyProjectOnly` block (before line 1157) — a refactoring risk if not done carefully.

- **`loadWithSources` ordering dependency**: in the current code, `loadGlobalConfigProfile` is called lazily as part of the `configs` array initializer (line 1173). The URL-gate fix requires it to be called eagerly BEFORE computing `effectiveLocalConfig`. This changes evaluation order; the async operation is independent and safe, but the hoisting must be explicit.

- **No existing test for `applyProjectOnly` branch**: `src/utils/__tests__/config-project-override.test.ts` never sets `cliOverrides.name` to a value that differs from `localProfileName`. The bug lived undetected because no test covered the cross-profile activation path.

- **`AgentCLI.ts` line 205 — most impactful silent failure**: `config.baseUrl = ensureApiBase(config.codeMieUrl)` rewrites the AI API routing URL from the leaked `codeMieUrl`. All agent API calls (completions, tool calls, streaming) silently route to the wrong environment. This is worse than the MCP catalog failure (EPMCDME-13167) because it affects every agent interaction, not just the catalog fetch.

- **SSO credential key corruption is not self-healing**: if a user has run with the leaked URL and had credentials stored under the wrong key, they need to re-authenticate after the fix. The fix corrects future loads but does not repair existing credential store entries.

- **URL normalization must not use `ensureApiBase`**: that function appends `/code-assistant-api` and is not appropriate for equality comparison of base URLs. Using it would require both sides to be API-base URLs, which they are not. The comparison must use a simple `url.replace(/\/+$/, '').toLowerCase()` normalization or similar. Importing `ensureApiBase` from `src/providers/core/` into `src/utils/config.ts` would also introduce a cross-layer dependency (utils importing providers).

- **`codeMieUrl` absent in local profile is not a URL mismatch**: if the local team profile does not set `codeMieUrl` (common for configs that only set `codeMieProject`), the URL gate must treat a missing/undefined local URL as compatible (not a conflict). Failing to handle this case would break the majority of existing team configurations that rely on the global profile's `codeMieUrl`.

- **`codeMieUrl` absent in global profile edge case**: if the selected global profile has no `codeMieUrl` (e.g. a pure-Bedrock profile), the URL gate behavior needs to be defined. The task requires the global profile to supply everything when URLs differ; if neither profile has a URL, the local project fields (`codeMieProject`, `codeMieIntegration`) are still valid to preserve. The safest behavior: only trigger the URL gate when both sides have non-empty URLs and they differ.

- **Guide documentation gap**: the `.ai-run/guides/usage/project-config.md` file does not mention `codeMieUrl` at all (despite it being a `PROJECT_FIELD`), and does not document the URL-gate constraint. The "Team profile with personal provider" pattern section (line 131) needs a note that the composition requires both profiles to share the same CodeMie URL.

- **No codegraph results**: codegraph MCP tools were described in the environment but returned tool-not-found errors. All research was conducted via filesystem tools. If the codegraph index becomes available, a caller/callee graph for `filterProjectFields` would verify no additional call sites exist beyond lines 103 and 1161.

---

## 7. Summary for Complexity Assessment

The fix touches a single file (`src/utils/config.ts`) at two symmetrical call sites (lines 103 and 1161), plus a one-paragraph documentation update in `.ai-run/guides/usage/project-config.md`. The code change surface is small — approximately 15-20 new lines across both call sites — but the `loadWithSources` site has an ordering dependency that requires hoisting one async call, making it more than a one-liner insertion. The fix introduces a private URL-normalization expression (trailing slash strip + lowercase) inline rather than importing an existing helper, to avoid a cross-layer dependency. All three `PROJECT_FIELDS` are dropped as a bundle when URLs differ, which matches the task requirement.

The affected area follows an established pattern (`applyProjectOnly` is already present and tested by the existing priority-system tests), but the critical `filterProjectFields` branch itself has zero test coverage. Two new test scenarios are essential: cross-env URL mismatch (all three PROJECT_FIELDS dropped) and same-env URL match (PROJECT_FIELDS preserved as today). A third edge case — missing local `codeMieUrl` — must also be handled to avoid breaking the majority of team configurations that only set `codeMieProject` in their local profile without a `codeMieUrl`.

The blast radius of the bug, while fixed in one file, propagates through 15+ downstream consumers across the SSO, proxy, agent, and skills layers — all using `codeMieUrl` as a credential-store lookup key. The most dangerous silent failure is `AgentCLI.ts` line 205 rewriting `config.baseUrl` to the wrong environment's API endpoint. The fix unblocks EPMCDME-13167 (managed-MCP catalog `JSON.parse` failure) as the reported loud symptom, but also silently fixes wrong DB row lookups, wrong credential key associations, and wrong agent API routing. Risk is low given the change is isolated to `ConfigLoader`, but the missing test coverage for the `applyProjectOnly` branch is the main confidence gap and must be addressed as part of this fix.
