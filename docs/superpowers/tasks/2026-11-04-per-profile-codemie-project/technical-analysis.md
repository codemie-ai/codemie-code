# Technical Research

**Task**: config profile workspace identity
**Generated**: 2026-11-04
**Research path**: filesystem

---

## 1. Original Context

Fix EPMCDME-16519 (Critical) / EPMCDME-15411 — global CodeMie CLI profiles share ONE workspace identity, so profile switching applies the wrong CodeMie project (and URL/integration). It MUST work.

User report (CLI 0.16.2/0.16.3): two global SSO profiles on the same CodeMie URL: mtlx-amsd (configured with project mtlx-amsd) and mtlx-csd (configured with project mtlx-csd). `codemie-claude --profile mtlx-csd` starts with that profile (banner shows Profile mtlx-csd) but the session's CODEMIE_PROJECT is mtlx-amsd — whatever the last `codemie setup` selected. Session env had CODEMIE_PROFILE_NAME=mtlx-csd, CODEMIE_PROJECT=mtlx-amsd; CODEMIE_PROFILE_CONFIG had name mtlx-csd and codeMieProject mtlx-amsd. ~/.codemie/codemie-cli.config.json profiles have no project field; only `workspace.codeMieProject` exists globally. Budgets attach to the project, so spend lands on the wrong client project silently (~$585 misbilled). Users need to run sessions for two projects in parallel and to switch to personal/generic profiles for internal work. Nothing in the session tells the user the project (banner shows Profile/Provider/Model/CodeMie URL, not project).

