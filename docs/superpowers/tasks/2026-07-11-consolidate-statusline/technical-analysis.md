# Technical Research

**Task**: statusline, claude plugin, budget tracking, CLI install command
**Generated**: 2026-07-11
**Research path**: codegraph

---

## 1. Original Context

Consolidate the two divergent Claude Code statusline implementations in this repo into one.

Background / root cause already investigated by the requester:
- `src/agents/core/AgentCLI.ts` registers a `--status` flag that sets `CODEMIE_STATUS=1`.
- `src/agents/plugins/claude/claude.plugin.ts` (prepareEnvironment hook, lines ~206-234) reacts to that flag by reading `plugin/codemie-statusline.mjs` from the compiled plugin dir and installing it as `~/.claude/codemie-statusline.mjs`, wired into `~/.claude/settings.json` statusLine.
- That file (`codemie-statusline.mjs`) was DELETED in PR #301 (`a7583ba6cf`, "add the statusline with budget tracking") and replaced by a new `src/agents/plugins/claude/plugin/statusline.mjs` + new module `src/agents/plugins/claude/statusline-installer.ts` (installed via `codemie install` / `installStatusline()` in `src/cli/commands/install.ts`, writes `~/.claude/codemie-budget-status.js`).
- Nobody updated the old `--status` flag code path, so it now throws `ENOENT: ... plugin/codemie-statusline.mjs` on every use — it has been fully broken since PR #301, so there is no current working behavior to preserve for it specifically.
- There are now two parallel, inconsistent statusline mechanisms in the codebase (the broken `--status` flag path in claude.plugin.ts, and the working `codemie install`/statusline-installer.ts path). They must be consolidated into ONE.

