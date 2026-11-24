# Technical Research

**Task**: statusline budget project profile
**Generated**: 2026-11-23
**Research path**: filesystem

---

## 1. Original Context

CLI statusline shows personal CLI budget instead of project budget for the project selected for the profile

Context
The CodeMie CLI statusline shows a budget segment, for example "$0.00 (0%) resets 12/1/2026". Today it always shows the user's personal CLI budget. It ignores the project selected for the CLI profile.
CodeMie already charges CLI usage to the selected project when that project has a CLI budget. The statusline therefore shows a budget that is not the one being spent.
The budget data the statusline already reads includes one CLI budget entry per project the user belongs to, with spend, percentage used, limit and reset date. Nothing new is needed from the server, except possibly the whole-project CLI spend for shared-pot projects (AC5, D4).
Some projects give each member an own allowance; others use one shared pot for the whole team. For shared-pot projects, today's data reports the percentage against the whole project, while the dollar figure is the member's own spend.
The statusline remembers its last budget figure for about a minute per profile, without regard to the project.

Story: As a developer using the CodeMie CLI with a project selected for my profile, I want the statusline to show that project's CLI budget so that I can see how much of the budget I am actually spending against and when it resets.

Background: Users select a project for their CLI profile so that their CLI usage is charged to that project. The statusline still shows their personal CLI budget, which stays at $0.00 because nothing is charged to it. Reported as a Major bug on project codemie-test-harness.

Acceptance Criteria
AC1: Session uses a project that has a CLI budget -> segment shows that project's CLI spend and percentage used.
AC2: Project budget pays for the session -> personal CLI budget not shown.
AC3: Reset date shown is the reset date of the same budget shown.
AC4: No project -> show budget CodeMie charges: user's default project CLI budget if it has one, otherwise personal CLI budget.
AC4a: Session project has no CLI budget -> show default project's CLI budget if it has one, else personal CLI budget.
AC5: Shared-pot project and member has no personal limit -> whole project's CLI spend against the shared pot, matching percentage and reset date.
AC5a: Shared-pot project and member has personal CLI limit (override) -> member's own spend against personal limit, matching percentage and reset date.
AC6: Project gives each member own allowance -> user's own spend against user's allowance in that project.
AC7 (negative): No budget pays for the session -> no budget segment, and no other budget's figures shown in its place.
AC8 (negative): User switches profile to a different project -> statusline does not show previous project's figures (cache is per profile ~1 minute, not per project today).
AC9 (regression): Profile not connected to CodeMie, or budget cannot be loaded -> rest of statusline renders as today, no wrong budget figures.
Out of scope: changing which budget CodeMie charges (selected project, then default project, then personal); web UI budget displays; showing more than one budget at once.
Decisions: D1 show budget CodeMie actually charges: session project, else default project, else personal. D2 shared-pot: whole project's spend against shared pot. D5 shared-pot member with personal override sees own spend vs personal limit. D3 how statusline learns the selected project and picks the matching entry is left to developers. D4 server may not send whole-project dollar figure for shared-pot projects; developers either add it (small codemie change) or derive it.
Constraints: Repository is codemie-code (this repo, TypeScript/Node, see AGENTS.md). Find where the statusline budget segment is built, where the budget data is fetched (CLI budget entries per project, spend, percent, limit, reset date, shared-pot vs per-member fields), where the 1-minute per-profile cache lives, how the profile's selected project is stored and read (config/profile fields, env vars), and existing tests for these. Note the exact field names in the budget payload types.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: show the budget that pays for this session in the statusline**
- `src/agents/plugins/claude/plugin/statusline.ts` is the whole implementation (862 lines). It is bundled by `scripts/bundle-statusline.mjs` into a standalone ESM artifact and runs as `node <path>` from Claude Code. It must not import `ConfigLoader` (comment at `:684`). It may import only bundle-safe utils (`@/utils/credential-crypto.js`, `price-resolution.js`, `bedrock-pricing.mjs`).
- `matchBudgetRow(rows, userEmail)` (`:83-87`) is the only row selection. It finds the row whose `project_name`, trimmed and lowercased, equals `"<userEmail> (cli)"`. This is the personal CLI budget. No project is considered. This is the bug.
- `formatBudgetSegment(row)` (`:89-97`) renders `$<current_spending.toFixed(2)> (<round(total)>%) resets <toLocaleDateString(budget_reset_at)>`, or `?` if no reset. It returns `{text, pct}`. `budget_limit` is deliberately not shown (test `statusline.test.ts:59`).
- `resolveBudget({readFile, writeFile, fetchImpl, getAuthHeadersImpl})` (`:700-806`) does the following:
  - It reads `~/.codemie/codemie-cli.config.json`.
  - It picks the profile: `process.env.CODEMIE_PROFILE_NAME` if that profile exists, else `config.activeProfile` (`:720-723`).
  - It serves the cache if it is fresh (see below).
  - It skips silently unless the profile, `sessionCodeMieUrl()`, `profile.baseUrl` and the top-level `config.userEmail` are all present.
  - It requires `baseUrl` and `codeMieUrl` to share an origin.
  - It calls `getAuthHeaders` (SSO cookies or JWT from the encrypted credential store) and then `GET ${baseUrl}/v1/analytics/budget_usage` with a 2 s timeout.
  - It skips silently on a non-JSON 200.
  - It throws `'budget row not found'` when there is no match (`:791`). That error is swallowed into `budgetError: 'budget: <code>'` or the message. `main()` renders only `'reauthenticate'` (`:844`).