Already-confirmed root cause (verify, don't trust):
- src/utils/config.ts saveProfile() (~709-716) splits codeMieUrl/codeMieProject/codeMieIntegration into the single global `workspace` and merges it: `config.workspace = { ...config.workspace, ...workspaceFields }`.
- resolveProfileWorkspaceWithOrigin() (~268-301) for a global profile takes IDENTITY_KEYS only from the global workspace.
- Migration 007 (src/migrations/007-decouple-provider-workspace-config.migration.ts) moved identity off profiles into the workspace, keeping only one profile's values.

History: PR #596 (closed, stale) and PR #701 "fix(config): isolate CodeMie identity per global profile" added identity onto ProviderProfile + migration 008 cloning the shared workspace identity onto every global profile; merged then reverted by #712 (commit 0cb83c77). Jira 16519: on upgrade the existing config only holds one workspace.codeMieProject (the last setup's), and migration 008 wrote that project into EVERY global profile, permanently pointing e.g. project-profile at the personal project with no warning; `codemie profile` / `codemie profile status` don't display the project. 15411 AC: each global profile stores and resolves its own identity; no cross-profile overwrites; no regressions for local profile / repo-local workspace behavior; regression tests for >=2 global profiles in different environments. Use `git show 71093df1` to study the reverted design and its reviewer findings (canUseSharedIdentity, atomic identity trio, statusline.ts inline fallback, profile list display) — reuse what was sound, avoid the upgrade flaw.

Intended direction (to be confirmed in spec): per-profile identity on global ProviderProfile; saveProfile writes identity to the profile; upgrade must NOT copy the shared leftover project into every profile (at most the active profile, or only where provably correct); a profile without its own project must produce a visible warning (and ideally a one-time prompt to pick a project) rather than silently billing the shared value; show project in the startup banner and in `codemie profile` / `profile status`; consider a launcher `--project` override for parallel sessions. Attribution-header derivation source change (X-CodeMie-Project/Integration) needs the security guide's CRITICAL checklist.

Research all consumers: ConfigLoader load/resolveProfileWorkspace/resolveProjectOrigin/resolveIdentitySource/isLocalProfile, saveProfile, profile switch/list/status/display commands, setup flow (codemie setup / SSO project selection), provider templates (sso.template.js copying codeMieProject to CODEMIE_PROJECT), agent launcher banner (src/agents/core or cli), proxy daemon (--project, header-injection plugin), claude plugin statusline.ts, hooks/native hook path (preferLinkedProject, PR #753 EPMCDME-16440 open), analytics/project_source evidence, migrations index & registry, bin/ shortcuts that skip migrations, and existing tests (config-project-override.test.ts, migration tests). Also check open PRs #667, #575 that touch profile scope.

---

## 2. Codebase Findings

Branch `EPMCDME-16519_per-profile-codemie-project` has no commits or source diff vs `main`; everything below is current `main` behaviour.

### Existing Implementations

**Purpose A — a global profile resolves its own CodeMie identity (URL/project/integration).**
- `ConfigLoader.load()` `src/utils/config.ts:120-142`: merges `loadGlobalConfigProfile()` (raw `profiles[name]`, `:345-375`) first, then `resolveProfileWorkspace()` result via `Object.assign`. Any identity on the profile record would be **overwritten**, because for a global profile `resolveProfileWorkspaceWithOrigin()` `:284-291` deletes every IDENTITY_KEY and re-sets it from `globalWorkspace` only. Root cause confirmed.
- `IDENTITY_KEYS` `:656-660` (`codeMieUrl`,`codeMieProject`,`codeMieIntegration`); `WORKSPACE_KEYS` `:667-677` includes them.
- `ProviderProfile` `src/env/types.ts:51` has **no** identity fields; they exist only on `WorkspaceConfig` `:105-108` and `LegacyConfig` `:159-161`.
- Local profiles: identity comes from `resolveWorkspace()` (local workspace, else global) `:216-227, :279-282`. A local workspace with `workspace != null` wins outright.
- Rules: identity trio treated atomically in migration 007 (`007…:6-12, 78-93`); env vars `CODEMIE_URL` and `CODEMIE_INTEGRATION_ID/ALIAS` are read by `loadFromEnv()` `:536-543` but filtered out when `--profile` is given (`:156-186`); `CODEMIE_PROJECT` is **never** read by `loadFromEnv()`.

**Purpose B — persisting identity chosen at setup.**
- `saveProfile()` `src/utils/config.ts:703-724`: `splitProfileAndWorkspace()` (`:684-698`) routes identity to `config.workspace` and merges (`{...config.workspace, ...workspaceFields}`). Confirmed. Sole caller: `src/cli/commands/setup.ts:345` (global storage). Local storage goes through `initProjectConfig()` `config.ts:982-1020` (writes local `workspace`).
- SSO project selection: `src/providers/plugins/sso/sso.setup-steps.ts:146-151` (additionalConfig), `buildConfig` `:181-195`. Same for `anthropic-subscription.setup-steps.ts:62-129`, `moonshot-subscription.setup-steps.ts:49-113` (`selectCodeMieProject`).

**Purpose C — telling the user which project a session/profile uses.**
- Launch banner `src/agents/core/BaseAgentAdapter.ts:624-640` → `renderProfileInfo()` `src/utils/profile.ts:17-58`: fields profile/provider/model/codeMieUrl/agent/version/session; **no project field**.
- `codemie profile` list `src/cli/commands/profile/index.ts:52-73`: computes one `codeMieUrl` for all local rows and one for all global rows (`resolveProfileWorkspace(wd,true|false)`), passed to `ProfileDisplay.formatList` `display.ts:61-90`. `profile status` `index.ts:104-160` → `formatStatus` `display.ts:98-130` with `config.codeMieUrl`. No project shown anywhere.
- `codemie proxy connect` prints `Project:` `src/cli/commands/proxy/connect-orchestrator.ts:596` — the only existing project display.
- `profile status --show-sources` → `loadWithSources` `config.ts:1320-1390` labels identity layer via `resolveIdentitySource()` `:307-316` (global profile → `'global'`).

**Purpose D — per-session project override (parallel sessions).**
- No launcher `--project` option (`AgentCLI.ts:89-101`; only `--project-name` for framework init `:143`).
- Proxy daemon has `--project` (`src/cli/commands/proxy/daemon-manager.ts:148`), fed from `config.codeMieProject` (`launch-daemon.ts:44`, `restart.ts:81`, `proxy/index.ts:141`, `connect-orchestrator.ts:438,477,882`). `proxy … --profile` is described as "Profile whose URL, credentials, and project to use" (`proxy/index.ts:397`).
- Shell `CODEMIE_PROJECT` passes through to the child only when the resolved config has no project (guide `project-config.md:182`; templates set it only `if (config.codeMieProject)`).

**Purpose E — guarding against a shared/foreign identity (reverted design, `git show 71093df1`).**
- `canUseSharedIdentity()` refused the shared fallback only when profile is `ai-run-sso`/`bearer-auth`, its baseUrl origin ≠ shared codeMieUrl origin, AND a sibling platform profile sits on the shared origin. **For the reported case (two profiles on the same URL) it returns `true`**, so migration 008 cloned the leftover project into both — the upgrade flaw is not covered by that guard.
- Sound parts reviewers kept: atomic-trio rule (`ownHasAnyIdentity`), saveProfile carry-forward of identity when update omits it, dropping explicit `key: undefined`, per-profile-name URL map for `profile list`, statusline inline mirror (CR-007 fix: local branch must use the LOCAL profile's provider/baseUrl).

**Other touched code**
- Env export: `sso.template.ts:42-53`, `jwt.template.ts:61-62`, `anthropic-subscription.template.ts:134-135`, `moonshot-subscription.template.ts:97-98` (`config.codeMieProject` → `CODEMIE_PROJECT`). `AgentCLI.ts:393,418` set `CODEMIE_PROFILE_NAME` and `CODEMIE_PROFILE_CONFIG = JSON.stringify(config)`.
- Statusline budget `src/agents/plugins/claude/plugin/statusline.ts:705-735`: picks profile from `CODEMIE_PROFILE_NAME`, but `codeMieUrl = config.workspace?.codeMieUrl` (`:730`) read raw from the global file; standalone bundle, cannot import ConfigLoader.
- Hook/native path: `src/agents/core/event-fields/identity-fields.ts:103-141` (`CODEMIE_PROJECT` env → pinned → `loadHookConfig()` via `ConfigLoader.load(..., {preferLinkedProject: native})`); managed launch uses `CODEMIE_PROFILE_NAME`.
- Evidence `project_source`: `src/agents/core/evidence/stamp.ts:24-41` calls `isLocalProfile()` + `resolveProjectOrigin()` (no profile-name arg); comment at `:37` already anticipates "project may sit on the selected profile record itself".
- Header injection `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:69-107,151-157` (X-CodeMie-Project / -Project-Source / -Integration from proxy config); `otlp-spool/evidence-send.ts:39-40`.
- Other `config.codeMieProject` readers: `BaseAgentAdapter.ts:1128` (session metadata from env), `ensure-session.ts:29`, plugins `codemie-code.plugin.ts:63`, `codex.plugin.ts:108`, `pi.plugin.ts:99`, `copilot-cli.plugin.ts:51`, `opencode.plugin.ts:98`, `hook.ts:877,1199`, `hook/end-metric.ts:95`, `test-metrics.ts:84`, `assistants/setup/selection/utils.ts:63,80`, `DesktopTelemetryRuntime.ts:473` (`ConfigLoader.load(wd)` — active profile, no `--profile`).

### Decisions Already in the Code
- Identity lives on scope `workspace`, not profile — chosen in migration 007 (`007…:36-38`); reason: "decouple repo/tooling-context fields"; alternative (per-profile) implemented in #701 then reverted (#712, `0cb83c77`, no reason in commit message; Jira 16519 states the upgrade flaw).
- Identity trio resolved atomically, never mixed across profiles — `007…:6-12`, reasserted in #701.
- Repo-local workspace never retargets global profiles — `config.ts:230-235`; local workspace wins for local profiles.
- Managed launch: profile's project beats a linked folder's; native hook: linked folder beats global (`config.ts:274-301`, D2). PR #753 (open) further changes the native branch when local `workspace.codeMieUrl` differs.
- `CODEMIE_PROJECT` is output-only, not an input to `load()` — `config.ts:507-546`, guide `project-config.md:182`.
- Migrations only run from `bin/codemie.js:31-40`; shortcuts (`bin/codemie-claude.js` etc.) and the statusline never run them. Migration slot 008 is now taken (`008-repair-hook-shell-and-stale-paths`); latest is 009 (`src/migrations/index.ts`).
- Data direction: stored as one global value keyed by scope; task needs it keyed by profile name. The upgrade input holds only one project, so per-profile values for non-last profiles do not exist anywhere on disk.

### Task Statements Checked Against the Code
- "saveProfile() splits identity into global workspace and merges" — **holds** (`config.ts:709-716`).
- "resolveProfileWorkspaceWithOrigin() for a global profile takes identity only from global workspace" — **holds** (`:284-291`).
- "Migration 007 kept only one profile's values" — **holds** (active profile, else first with identity; `007…:78-93`).
- "Banner shows Profile/Provider/Model/CodeMie URL, not project" — **holds** (`profile.ts:17-58`, `BaseAgentAdapter.ts:626-639`).
- "`codemie profile` / `profile status` don't display project" — **holds** (`display.ts`).
- "Migration 008 wrote the project into EVERY global profile" — **holds** for same-URL profiles: `canUseSharedIdentity` (71093df1) permits same-origin.
- "sso.template copies codeMieProject to CODEMIE_PROJECT" — **holds** (`sso.template.ts:43`; file is `.ts`).
- "No regressions for local profile / repo-local workspace" — keeps `resolveWorkspace()` and local branch `:279-282` in place (consumers: `load`, `loadWithSources`, `stamp.ts`, `profile list`).
- "Consider a launcher `--project` override" — none exists; proxy daemon `--project` exists (`daemon-manager.ts:148`).
- "Profiles have no project field in user's config" — **unverified** (user machine); consistent with `ProviderProfile` type and migration 007 stripping.

### Consumers of Changed Contracts
- `ConfigLoader.load()` result `codeMieProject/Url/Integration`: all readers listed under Other touched code; they get `config.codeMieProject` and need no change if `load()` resolves per-profile. Exception: `DesktopTelemetryRuntime.ts:473` and `assistants/setup` use the active profile.
- `resolveProfileWorkspace(wd, isLocal, preferLinked)` (public): `config.ts:141,1346`, `profile/index.ts:57-58`. No profile-name parameter today.
- `resolveProjectOrigin(wd, isLocal, native)`: `stamp.ts:34` only. Its `'profile'` origin currently means "global workspace".
- `isLocalProfile(wd, name)`: `stamp.ts:32`.
- `saveProfile()`: `setup.ts:345`; migration 007 comment `:120`.
- `ProviderProfile` type: setup buildConfig, `listProfiles()` `config.ts:825`, `ProfileInfo` `display.ts:13-18`.
- Raw `config.workspace.codeMieUrl` readers outside ConfigLoader: `statusline.ts:730` only.
- `renderProfileInfo()`: `BaseAgentAdapter.ts:634`, `display.ts:31,112`.
- Searched: `codeMieProject`, `CODEMIE_PROJECT`, `resolveProfileWorkspace`, `resolveProjectOrigin`, `isLocalProfile(`, `saveProfile(`, `workspace?.codeMie*` across `src/` and `bin/`.

### Architecture and Layers Affected
- Utils/config: `ConfigLoader` (`src/utils/config.ts`), types (`src/env/types.ts`).
- Migrations: `src/migrations/` (index, registry, runner).
- CLI: `setup.ts`, `profile/index.ts`, `profile/display.ts`, `utils/profile.ts`, `AgentCLI.ts` options.
- Agent core: `BaseAgentAdapter` banner, `event-fields/identity-fields.ts`, `evidence/stamp.ts`.
- Provider plugins: sso/jwt/subscription templates and setup steps; SSO proxy `header-injection.plugin.ts` (consumer only).
- Claude plugin: `statusline.ts` (standalone bundle).

### Integration Points
- `CODEMIE_PROFILE_CONFIG` / `CODEMIE_PROJECT` env → proxy daemon → `X-CodeMie-Project` header → backend budget attribution.
- CodeMie API project list via `selectCodeMieProject` (setup).

### Patterns and Conventions
- Migrations: class implementing `Migration`, `MigrationRegistry.register()`, import in `src/migrations/index.ts`, pure `migrate(config)` + idempotent guard (007 pattern).
- Non-empty guard before writing `workspace` (empty `{}` severs global fallback) — `007…:120-125`, `saveProfile`.
- Statusline duplicates logic inline (no imports) — 71093df1.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md:146-182` documents scope rule "a global profile always uses the global workspace" and the `CODEMIE_PROJECT` passthrough — will be stale after the change.
- `.ai-run/guides/security/security-practices.md:18-69` — CRITICAL section: any change to the derivation source of `X-CodeMie-Project`/`-Integration` requires security sign-off and the reviewer checklist (`:65-69`); single injector rule (`:53`).
- Prior task artifacts: `docs/superpowers/tasks/2026-10-27-global-profiles-share-workspace-identity/` (in 71093df1), `2026-10-20-profile-scope-ownership-gaps/` (PR #667).

### Architectural Decisions
- Migration 007 doc comments (atomic trio). D2 comment in `config.ts:291` (managed keeps profile project).

### Derived Conventions
- Identity changes are mirrored in `loadWithSources` and statusline; tests use temp `CODEMIE_HOME` via `paths` spies.

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/config-project-override.test.ts` (36 cases): initProjectConfig, loadWithSources, saveProfile workspace split (`:396`), selected global vs local team profile (`:430`), linked project AC7 (`:771`).
- `src/migrations/__tests__/007-…migration.test.ts`, `migration-runner-ordering.test.ts`.
- `src/cli/commands/profile/__tests__/index.test.ts:87-130` — workspace-resolved codeMieUrl display.
- `src/agents/core/__tests__/AgentCLI-project-seam.test.ts` — real launcher/config seam, managed project export.
- `src/agents/core/evidence/__tests__/routing-contract.test.ts`, `matrix.test.ts`; `statusline.test.ts`; template tests for jwt/subscriptions; `tests/integration/proxy-routing-guard.test.ts`.

### Testing Framework and Patterns
- Vitest; real temp dirs, `vi.spyOn(paths, ...)`, dynamic imports after mocks.

### Coverage Gaps
- No test with ≥2 global profiles carrying different projects on the same URL.
- No banner (`renderProfileInfo`) test for project; no `profile status` project display test.
- `stamp.ts` `project_source` for per-profile origin untested.

---

## 5. Configuration and Environment

### Environment Variables
- Output: `CODEMIE_PROJECT`, `CODEMIE_URL`, `CODEMIE_INTEGRATION_ID`, `CODEMIE_PROFILE_NAME`, `CODEMIE_PROFILE_CONFIG`.
- Input to `load()`: `CODEMIE_URL`, `CODEMIE_INTEGRATION_ID/ALIAS` (filtered under `--profile`); not `CODEMIE_PROJECT`.

### Configuration Files
- `~/.codemie/codemie-cli.config.json` (`profiles`, `activeProfile`, `workspace`, `userEmail`); `.codemie/codemie-cli.config.json` local; `~/.codemie/migrations.json` tracker.

### Feature Flags and Deployment Concerns
- None found. Migrations run only via `bin/codemie.js`; `codemie-claude` etc. read un-migrated configs.

---

## 6. Risk Indicators

- Upgrade data gap: the existing config holds one `workspace.codeMieProject`; any clone-to-all migration reproduces 16519 (same-URL profiles pass `canUseSharedIdentity`).
- Speculative: a read-time fallback to `workspace.codeMieProject` for profiles without their own keeps the shared value in place (consumers: `load`, `loadWithSources`, `stamp.ts`, statusline) — see Task Statements.
- Shortcut launchers and statusline run before/without migrations (`bin/codemie-claude.js`, `statusline.ts:730`).
- CRITICAL security review: changing the source of `X-CodeMie-Project`/`-Integration` (`header-injection.plugin.ts`) per security guide.
- `resolveProfileWorkspace`/`resolveProjectOrigin` lack a profile-name parameter; `'profile'` origin semantics change.
- Open PRs overlap `config.ts` and `config-project-override.test.ts`: #753 (native linked-folder URL check), #667, #575 (profile scope; also `setup.ts`, `profile/index.ts`, `env/types.ts`) — merge conflicts likely.
- Migration numbering: 008 taken; next is 010.
- `DesktopTelemetryRuntime.ts:473` and `assistants/setup` use active profile, not session profile.
- Guide `project-config.md:146-182` becomes stale.

---

## 7. Summary for Complexity Assessment

The change spans the config utility (`ConfigLoader.load`, `resolveProfileWorkspaceWithOrigin`, `saveProfile`, `loadWithSources`, `resolveIdentitySource`), types (`ProviderProfile`), migrations (new id ≥010), CLI display (`renderProfileInfo`, `profile list/status`, launch banner in `BaseAgentAdapter`), setup save path, evidence `project_source` (`stamp.ts`), and the standalone Claude statusline. Downstream readers (templates, plugins, proxy, hooks) consume `config.codeMieProject` from `load()` and are unaffected if resolution changes at the source. Roughly 8-12 source files; root cause is confirmed exactly as described.

The pattern is not novel: #701 (`71093df1`) implemented per-profile identity with atomic-trio semantics, carry-forward in saveProfile, per-profile list display and a statusline mirror, and passed review. Its failure was the upgrade: `canUseSharedIdentity` only detects cross-URL conflicts, so same-URL profiles all received the last-saved project. The new element is an upgrade/fallback policy that does not assign the shared project to profiles it cannot be proven to belong to, plus visible project display/warning; there is no existing launcher `--project` option.

Test coverage around config resolution is strong (36 cases in `config-project-override.test.ts`, seam and routing-contract tests) but has no multi-global-profile same-URL case and no project display tests. Key risks: the upgrade data gap, the CRITICAL attribution-header security review, migrations skipped by shortcut launchers/statusline, and conflicts with open PRs #753/#667/#575 on the same files.

---

## 8. External References

- `git show 71093df1` (in-repo history, resolved): reverted design — `canUseSharedIdentity(profile, siblings, ownName, sharedCodeMieUrl)` refusing only when platform provider + origin mismatch + sibling claims shared origin; `ownHasAnyIdentity` all-or-nothing gate; saveProfile `NON_IDENTITY_WORKSPACE_KEYS` with identity carry-forward "only when the update supplies NONE of the three"; `formatList(profiles, Map<name,url>)`; statusline inline mirror; migration 008 `withIdentityFrom` cloning shared trio onto each eligible global profile and never stripping `workspace`. Reviewer CR-007: local branch used the global profiles map (empty for local-only profiles); statusline gated only on `codeMieUrl`. Both fixed before merge.
- PRs #753, #667, #575 (resolved via `gh`, all OPEN): file lists in Section 6.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `interface ProfileInfo` (`display.ts:15-20`): `{ name: string; active: boolean; profile: CodeMieConfigOptions; source?: 'local' | 'global' }`. Its shape matches what `ConfigLoader.listProfiles()` returns (`src/utils/config.ts:825`, which types `profile` as `ProviderProfile`). It is also imported as a type in `profile/index.ts:13` (used by `buildProfileSelectionRow`, the switch/select UI).
- `ProfileDisplay.format(info, workspaceCodeMieUrl?)` (`display.ts:33-53`): calls `renderProfileInfo({ profile, provider || 'N/A', model || 'N/A', codeMieUrl: workspaceCodeMieUrl ?? profile.codeMieUrl, isActive })`, then adds `[Local]` (yellow) or `[Global]` (cyan) when `source` is set. It returns a string. It passes no project field, and it reads no `codeMieProject` or `codeMieIntegration`.
- `ProfileDisplay.formatList(profiles, workspaceCodeMieUrls = {})` (`display.ts:61-95`): takes `{ local?: string; global?: string }`, so there is one URL per **scope** and not one per profile. For each row it chooses `.local` when `source === 'local'` and `.global` otherwise, calls `this.format(...)`, logs it with `─` separators, then prints a fixed "Next Steps" block. When the list is empty it prints a "No profiles found" hint.
- `ProfileDisplay.formatStatus(info, authStatus?, workspaceCodeMieUrl?)` (`display.ts:103-133`): maps `AuthStatus` to `AuthStatusDisplay` `{authenticated, expiresAt, apiUrl}` and calls `renderProfileInfo` with the same `workspaceCodeMieUrl ?? profile.codeMieUrl` URL rule plus `authStatus`. It logs the result and prints a `codemie profile login` hint when the profile is not authenticated. It ignores `info.source` and passes no project field.
- Spec "`--show-sources` labels own-profile vs shared fallback": the `--show-sources` path (`index.ts:167-169`) calls `ConfigLoader.showWithSources()` and does **not** go through `display.ts`.
- `ProfileDisplay.formatList`: one production caller, `listProfiles()` in `profile/index.ts:52-73`. That caller builds `{local: localWorkspace.codeMieUrl, global: globalWorkspace.codeMieUrl}` from `ConfigLoader.resolveProfileWorkspace(wd, true|false)` (`config.ts:239`).
- `ProfileDisplay.formatStatus`: one production caller, `handleStatus()` at `profile/index.ts:158`. It passes `config.codeMieUrl` from `ConfigLoader.load(workingDir)` as the third argument, so the URL is already the effective resolved one.
- `ProfileInfo` type: `profile/index.ts:13` (selection rows) and `display.ts`.
- `renderProfileInfo`: `display.ts` (2 calls) and `BaseAgentAdapter.ts:634`. A new optional field would not affect existing callers.
- Tests: `src/cli/commands/profile/__tests__/index.test.ts:87-157` asserts the exact call shapes `format(info, url)` and `formatStatus(info, undefined, url)`, and that `listProfiles` calls `format` with `'https://local-workspace-url'` / `'https://global-workspace-url'`, using a mocked `resolveProfileWorkspace(_, isLocal)`. `BaseAgentAdapter.test.ts` also references `renderProfileInfo`.
- Underlying renderer: `renderProfileInfo` in `src/utils/profile.ts:17`. It accepts `profile, provider, model, codeMieUrl, authStatus, agent, cliVersion, sessionId, isActive`, with **no project field**, and prints a `CodeMie URL` row only when `codeMieUrl` is set (:56). Its consumers are `display.ts` (:36, :117) and the launch banner `BaseAgentAdapter.ts:634`.
- `src/agents/core/BaseAgentAdapter.ts:625-643`. It runs only when `!this.metadata.silentMode` and reads `env.CODEMIE_PROFILE_NAME`, `CODEMIE_PROVIDER`, `CODEMIE_CLI_VERSION`, `CODEMIE_MODEL`, `CODEMIE_URL`. It does not read any project env var. The output goes to stdout (`console.log`).
- `src/providers/core/registry.ts:19`. It is a static class with four maps: `providers`, `healthChecks`, `modelProxies`, `setupSteps`.
- `ProviderTemplate` (`src/providers/core/types.ts:71`) carries `requiresAuth?` (:80) and `authType?` (:81).
- Profile path: `profile/index.ts:120-121` (status calls validateAuth / getAuthStatus) and `profile/auth.ts:129`.
- 40 non-test files reference `ProviderRegistry`. Others include `setup.ts:214,237,393,412`, `connect-orchestrator.ts:225,233,263`, `doctor/type-adapters.ts:39`, `doctor/checks/AIConfigCheck.ts:46`, `lifecycle-helpers.ts:78`, `utils/config.ts:1537` and `utils/auth.ts:87`.
- `src/providers/core/codemie-auth-helpers.ts:118`. It is a **module-private** function: not exported, and not re-exported from `src/providers/core/index.ts:36-44`. It returns `provider === ProviderName.AI_RUN_SSO || provider === ProviderName.BEARER_AUTH`.
- An inline duplicate of the same predicate exists at `src/agents/core/AgentCLI.ts:261`. It normalizes `baseUrl` via `ensureApiBase` for those two providers.
- `DEFAULT_CODEMIE_BASE_URL` and `ensureApiBase`: AgentCLI.ts:8, plus the index re-export.
- `selectCodeMieProject(authResult)` (:316): `sso.setup-steps.ts:72`, `anthropic-subscription.setup-steps.ts:80`, `moonshot-subscription.setup-steps.ts:67`. Results are stored as `codeMieProject` (sso :148, anthropic :90, moonshot :77) and read back from `credentials.additionalConfig.codeMieProject` (sso :188, anthropic :129, moonshot :113).
- This is **a local `const` inside `AgentCLI.handleRun`**, not an exported function: `src/agents/core/AgentCLI.ts:201-203`.
- The underlying helper, `isNonInteractiveEnvironment()`, is at `src/utils/interactive.ts:14` (`!process.stdin.isTTY`, documented as the "single source of truth for can we prompt"). Its consumers:
- `AgentCLI.ts:202`.
- `providers/core/auth-validation.ts:34`, which guards `promptForReauth`.
- `BaseAgentAdapter.ts:465`, the version notice. That notice goes to stderr, and only when `!silentMode && !isNonInteractiveEnvironment()`.
- `proxy/connect-orchestrator.ts:808`.
- The workspace URL takes precedence over the profile URL in display: `display.ts:40,121` (`workspaceCodeMieUrl ?? profile.codeMieUrl`). Alternative: profile first. Reason: none found.
- For credential lookup the profile `baseUrl` comes first and the workspace URL second, but only for CodeMie providers (`codemie-auth-helpers.ts:131-152`, documented in a comment).
- "project shown in banner": the banner (`BaseAgentAdapter.ts:634`) and `renderProfileInfo` have no project input today.
- `ProfileDisplay.format` / `formatList` / `formatStatus`: `profile/index.ts:65,158`. Tests: `profile/__tests__/index.test.ts:87,114`.
- `renderProfileInfo`: `display.ts` and `BaseAgentAdapter.ts:634`.
- `isCodeMiePlatformProvider`: the same file only (:139, :196). The predicate is duplicated inline at `AgentCLI.ts:261`.
- Defined `display.ts:1-135`; `ProfileDisplay.format` / `formatList` / `formatStatus`. Consumers: `profile/index.ts:65` (list), `profile/index.ts:158` (status). `renderProfileInfo` (`src/utils/profile.ts:17`) takes no project field; rows are Profile/Provider/Model/CodeMie URL (:56)/auth. Reads only `provider`, `model`, `codeMieUrl`; never `codeMieProject`.
- `ConfigLoader.renameProfile(oldName, newName)` at `src/utils/config.ts:916-936`. Loads only the global multi-provider config (`loadMultiProviderConfig`), throws plain `Error` (not `ConfigurationError`) for "not found" / "already exists", writes `{...profile, name: newName}` under the new key, deletes the old key, moves `activeProfile` when it equals the old name, saves global config.
- Sole consumer: `profile/index.ts:455` (`createRenameCommand`, `codemie profile rename`); errors are logged via `logger.error` then `process.exit(1)`.
- Other places that key on the profile name string (found by search, none updated by rename): daemon state `profile` (`connect-orchestrator.ts:196`), `EvidenceFields.profile` (`record-store.ts:30`).
- Declared once: `sso.template.ts:33` (`customProperties.requiresIntegration: true`). No other provider template declares it (search of `src`).
- Read once: `header-injection.plugin.ts:131` (`ProviderRegistry.getProvider(config.provider).customProperties.requiresIntegration === true`); used at `:151` as `integrationId: requiresIntegration ? config.integrationId : undefined`. Test: `proxy/plugins/__tests__/attribution-headers.test.ts:59`. Doc: `docs/ARCHITECTURE-PROXY.md:635`.
- The integration is selected only in `sso.setup-steps.ts:81-142`; `fetchCodeMieIntegrations` is at `sso.http-client.ts:426`.
- Does not resolve a project. `project_source` is computed by `stamp.ts:25-35` (`'none'` unless `hookConfig.config.codeMieProject === project`); `stamp.ts:74-85` takes the project from `resolveSessionProject`. A null/undefined project yields an undefined `project` field and `'none'`.
- Consumers (imports): `stamp.ts:10`, `OtlpAgentAdapter.ts:10`, `event-fields/identity-fields.ts:8`, and the spool files `sweep.ts`, `session-project.ts`, `classification.ts`, `evidence-send.ts`, `tick-processor.ts`, `policy-cache.ts`, `verdict-store.ts` (all under `providers/plugins/sso/proxy/plugins/otlp-spool/`). Not on the launch path.
- `AgentCLI.ts:883-885`, exported: `return !process.stdin.isTTY || process.env.CODEMIE_NO_PROMPTS === '1'`. Checks stdin only (not stdout/stderr).
- One production consumer: `AgentCLI.ts:749` inside `promptExternalResume` (prints a red `console.error` block and returns false, which blocks the resume). It is the only "non-interactive" test used by the launch class; it is specific to external-session resume.
- `connect-orchestrator.ts:393-436`, not exported. Callers: `ensureOtlpProxy` (`:490`) and the connect flow (`:889`).
- Not defined or imported anywhere in `src`; matched by `error.name` string only: `proxy/prompts/analytics-confirmation.ts:54` (returns `'cancel'`), `analytics/index.ts:204` (prints "Report generation cancelled." and returns). Tests: `analytics-confirmation.test.ts:279`.
- Installed inquirer is `9.3.8` (`package.json:138`). No `@inquirer/core` is installed (`node_modules/@inquirer` holds only `external-editor`, `figures`) and no file in `node_modules` contains `ExitPromptError`. Inquirer 9.3.8's `lib/ui/baseUI.js:21-33` handles Ctrl-C by `onForceClose`: `this.close(); process.kill(process.pid, 'SIGINT')` - the prompt does not reject with those names.
- `JWTBearerSetupSteps` (`:20`), registered at `jwt/index.ts:18` via `ProviderRegistry.registerSetupSteps(ProviderName.BEARER_AUTH, ...)`.
- `jwt.utils.ts:21-25`: `process.env[resolveJwtTokenEnvVar(config)]` (trimmed, non-empty) else `config.jwtConfig?.token`. Env var name: `config.jwtConfig?.tokenEnvVar ?? 'CODEMIE_JWT_TOKEN'` (`:13-15`). Re-exported from `jwt/index.ts:15`.
- Consumers: `jwt.setup-steps.ts:146` (validateAuth), `jwt.models.ts:20`, `jwt.template.ts:55`, `sso.template.ts:48` (export `CODEMIE_JWT_TOKEN` when `authMethod` is JWT), `utils/auth.ts:40` (`getAuthenticatedClient`), `doctor/checks/JWTAuthCheck.ts:34` (uses the env var name only).
- `src/utils/errors.ts:8-13`: `class ConfigurationError extends CodeMieError`, `name = 'ConfigurationError'`, message only. Imported by 49 non-test source files.
- Used on this task's paths: `utils/sdk-client.ts` (throws for no config, no SSO credentials: message "SSO authentication required. Please run \"codemie setup\" ..."), `utils/auth.ts` (JWT token missing; `baseUrl` missing; "Authentication expired"). `auth.ts:68` branches on `error instanceof ConfigurationError && message.includes('SSO authentication required')`, so the message text is a contract. `connect-orchestrator.ts` throws it for blank `baseUrl` on the interactive connect path (per the comment at `:459-461`).
- Two orders for the CodeMie URL: `getPlatformUrl` is baseUrl then codeMieUrl for sso/jwt (`codemie-auth-helpers.ts:138-156`); `skills-metrics.ts:360` is codeMieUrl then baseUrl. Reason: none found.
- Message-text contract: `auth.ts:68` matches `'SSO authentication required'` from `sdk-client.ts`.
- Cancelled prompt convention: match `error.name` of `ExitPromptError`/`AbortPromptError`, treat as a cancel (`analytics-confirmation.ts:54`, `analytics/index.ts:204`). Reason: none found; the installed inquirer does not emit them.
- Non-interactive test convention for prompts: `!process.stdin.isTTY || CODEMIE_NO_PROMPTS === '1'` (`AgentCLI.ts:883`).
- "JWT setup project step using bearer auth": `jwt.setup-steps.ts` has no step that holds a token during setup; the token comes from the env at runtime and `validateAuth` is the only token reader. Holds as a description of the current gap; the bearer call for the project list does not exist today (`sso.http-client.ts:426` integrations and `selectCodeMieProject` `codemie-auth-helpers.ts:316` take SSO auth results).
- "stderr warning when non-interactive": the existing non-interactive test is `shouldBlockNonInteractiveResume` (stdin/env), which writes with `console.error` (`AgentCLI.ts:750`). Keeps that mechanism available.