Old statusline (`codemie-statusline.mjs`, deleted, self-contained, no network/config dependency) showed, on 2 lines:
- `[Model] 📁 dir | 🌿 branch`
- a colored context-window-% progress bar, `$cost` (session cost from Claude Code's own stdin JSON `cost.total_cost_usd`), and session duration (`cost.total_duration_ms`).

Current `statusline.mjs` (224 lines) shows a single line: `[project] | budget $spend/$limit (pct%) | (branch) | [model] | ctx:% in:tok out:tok`. It requires a CodeMie profile to be configured with `codeMieUrl`/`baseUrl` and a `statuslineBudgetName` selected via `codemie install statusline` (interactive prompt in `promptBudgetSelection()` in statusline-installer.ts), fetches from `/v1/analytics/budget_usage`, and shows warnings like `⚠ run: codemie install statusline` / `⚠ Reauthenticate` if unconfigured. It has NO session cost or duration display at all currently.

Product requirements for the consolidated statusline (confirmed via direct user clarification, do not re-derive):
1. Single, consolidated statusline implementation — remove/retire the dead `--status` flag code path in claude.plugin.ts (and its now-redundant `codemie-statusline.mjs` reference) once behavior is folded into the one real implementation.
2. If a CodeMie profile is present/configured: show the CodeMie budget part, resolved automatically from the project tied to the active profile (NOT via a manually-selected budget name from a list — auto-derive "the project budget for the selected profile"; existing config from `codemie install statusline`, if present, may still be honored/migrated, but the manual selection step should no longer be a hard prerequisite).
3. The CodeMie budget part should show exactly 3 fields: current_spend, percentage_used, and budget_reset_at from the `/v1/analytics/budget_usage` row matching the profile's project. Explicitly do NOT show the soft `budget_limit` or `hard_budget_limit` fields.
4. Regardless of whether a CodeMie profile/budget is available, ALWAYS show the "basic information the old solution showed": model name, working directory/project, git branch, context-window-%, and — critically — session cost (`cost.total_cost_usd` from Claude Code's stdin JSON) and session duration. Session cost display is a hard requirement, not optional, and must work even with zero CodeMie backend connectivity.
5. If no CodeMie profile is present, the statusline should gracefully show just the basic info (item 4) without CodeMie budget warnings cluttering it (avoid the current noisy `⚠ no config` / `⚠ no profile` etc. messages replacing useful info — basic info should still render).

---

## 2. Codebase Findings

### Existing Implementations

**Two independent, non-interoperating statusline mechanisms exist today:**

**A. Dead mechanism — `--status` / `CODEMIE_STATUS` flag path**
- `src/agents/core/AgentCLI.ts:70` — `.option('--status', 'Enable status bar (shows model, context usage, git branch, and cost)')` registered on the base Commander program shared by **all** agent CLIs (Claude, Gemini, Codex, Kimi, Opencode), not Claude-specific.
- `src/agents/core/AgentCLI.ts:302-305` — in `handleRun()`: `if (options.status) { providerEnv.CODEMIE_STATUS = '1'; }` — the only place `CODEMIE_STATUS` is set. Forwarded via `providerEnv` into `adapter.run(agentArgs, providerEnv)`.
- `src/agents/core/BaseAgentAdapter.ts:559-561` — `run()` calls `executeBeforeRun(this, this.metadata.lifecycle, ...)`, dispatching to the plugin's `lifecycle.beforeRun` hook. (Note: there is no literal `prepareEnvironment` function — the hook is `ClaudePluginMetadata.lifecycle.beforeRun`/`afterRun`; functionally equivalent to what the ticket calls "prepareEnvironment hook".)
- `src/agents/plugins/claude/claude.plugin.ts:27-29` — module-level flag `let statuslineManagedThisSession = false;` (intentionally not an env var, to avoid leaking into the child process env).
- `src/agents/plugins/claude/claude.plugin.ts:203-267` — `beforeRun(env)` hook. Dead block at lines 206-265:
  ```
  if (env.CODEMIE_STATUS === '1') {
    ... dynamic imports of fs/promises, fs, path ...
    const claudeHome = resolveHomeDir('.claude');
    const scriptPath = join(claudeHome, 'codemie-statusline.mjs');
    const settingsPath = join(claudeHome, 'settings.json');
    const scriptContent = await readFile(
      join(getDirname(import.meta.url), 'plugin/codemie-statusline.mjs'),  // FILE DOES NOT EXIST — deleted in PR #301
      'utf-8'
    );
    ...
    await writeFile(scriptPath, scriptContent, 'utf-8');
    if (process.platform !== 'win32') await chmod(scriptPath, 0o755);
    // injects settings.json.statusLine = { type: 'command', command: `node "${scriptPath}"` } if not already present
    // sets statuslineManagedThisSession = true
  }
  ```
- `src/agents/plugins/claude/claude.plugin.ts:270-301` — `afterRun(_exitCode, _env)`: if `statuslineManagedThisSession`, deletes `settings.statusLine` from `~/.claude/settings.json` and resets the flag. Entirely coupled to the dead path; references nothing from `statusline-installer.ts`.
- Deployed artifact filename: `~/.claude/codemie-statusline.mjs`.

**B. Working mechanism — `codemie install statusline` path**
- `src/agents/plugins/claude/statusline-installer.ts` (151 lines) — exported symbols:
  - `STATUSLINE_NAME = 'statusline'`, `STATUSLINE_DISPLAY_NAME = 'CodeMie Statusline'`, `STATUSLINE_DESCRIPTION` (lines 11-13)
  - `SCRIPT_FILENAME = 'codemie-budget-status.js'` (line 15, module-private) — a **different filename** from the dead path's `codemie-statusline.mjs`, so the two mechanisms don't collide on the same installed file (but this also means uninstalling one never cleans the other — see Risks).
  - `installStatusline(): Promise<string>` (18-60) — reads `plugin/statusline.mjs` relative to `getDirname(import.meta.url)`, writes it to `~/.claude/codemie-budget-status.js`, chmods 755 (non-win32), merges `statusLine` into `~/.claude/settings.json` (aborts via `ConfigurationError` on parse failure), sets `refreshInterval: 60`. Returns installed script path.
  - `uninstallStatusline(): Promise<void>` (62-89) — removes the script file if present; deletes `statusLine` key from settings.json if present (aborts w/ `ConfigurationError` on parse failure).
  - `isStatuslineInstalled(): boolean` (91-93) — `existsSync(join(homedir(), '.claude', SCRIPT_FILENAME))`.
  - `promptBudgetSelection(): Promise<boolean>` (95-151) — loads `ConfigLoader.loadMultiProviderConfig()` → `profile = config.profiles[config.activeProfile]`; bails (`false`) if `!profile.codeMieUrl || !profile.baseUrl`; retrieves SSO/JWT creds via `CredentialStore.getInstance()`; fetches `${profile.baseUrl}/v1/analytics/budget_usage`; dynamically imports `inquirer`, prompts a `list` selection of `rows.map(r => r.project_name)` defaulting to `profile.statuslineBudgetName ?? budgetNames[0]`; persists choice to `profile.statuslineBudgetName` via `ConfigLoader.saveProfile()`; busts `~/.codemie/budget-cache.json` if selection changed.
- `src/agents/plugins/claude/plugin/statusline.mjs` (224 lines, standalone — no project imports, runs via `node` outside the project's module resolution):
  - Constants: `HOME` (`CODEMIE_HOME` env or `~/.codemie`), `CACHE_FILE = budget-cache.json`, `CONFIG_FILE = codemie-cli.config.json`, `CREDS_DIR = credentials/`, `CACHE_TTL_MS = 60_000`.
  - `decrypt()` / `ENCRYPTION_KEY` — a **duplicated, hand-rolled AES decryption implementation** mirroring `CredentialStore`'s own logic (not shared code — drift risk, but unavoidable since this file must remain standalone once deployed to `~/.claude/`).
  - `getAuthHeaders(codeMieUrl)` — reads `sso-<hash>.enc` / `jwt-sso-<hash>.enc` directly from `~/.codemie/credentials/`.
  - `fetchBudget(baseUrl, headers, budgetName)` (66-81) — calls `GET ${baseUrl}/v1/analytics/budget_usage`; finds `row` via `json.data.rows.find(r => r.project_name === budgetName)`; computes `pct = round(row.current_spending / row.budget_limit * 100)`. **Field names actually used: `current_spending` and `budget_limit`** — differ from the target requirement's `current_spend`/`percentage_used`/`budget_reset_at` (see Risks — schema needs confirmation).
  - `buildStatusLine({ projectName, branch, model, ctxPct, tokIn, tokOut, budget, budgetPct })` (107-122) — assembles `[project] | budget | (branch) | [model] | ctx:%/in:/out:`. **No cost or duration fields anywhere in this file.**
  - `main()` (144-224) — reads stdin JSON once via `readStdin()`; extracts `cwd` (`ctx.workspace.current_dir ?? ctx.cwd`), `projectName = path.basename(cwd)`, `model = ctx.model.display_name`, `ctxPct = ctx.context_window.used_percentage`, `tokIn/tokOut`. **Never reads `ctx.cost` or any duration field** — confirms the gap for requirement #4.
  - Budget resolution flow (177-214): reads `CONFIG_FILE` → `profile = config.profiles[config.activeProfile]` → requires `codeMieUrl`, `baseUrl`, **and `statuslineBudgetName`** as a hard prerequisite (shows `⚠ run: codemie install statusline` if unset — contradicts target requirement #2) → `getAuthHeaders()` (shows `⚠ Reauthenticate` if none) → `fetchBudget()` (shows `⚠ <error>` on failure) → writes to cache. This all happens synchronously in the render path; even with no CodeMie profile at all, the script still attempts `JSON.parse(await fs.readFile(CONFIG_FILE...))`, which throws into the catch and renders `⚠ no config` rather than cleanly omitting the budget segment (gap vs. requirement #5).
- `src/cli/commands/install.ts` (329 lines) — imports `STATUSLINE_NAME/DISPLAY_NAME/DESCRIPTION, installStatusline, isStatuslineInstalled, promptBudgetSelection`. Lists statusline under "✨ Add-ons" (lines 80-86). Dedicated branch (lines 266-298): `if (name === STATUSLINE_NAME) { installStatusline(); promptBudgetSelection(); }` — today's only entry point that sets `statuslineBudgetName`.
- `src/cli/commands/uninstall.ts` (177 lines) — imports `STATUSLINE_NAME, STATUSLINE_DISPLAY_NAME, uninstallStatusline, isStatuslineInstalled`. Branch (lines 127-142): checks `isStatuslineInstalled()`, calls `uninstallStatusline()`. **Does not** know about the dead `--status`/`codemie-statusline.mjs` path — different filenames mean uninstalling one never cleans the other.

**Config/env plumbing available for reuse:**
- `src/agents/core/AgentCLI.ts:314` — `CODEMIE_PROFILE_CONFIG = JSON.stringify(config)` is already set alongside `CODEMIE_STATUS` and is already consumed inside `claude.plugin.ts`'s `beforeRun` for another feature (`claudeAutocompactPct`, lines 188-200). This is an existing, proven pattern for passing profile data into the lifecycle hook without re-loading `ConfigLoader` from inside the plugin — worth imitating if any part of the consolidated logic needs to move into the plugin hook rather than remain in the standalone `statusline.mjs`.

### Architecture and Layers Affected

- **CLI layer** — `AgentCLI.ts` (`--status` flag, `CODEMIE_STATUS`/`CODEMIE_PROFILE_CONFIG` env wiring), `install.ts`/`uninstall.ts` (statusline add-on lifecycle commands).
- **Plugin layer** — `claude.plugin.ts` lifecycle hooks (`beforeRun`/`afterRun`), `statusline-installer.ts` (install/uninstall/prompt logic).
- **Deployed artifact layer** — `statusline.mjs`, a standalone Node script that runs outside the project's process, invoked directly by Claude Code via `node <path>` on every statusline refresh (`refreshInterval: 60`).
- **Config/Credential layer** — `ConfigLoader` (`src/utils/config.ts`), `CredentialStore` (`src/utils/security.ts`), and the duplicated crypto logic inside `statusline.mjs` itself.
- **External HTTP layer** — `GET /v1/analytics/budget_usage` on the profile's `baseUrl`.

### Integration Points

- `AgentCLI.ts` → `BaseAgentAdapter.run()` → `executeBeforeRun`/`executeAfterRun` → `ClaudePluginMetadata.lifecycle.beforeRun/afterRun` (shared dispatch mechanism used by all plugin lifecycle behavior, not statusline-specific).
- `install.ts`/`uninstall.ts` → `statusline-installer.ts` exports → filesystem (`~/.claude/settings.json`, `~/.claude/codemie-budget-status.js`) and `ConfigLoader`/`CredentialStore`.
- `statusline.mjs` (once deployed) → invoked directly by Claude Code, reading only stdin JSON + `~/.codemie/*` files; it has **no** import-time dependency on the rest of the `src/` tree since it must survive as a standalone artifact.
- `CODEMIE_STATUS` is set only in `AgentCLI.ts:303-305` and consumed only in `claude.plugin.ts:206` — no other plugin (Gemini, Codex, Kimi, Opencode) references it, so its blast radius is narrow, but the `--status` Commander option itself is defined on the shared base CLI class and appears in `--help` output for all agents.

### Patterns and Conventions

- **Plugin lifecycle hook pattern**: `AgentMetadata.lifecycle.beforeRun(env)` / `afterRun(exitCode, env)`, centrally dispatched by `BaseAgentAdapter.run()`.
- **Env-var-as-feature-flag pattern**: CLI sets `CODEMIE_STATUS='1'` / `CODEMIE_PROFILE_CONFIG=JSON.stringify(config)` on `providerEnv`, consumed inside the plugin's `beforeRun` hook (same pattern already used for `claudeAutocompactPct`).
- **"Install once, deploy standalone artifact" pattern**: both mechanisms copy a script from the compiled `plugin/` directory into `~/.claude/` and wire it into `~/.claude/settings.json.statusLine`; the deployed script must remain fully standalone (no project imports) since Claude Code invokes it directly via `node <path>`.
- **Config/profile resolution pattern**: `ConfigLoader.loadMultiProviderConfig()` → `config.profiles[config.activeProfile]` → check `codeMieUrl`/`baseUrl` presence to decide "is a CodeMie profile configured."
- **Auth pattern**: `CredentialStore.getInstance().retrieveSSOCredentials(url)` / `.retrieveJWTCredentials(url)`; the standalone `statusline.mjs` duplicates this as raw file reads + local AES decrypt since it cannot import `CredentialStore` once deployed outside the project tree.
- **Caching pattern**: `~/.codemie/budget-cache.json` with a 60s TTL to avoid hammering the analytics endpoint on every statusline refresh.
- **Interactive selection pattern**: `inquirer` dynamic `import()` + `list` prompt, invoked only from the CLI install flow (`promptBudgetSelection`), never at render time.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No guides found. `.ai-run/guides/integration/external-integrations.md` and `.ai-run/guides/usage/project-config.md` were checked for "budget"/"statusline"/"statusLine" — zero matches in either file. This consolidation is undocumented territory; no prior architectural guidance exists for either statusline mechanism.

### Architectural Decisions

None recorded in guides or inline comments beyond the ordinary code comments already quoted above (e.g. the `codeMieProject`/`statuslineBudgetName` field comments in `src/env/types.ts`). No ADRs found.

### Derived Conventions

- Standalone deployed scripts (files copied into `~/.claude/`) must avoid any import from the project's own `src/` tree or `node_modules`-resolved packages beyond Node builtins, since they run via `node <path>` after the project process has exited and are not guaranteed to execute from within the installed package's module resolution context.
- Config/credential access from within the project process goes through `ConfigLoader`/`CredentialStore`; standalone deployed scripts must re-implement the minimum subset needed (file reads + local decrypt) since they cannot import those modules.
- Feature flags for plugin lifecycle behavior are threaded through as env vars set by the CLI layer and consumed in the plugin's `beforeRun`/`afterRun` hooks (see `CODEMIE_STATUS`, `CODEMIE_PROFILE_CONFIG`).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude/__tests__/claude.plugin.statusline.test.ts` (320 lines) — covers **only** the dead `--status`/`CODEMIE_STATUS` code path in `claude.plugin.ts`. Mocks `fs/promises` and `fs` entirely (`vi.mock('fs/promises')`, `vi.mock('fs')`), so `readFile` for `plugin/codemie-statusline.mjs` never touches the real filesystem — the mock resolves with dummy content (e.g. `'// content'`). **This means the test suite asserts and expects SUCCESS of the dead path and never exercises the real-world `ENOENT`** that has occurred in production since PR #301 deleted the source file. This is why the regression was never caught by CI.
  - Coverage detail: no-op when `CODEMIE_STATUS` unset; script deployed + settings.json injected when set and no settings.json exists; reads from `plugin/codemie-statusline.mjs` specifically (constant `SCRIPT_SRC` at line 61); quotes the path in the command; does not re-inject if `statusLine` already present; aborts and warns on malformed settings.json (no overwrite); creates `~/.claude` dir if missing; does not leak a managed-flag env var (module-level flag only); `afterRun` removes `statusLine` only if session-managed, is idempotent, warns on cleanup failure, skips cleanup if settings.json absent.
- **No test file exists for `statusline-installer.ts`** — `installStatusline`, `promptBudgetSelection`, `uninstallStatusline`, `isStatuslineInstalled` have zero covering tests (confirmed via codegraph and a direct filesystem search for `*statusline*` test files — only `claude.plugin.statusline.test.ts` exists).
- **No test file exists for `plugin/statusline.mjs`** — it is a plain `.mjs` script with no test harness reference anywhere in `src/` or `tests/`.

### Testing Framework and Patterns

Vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` imported in `claude.plugin.statusline.test.ts`), consistent with `.ai-run/guides/testing/testing-patterns.md` repo-wide conventions (dynamic-import mocking, mock filesystem modules).

### Coverage Gaps

- `statusline-installer.ts` exported functions (`installStatusline`, `promptBudgetSelection`, `uninstallStatusline`, `isStatuslineInstalled`) — completely untested.
- `plugin/statusline.mjs` — completely untested (budget fetch, caching, stdin parsing, rendering, error/warning branches).
- The dead `--status` path's test file (`claude.plugin.statusline.test.ts`) will need to be deleted or substantially rewritten as part of consolidation — its current assertions are all built around behavior that must be retired.
- No test exists anywhere for parsing `cost.total_cost_usd` / duration fields from Claude Code's stdin JSON — this is new functionality with no prior art to extend.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_STATUS` — set to `'1'` by `AgentCLI.ts:303-305` when `--status` is passed; consumed only by `claude.plugin.ts:206` (dead path).
- `CODEMIE_PROFILE_CONFIG` — set by `AgentCLI.ts:314` as `JSON.stringify(config)`; already consumed by `claude.plugin.ts` `beforeRun` for the `claudeAutocompactPct` feature (existing pattern for passing profile data into the hook without re-loading `ConfigLoader`).
- `CODEMIE_HOME` — optional override for the `~/.codemie` home directory, read inside `statusline.mjs`.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (`CONFIG_FILE` in `statusline.mjs`; loaded via `ConfigLoader.loadMultiProviderConfig()` elsewhere) — the `MultiProviderConfig` shape (`src/env/types.ts:172-179`): `{ version: 2, activeProfile: string, profiles: Record<string, ProviderProfile> }`.
- `ProviderProfile.codeMieUrl` / `ProviderProfile.baseUrl` (`src/env/types.ts:54,72`) — presence of both is the universal gate for "is a CodeMie profile configured."
- `ProviderProfile.codeMieProject` (`src/env/types.ts:73`, comment: "Selected project/application name") — **this is the field that represents "the project tied to the active profile"** referenced in target requirement #2. It is distinct from `statuslineBudgetName` and is set during SSO/profile setup, not during statusline install. Consolidation logic should match this against `row.project_name` in the `/v1/analytics/budget_usage` response instead of relying on manual `inquirer` selection.
- `ProviderProfile.statuslineBudgetName` (`src/env/types.ts:139`, comment: "Budget row name selected during statusline install") — persisted by `promptBudgetSelection()`; read as a hard prerequisite today by `statusline.mjs`.
- `~/.codemie/budget-cache.json` — render-time cache (`{ ts, value, pct }`), 60s TTL, busted by `promptBudgetSelection()` on budget-name change.
- `~/.claude/settings.json` (`statusLine` key: `{ type: 'command', command: 'node "<path>"', refreshInterval?: 60 }`) — both mechanisms write/delete this same key but point at different deployed script filenames.
- `~/.codemie/credentials/sso-<hash>.enc` / `jwt-sso-<hash>.enc` — read directly (bypassing `CredentialStore`) by `statusline.mjs`'s own `decrypt()`/`getAuthHeaders()`.

### Feature Flags and Deployment Concerns

- No formal feature-flag system observed; the `--status` Commander flag itself functions as the toggle for the dead path and is defined on the shared base CLI class used by all agent plugins (Claude, Gemini, Codex, Kimi, Opencode) — removing it affects `--help` output repo-wide, not just Claude.
- Deployment concern: two different deployed artifact filenames (`codemie-statusline.mjs` legacy vs `codemie-budget-status.js` current) mean a machine that used both mechanisms historically could have orphaned files/settings after only one is retired — cleanup logic must account for the legacy filename too.

---

## 6. Risk Indicators

- **Field-name mismatch between requirements and actual API usage in code**: target requirement #3 calls for `current_spend`, `percentage_used`, `budget_reset_at`, but the only code consuming `/v1/analytics/budget_usage` today (`statusline.mjs:73-78`) uses `row.current_spending` and `row.budget_limit`. Neither `percentage_used`, `budget_reset_at`, nor `hard_budget_limit` appear anywhere in the repo. The real response schema for these three required fields cannot be verified from this repo alone — must be confirmed against the live CodeMie backend/API contract before implementation.
- **Tests currently mask the production bug**: `claude.plugin.statusline.test.ts` mocks `fs`/`fs/promises` entirely, asserting the dead `--status` path succeeds and never exercising the real `ENOENT` that has occurred in production since PR #301. Deleting the dead source code without deleting/rewriting this test file will break CI.
- **Zero regression safety net for the live path**: no tests exist for `statusline-installer.ts` or `statusline.mjs` at all — any consolidation changes to these have no existing coverage to catch regressions.
- **Backward compatibility for existing `codemie install statusline` users**: profiles that already have `statuslineBudgetName` set need an explicit decision — continue honoring it as an override, ignore it, or actively migrate/clear it once auto-resolution via `codeMieProject` is introduced.
- **Orphaned artifacts risk**: two different deployed filenames and two different `settings.json` write sites mean a user who used both mechanisms historically could be left with stale files/settings after only one is retired; `uninstall.ts`/`uninstallStatusline()` currently only knows about `codemie-budget-status.js`, not the legacy `codemie-statusline.mjs`.
- **Coupling between `claude.plugin.ts`'s `beforeRun`/`afterRun`**: the module-level `statuslineManagedThisSession` flag and the `afterRun` cleanup block (lines 270-301) are used exclusively for the dead `--status` path — safe to remove wholesale, but both halves (the flag and the cleanup) must be removed together to avoid dangling references.
- **`--status` flag removal blast radius**: `CODEMIE_STATUS` is narrowly scoped (set in one place, consumed in one place), but the `--status` Commander option is defined on the shared base `AgentCLI` class, affecting `--help` output for all agent plugins, not just Claude — removal or repurposing needs a decision on whether other agents might want this hook later.
- **`statusline.mjs` cannot currently satisfy "zero network dependency when no profile is configured" (requirement #5)**: the budget-resolution block always attempts `JSON.parse(await fs.readFile(CONFIG_FILE...))` even with no CodeMie profile present, throwing into the catch and rendering a noisy `⚠ no config` segment rather than cleanly omitting the budget segment. A fast-path early-return is needed.
- **No session-cost or duration fields exist anywhere in the current implementation** — `ctx.cost.total_cost_usd`/`total_duration_ms` are never read by `statusline.mjs`; this is pure new functionality with no prior art in this repo to extend or copy.
- **Duplicated crypto logic**: `statusline.mjs` hand-rolls AES decryption mirroring `CredentialStore`, an unavoidable consequence of needing to run standalone once deployed — but any change to `CredentialStore`'s encryption scheme must be manually mirrored here, a drift risk that predates this consolidation task but is relevant to any consolidation touching auth.
- **No project guides document either statusline mechanism** — this is undocumented territory; `.ai-run/guides/integration/external-integrations.md` and `.ai-run/guides/usage/project-config.md` have zero mentions of statusline or budget concepts.
- **A branch `feature/consolidate-statusline` already exists** in this repo's git refs — should be checked with the user/team for pre-existing work-in-progress before starting fresh, to avoid duplicated or conflicting effort.

---

## 7. Summary for Complexity Assessment

This task touches three architectural layers: the CLI layer (`AgentCLI.ts` flag/env wiring, `install.ts`/`uninstall.ts` command surface), the plugin layer (`claude.plugin.ts` lifecycle hooks, `statusline-installer.ts`), and a standalone deployed-artifact layer (`plugin/statusline.mjs`, which runs outside the project process via `node <path>` and must remain free of project imports). The realistic file change surface is moderate: `claude.plugin.ts` (delete ~100 lines of dead code across `beforeRun`/`afterRun` plus the module-level flag), `statusline-installer.ts` (rework `promptBudgetSelection` into an auto-resolution path keyed on `ProviderProfile.codeMieProject` rather than manual `inquirer` selection, decide fate of `statuslineBudgetName`), `plugin/statusline.mjs` (moderate rewrite: add stdin `cost.total_cost_usd`/duration parsing and rendering, restrict budget fields to 3 confirmed names, add a clean no-profile fast path that skips file/network I/O, remove `budget_limit`/`hard_budget_limit` display), `uninstall.ts` (extend cleanup to also remove the legacy `codemie-statusline.mjs` artifact if present), `AgentCLI.ts` (decide fate of the shared `--status` flag), and the test file `claude.plugin.statusline.test.ts` (must be deleted or substantially rewritten since it currently asserts success of code being removed).

Technical novelty is low-to-moderate: the consolidation mostly follows existing patterns already present in the codebase (the "install once, deploy standalone artifact" pattern, the `ConfigLoader`/`CredentialStore` config-resolution pattern, the `CODEMIE_PROFILE_CONFIG` env-passing pattern already used for `claudeAutocompactPct`). The one genuinely novel piece is parsing and rendering `cost.total_cost_usd`/duration from Claude Code's stdin JSON, which has zero prior art in this repo — it must be built from scratch inside `statusline.mjs`, referencing only the old (now-deleted, but recoverable from git history) `codemie-statusline.mjs` behavior described in the ticket as a behavioral reference, not a code source.

Test coverage posture is a significant risk factor: the one existing test file for this domain (`claude.plugin.statusline.test.ts`) tests the code being deleted and currently masks the very production bug this task originates from (its `fs` mocks silently paper over the `ENOENT` that has occurred in production since PR #301). `statusline-installer.ts` and `statusline.mjs` — the two modules receiving the bulk of new logic — have zero existing test coverage, meaning any consolidation work here carries no regression safety net and should budget explicit time for new test creation if tests are requested. Key risk factors for complexity scoring: (1) the target field names for the budget API response (`current_spend`, `percentage_used`, `budget_reset_at`) do not match what the code currently reads (`current_spending`, `budget_limit`) and cannot be verified against a live backend from within this repo — this is an external dependency/unknown that could block or reshape implementation; (2) backward-compatibility handling for users with an existing `statuslineBudgetName` needs an explicit product decision, not just an engineering default; (3) the shared `--status` CLI flag affects all agent plugins' help output, requiring a decision beyond Claude-specific scope; (4) an existing `feature/consolidate-statusline` git branch suggests possible prior WIP that should be checked before starting.