- `buildStatusLine` (`:626-656`) places the budget segment right after `[project]`. It is coloured by `budgetColor(pct)` (`>85` red, `>30` yellow). A `budgetError` renders as `⚠ ...` only when there is no budget.
- `main()` (`:~810-846`) calls `resolveBudget()` with no arguments, in parallel with branch, model and cost. Stdin context (`cwd`, `model`, `transcript_path`) is not passed to it.
- `sessionCodeMieUrl(profile, workspace)` (`:689-696`) returns `undefined` for a profile with `codeMieProject === null` (off CodeMie). That profile gets no budget (AC9 path today).

**Budget payload (as consumed; there are no TypeScript payload types in this repo)**
- Response shape read: `json.data.rows[]`.
- Row fields used: `project_name`, `current_spending`, `total` (percentage used, rounded), `budget_reset_at` (ISO string), and `budget_limit` (only in the test fixture, never rendered).
- Test fixtures at `statusline.test.ts:28-30` show the row names `"<email> (cli)"`, `"<email>"` and `"<email> (premium)"`. Per-project CLI rows are not seen anywhere in this repo. Their `project_name` format, and any shared-pot or per-member discriminator, are unverified.
- Neither `is_shared`, nor a whole-project spend field, nor a user-limit-override field, nor a default-project marker appears anywhere in the repo (grep of `budget_usage|budget_reset_at|current_spending|budget_limit` hits only `statusline.ts`, its test, the analytics skill, and old task docs).
- `analytics-cli.js:636-649` also calls `/v1/analytics/budget_usage` and `/spending`, but it passes the response through unparsed. The skill docs (`SKILL.md:90`) describe `/spending` fields `current_spend`, `budget_limit`, `hard_budget_limit`, `budget_reset_at`, `percentage_used`. Those are a different endpoint and different names from the `budget_usage` row.

**Cache (the 1-minute per-profile figure)**
- File `~/.codemie/budget-cache.json` (`HOME` honours `CODEMIE_HOME`), `CACHE_FILE` at `:35`. `CACHE_TTL_MS = 60_000` (`:38`) and `CACHE_SCHEMA = 2` (`:40`).
- It is a single-entry file: `{schema, profile, ts, value:{text,pct}}`, written at `:794`. It is read at `:728-736`; the hit condition is `schema === 2 && profile === profileName && value.text is string && age < TTL`.
- Its key is the profile name only. The cached value is the already formatted `{text, pct}`. It carries no project, row identity or raw data.
- The file is shared by every session on the machine. Two sessions on different profiles overwrite each other's entry (a single slot, not one per profile).

**Purpose B: how the session's project is stored and exposed**
- Stored per global profile as `ProviderProfile.codeMieProject?: string | null` (`src/env/types.ts:58-62`). `null` means off CodeMie. A global profile with `undefined` is "unowned" and falls back to the shared `workspace.codeMieProject` (`ConfigLoader.resolveProfileIdentity`, `src/utils/config.ts:308-380`, plus `classifyGlobalProfile` and `globalProfileIdentity`). A local profile or workspace can also carry the project (`localProject`, `resolveWorkspace()`).
- At launch, `CODEMIE_PROJECT` is exported into the agent environment by provider templates (`sso.template.ts:45`, `jwt.template.ts:63-64`, `anthropic-subscription.template.ts:139`, `moonshot-subscription.template.ts:102`). `launch-identity.ts:26` clears inherited `CODEMIE_PROJECT` for `own` and `none` profiles. `PROJECT_BINDING_ENV = CODEMIE_PROJECT_BINDING` (`src/utils/project-binding.ts:17`) holds the binding state. `CODEMIE_PROFILE_NAME` is set in `AgentCLI.ts:417`.
- The statusline subprocess inherits Claude Code's environment. The existing code relies on this for `CODEMIE_PROFILE_NAME` (`:716-719`), `CODEMIE_ROUTER_MODEL_IDS` and `CODEMIE_MODEL_LABELS`. It does not read `CODEMIE_PROJECT` today. `CODEMIE_PROJECT` does reach it only if the launch exported it.
- Native Claude sessions, where `claude-code-otlp` is used and the CLI does not launch Claude, carry a separate rule: "a native session's configured project wins over a shell CODEMIE_PROJECT" (`OtlpAgentAdapter.ts:71`). That matters only if the statusline is installed for native sessions.

**Purpose C: which budget CodeMie charges (D1 / out of scope)**
- No code in this repo decides or mirrors "session project, else default project, else personal". It is server-side. Search: `default.project|defaultProject|personal_project|applications` under `src` gave no budget-related hits. Nothing in the repo marks a "default project".

**Other touched code**
- `src/agents/plugins/claude/statusline-installer.ts:12-14, 26-29` says "The budget segment was removed" and describes the statusline without a budget. `STATUSLINE_DESCRIPTION` (`:15`) omits the budget. `statusline.ts` still builds and renders it, so the installer comments and description are stale relative to the code. The installer still uses the file name `codemie-budget-status.js`.
- Prior task docs `docs/superpowers/tasks/2026-07-11-consolidate-statusline/technical-analysis.md` recorded that an earlier `statuslineBudgetName` manual selection existed. It is not present in current `src` (grep of `statuslineBudgetName` in `statusline.ts` gives nothing).

### Decisions Already in the Code

- Convention: `statusline.ts` is standalone. It reads the config JSON and credentials inline and must not import `ConfigLoader` (`:684`). Anything that mirrors `ConfigLoader` rules is duplicated inline, with a comment pointing at the source rule (the precedent is `sessionCodeMieUrl`).
- Convention: the profile is taken from `CODEMIE_PROFILE_NAME` first, else `activeProfile` (`:713-723`). The reason is recorded: the global `activeProfile` can be repointed by another terminal.
- Choice: the row is matched by `project_name` string equality against `"<email> (cli)"`, not by an id. Alternative: a project-keyed lookup. No reason is recorded.
- Choice: the cache stores the formatted segment under the key `profile`. The cache is a single slot and the project is not part of the key. Reason for per-profile keying: "two sessions on different profiles share this one cache file" (`:726-727`).
- Choice: budget failures are silent except `reauthenticate` (`:840-844`). Reason is recorded in a comment.
- Choice: the rendered text never includes `budget_limit` (test `:59`).
- Data direction: the payload is rows per budget (a list). The task needs one row selected by session project, with a fallback chain. Today it is stored and read as "list, filter by email-derived name".
- Config: the project is stored on the global profile (`codeMieProject`), while the statusline reads the profile record directly from the JSON. It would see `profile.codeMieProject` there and `config.workspace.codeMieProject` as the shared fallback, but the unowned/own/local resolution lives in `ConfigLoader` (see Section 6).

### Task Statements Checked Against the Code

- "Today it always shows the user's personal CLI budget": holds (`matchBudgetRow` `:83-87`).
- "ignores the project selected for the CLI profile": holds. `resolveBudget` never reads `codeMieProject` or `CODEMIE_PROJECT`.
- "budget data ... includes one CLI budget entry per project ... with spend, percentage used, limit and reset date": unverified in this repo. The only recorded row fixtures are the three personal-budget rows (`statusline.test.ts:28-30`). Per-project CLI rows, the shared-pot vs per-member fields, and the project-wide spend field are not in the repo. A live `/v1/analytics/budget_usage` response or the codemie backend schema would settle it.
- "for shared-pot projects ... percentage against the whole project, dollar figure is the member's own spend": unverified (same reason). Current rendering would show exactly that mix (`current_spending` plus `total`).
- "statusline remembers its last budget figure for about a minute per profile, without regard to the project": holds (`:35-40`, `:728-736`, `:794`).
- "CodeMie already charges ... selected project, then default project, then personal": unverified (server behaviour, no code here).
- Reported "$0.00 (0%) resets 12/1/2026" format: holds (`formatBudgetSegment`).
- AC9 "profile not connected or budget cannot be loaded -> rest renders as today": holds today. `resolveBudget` returns `budget: null` for missing config/URL/email/origin mismatch, and `main().catch` swallows errors. Tests cover these (`statusline.test.ts:306-430`).
- Out of scope "showing more than one budget": consistent with the single `{text, pct}` shape.
- The task says the segment shows today. The installer comment says the segment was removed (`statusline-installer.ts:12`): contradicted by `statusline.ts:630,795,828`.

### Consumers of Changed Contracts

- `matchBudgetRow`, `formatBudgetSegment`, `resolveBudget`, `buildStatusLine` are exported and imported only by `statusline.test.ts` (`:5-11`) and `main()`. Nothing else in `src` imports them.
- Cache file `budget-cache.json` and schema `2`: read and written only in `statusline.ts`. A shape change needs `CACHE_SCHEMA` bumped (the comment at `:40` says so). Old entries are discarded by the schema check.
- Budget `{text, pct}` shape: consumed by `buildStatusLine` (`:630`) and `budgetColor`. Test `statusline.test.ts:265-296` builds it directly.
- `/v1/analytics/budget_usage` is also called by `analytics-cli.js:647` (a skill script, raw passthrough) and documented in `SKILL.md:450`. No parsing there depends on row shape.
- `CODEMIE_PROFILE_NAME` / `CODEMIE_PROJECT` consumers: `BaseAgentAdapter.ts:636-644,1135-1144,1205`, `sso.catalog.ts:33`, `launch-identity.ts:26`. They only read the env var, so adding a read elsewhere does not change them.
- `statusline-installer.ts` embeds the bundle. Its tests (`statusline-installer.test.ts`, `claude.plugin.statusline.test.ts`) mention the file name only, not budget behaviour.

### Architecture and Layers Affected

- Plugin layer, Claude agent plugin: the standalone statusline artifact `src/agents/plugins/claude/plugin/statusline.ts`. It has its own bundle step (`scripts/bundle-statusline.mjs`, run by `npm run build`).
- Possibly the installer text in `statusline-installer.ts` (stale description only).
- Config layer: read-only. The statusline reads the config JSON directly.
- External: the CodeMie `/v1/analytics/budget_usage` endpoint (codemie backend, a different repo).

### Integration Points

- CodeMie backend `GET {profile.baseUrl}/v1/analytics/budget_usage` (cookie or Bearer, header `X-CodeMie-Client: codemie-cli`).
- Encrypted credential store `~/.codemie/credentials/*.enc` via `credential-crypto`.
- Environment inherited from the Claude Code launch: `CODEMIE_PROFILE_NAME`, `CODEMIE_PROJECT`, `CODEMIE_HOME`.
- Claude Code stdin JSON (workspace, model, transcript path). It is read in `main()` but is not passed to `resolveBudget`.

### Patterns and Conventions

- Dependency injection through the `resolveBudget` argument object (`readFile`, `writeFile`, `fetchImpl`, `getAuthHeadersImpl`) for tests.
- Pure functions exported for unit testing. A plain `.ts` file with untyped parameters (implicit any) in the budget helpers.
- Errors in the statusline never throw out of `main()`.
- Project imports use `@/` and `.js` suffixes, and are inlined by esbuild.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists (architecture, development, integration, project-config, testing). None of the guide names covers the statusline budget. `docs/ARCHITECTURE-CONFIGURATION.md` covers profiles and identity (not read in full).
- `docs/superpowers/tasks/2026-07-11-consolidate-statusline/technical-analysis.md` and `.../2026-09-30-statusline-spend-long-branch/technical-analysis.md` document earlier statusline work. Their budget field-name discussion is superseded by the code.

### Architectural Decisions
- EPMCDME-15411: per-profile CodeMie identity (migrations 007, 010; `resolveProfileIdentity`). `statusline.ts` mirrors its URL rule inline.
- Statusline cost work: single-file standalone bundle (comment `:12`, `bundle-statusline.mjs`).

### Derived Conventions
- Mirror a `ConfigLoader` rule inline, with a comment citing the source (precedent `sessionCodeMieUrl`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` (789 lines). Budget related:
  - `matchBudgetRow` (`:26-56`)
  - `formatBudgetSegment` (`:58-71`)
  - `buildStatusLine` budget segment and error cases (`:265-296`)
  - `resolveBudget` (`:306-431`): no config, unconfigured profile, wrong origin, reauthenticate, HTTP 500, success plus cache write, fresh cache hit, cache for another profile rejected, schema mismatch, auth throw.
- `claude/__tests__/statusline-installer.test.ts` and `claude.plugin.statusline.test.ts` cover install and file names only.

### Testing Framework and Patterns
- Vitest. `resolveBudget` tests use a path-aware `readFileFor(config, cache)` mock (`:310-316`) and injected `fetchImpl`, `getAuthHeadersImpl` and `writeFile`.

### Coverage Gaps
- No test of project selection, per-project cache keys, default-project fallback, or shared-pot rows. There is no fixture of a per-project CLI row.
- `main()` is not tested end to end. `process.env.CODEMIE_PROFILE_NAME` handling is not directly asserted in the budget tests that I read.
- Repo policy (AGENTS.md): write or run tests only when the user asks.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_PROFILE_NAME` (read, `:720`), `CODEMIE_HOME` (cache and config dir), `CODEMIE_PROJECT` (exported at launch, not read by statusline), `CODEMIE_PROJECT_BINDING` (binding state), `CODEMIE_ROUTER_MODEL_IDS` and `CODEMIE_MODEL_LABELS` (other statusline segments).

### Configuration Files
- `~/.codemie/codemie-cli.config.json`: `activeProfile`, `profiles[name].{baseUrl, codeMieUrl, codeMieProject, codeMieIntegration}`, top-level `userEmail`, `workspace.{codeMieUrl, codeMieProject}`. Local `.codemie/codemie-cli.config.json` can also carry a profile/workspace project (`loadLocalMultiProviderConfig`). The statusline does not read the local file.
- `~/.codemie/budget-cache.json`: the budget cache described in Section 2.

### Feature Flags and Deployment Concerns
- None found. The statusline is installed by `codemie install statusline` into `~/.claude/` as `codemie-budget-status.js`, a copy of the build bundle. A statusline fix needs a rebuild and a reinstall or refresh of that copy on the user's machine. How the installer refreshes an existing copy was not examined.

---

## 6. Risk Indicators

- The payload contract is not in this repo. Per-project CLI row naming, shared-pot vs per-member discriminator, whole-project spend, personal-override and default-project fields are all unverified. Only `project_name`, `current_spending`, `total`, `budget_limit`, `budget_reset_at` are known, and only for personal rows.
- The statusline cannot import `ConfigLoader`. Resolving the session project (profile record, shared workspace fallback, local profile, `null` = off, `CODEMIE_PROJECT` env) means duplicating part of `resolveProfileIdentity`. `CODEMIE_PROJECT` is already set at launch by the provider templates.
- Speculative: the cache needs the project (or the selected row identity) in its key, or it will show another project's figures after a switch (AC8). The single-slot file already thrashes between concurrent profiles.
- Speculative: the "default project" fallback (AC4/AC4a) needs data the statusline does not have today, either from the payload or from another endpoint. Nothing in this repo identifies a default project.
- Speculative: D4 depends on a codemie backend change, in another repo, if the whole-project spend is not already returned.
- The installer comments and `STATUSLINE_DESCRIPTION` say the budget segment was removed, which contradicts the code (`statusline-installer.ts:12`). A reader or an installer-facing text could mislead.
- An existing `matchBudgetRow` failure produces the error `'budget row not found'`, which is swallowed. AC7 and AC9 need "no segment, nothing else shown", which the swallow already gives. A fallback to a different row would break AC7.
- The deployed copy under `~/.claude/` is a bundle. A fix reaches users only after rebuild and reinstall.
- No existing tests for project-aware selection. The `statusline.test.ts` file is large (789 lines), but the budget cases are about 130 lines.

---

## 7. Summary for Complexity Assessment

The change is confined to one standalone file in the Claude plugin layer, `src/agents/plugins/claude/plugin/statusline.ts`. The relevant functions are `matchBudgetRow`, `formatBudgetSegment` and `resolveBudget`, plus the single-slot `budget-cache.json` keyed only by profile. The project of the session is stored in `profiles[name].codeMieProject` (with a shared `workspace.codeMieProject` fallback and a local-profile path) and exported at launch as `CODEMIE_PROJECT`. The statusline reads neither today. The file-change surface is small (one source file, its test file, possibly the installer's stale description), and the code follows an established dependency-injection pattern.

The main uncertainty is not in this repository. The shape of per-project CLI budget rows, the shared-pot and per-member discriminator, the personal-override field, any whole-project spend figure, and the default-project marker are not present in any type, fixture or doc here. The only known fields are `project_name`, `current_spending`, `total`, `budget_limit` and `budget_reset_at`, seen only on personal rows. D4 may need a change in the codemie backend repo. The statusline also cannot import `ConfigLoader`, so project resolution has to be mirrored inline.

Test posture: budget helpers and `resolveBudget` have good unit coverage with injected seams, but nothing covers project selection or project-keyed caching. The next steps need a live or recorded payload to settle the field names.

---

## 8. External References

None named by the task. (Task mentions a "small codemie change"; the codemie backend repo is not referenced by path and was not examined.)
