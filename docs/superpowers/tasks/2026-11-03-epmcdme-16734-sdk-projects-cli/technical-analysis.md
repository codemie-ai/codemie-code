# Technical Research

**Task**: sdk cli projects skill (EPMCDME-16734)
**Generated**: 2026-11-03
**Research path**: filesystem

---

## 1. Original Context

Implement EPMCDME-16734 in repo C:\Projects\EPAM\codemie-dev\codemie-code: add `codemie sdk projects` command group (list, get/details, exists, members, create/update/delete, transfer ownership, assign/update/remove member, bulk assign/remove, CSV validate/import), human-readable and --json modes consistent with existing groups under src/cli/commands/sdk/; `exists` exit 0 when found, distinct non-zero code for 'not found or not accessible' (D8); auth/server errors shown as errors not 'not found'; details prints 'project not found or not accessible' and exits non-zero; update codemie-sdk skill (src/agents/plugins/claude/plugin/skills/codemie-sdk): Project Clarification confirms project exists with new check before creating/changing assets, add projects to asset list and Consult Examples table, add examples/projects.md. Out of scope: SDK changes. The Node SDK ops come from unmerged PR https://github.com/codemie-ai/codemie-sdk/pull/54 (branch EPMCDME-16733_sdk-project-admin-parity, checked out at C:\Projects\EPAM\codemie-dev\codemie-sdk) — record the exact projects API (method names, signatures, types, exists semantics, error behavior, CSV/bulk shapes) the CLI must build against, and how to test against it locally without committing a link dependency. Story: <task-dir>/story.md. A prior sliced analysis exists at C:\Projects\EPAM\codemie-dev\tickets\EPMCDME-16732\attachments\EPMCDME-16734\sdlc-analysis-technical-analysis.md; verify against code and include the required sections (Codebase Findings, Risk Indicators, Task Statements Checked Against the Code). Also note exit-code conventions, test layout (do not write tests unless plan calls for them; repo rule: tests only on explicit request — flag this), and quality-gate commands.

---

## 2. Codebase Findings

### Existing Implementations

**CLI group pattern** (`src/cli/commands/sdk/`):
- `index.ts` — `createSdkCommand()` imports each `createXSubcommand()` and `cmd.addCommand(...)`; its description string lists asset types (users, assistant-categories ...). No `projects`.
- `<group>.ts` (e.g. `skills.ts`, `users.ts`) — commander `Command`, per action: `getSdkClient()` -> `ora` spinner -> service call -> `spinner.stop()` -> `--json` ? `outputJson(x)` : table/detail render -> `catch { spinner.stop(); handleSdkError(error, "<op>") }`.
- `services/<group>.ts` — thin wrappers `(client, ...) => client.<svc>.<method>()`, types imported from `"codemie-sdk"` (e.g. `services/users.ts`). `services/index.ts` re-exports only 5 groups (assistants, workflows, datasources, integrations, llm); skills/users/categories are imported directly by path, so no barrel update required.
- `utils/cli-utils.ts` — `getSdkClient`, `parseDataOrJsonFile(--data inline | --json <file>)`, `outputJson`, `handleSdkError`, `getResponseMessage`.
- `utils/render.ts` — `printTable`, `printDetail`, `optional`, `yesNo`, `printEmpty`, `printListHeader`, `printSuccess`, `printInfo`.
- Input convention for create/update: `--data <json>` or `--json <path>` (file) via `parseDataOrJsonFile` (`skills.ts:169-176`); on read commands `--json` is a boolean output flag. Pagination: `--page` (default "0"), `--per-page` (default "10") parsed with `parseInt` (`skills.ts`). Delete commands have no confirmation prompt (`skills.ts:214-228`, prints `printSuccess`).
- No `projects` anywhere under `src/cli/commands/sdk`. `codemie-sdk` dependency is `^0.1.648` (`package.json:131`); the SDK repo's Node package is now version `0.3.0`.
- `node_modules` is **absent** in codemie-code at the time of research (needs `npm install` before any typecheck/build).

**Exit/error handling** (`utils/cli-utils.ts:79-119`, `handleSdkError`): logs sanitized, then prints: 401/403 -> "Authorization error ... Run codemie setup"; 404 -> "Not found: The requested resource does not exist."; other `ApiError` -> "API error: msg"; `ZodError` -> prettified; else message; always `process.exit(1)`. So **every existing failure is exit 1**; 404 is already mapped to generic "Not found" text. `ApiError` status read from `statusCode ?? status`.

**Exit-code conventions elsewhere**: other commands set `process.exitCode = 1` (`src/cli/commands/docs.ts:48-74`, `codebase/index.ts`, `analytics/index.ts:125`); `assistant-builder/commands.ts:170` uses `process.exit(0)`. No existing code uses a code other than 0/1 (grep of `src/cli` found none) -> D8's distinct code has no precedent to follow; value must be chosen (not decided here).

**Skill** (`src/agents/plugins/claude/plugin/skills/codemie-sdk/`): `SKILL.md` + `examples/{assistants,categories,datasources,integrations,skills,users,workflows}.md`.
- `SKILL.md:4` frontmatter description and `:22` "Asset Types" list omit projects.
- `:28-70` Project Clarification: Step 1 `codemie sdk users me --json`; Step 2 admin sees all projects; Step 3 ask user (default project = user email); `:68-70` how to pass project in payloads. No existence check.
- `:74-85` Consult Examples table: rows use `${CLAUDE_PLUGIN_ROOT}/skills/codemie-sdk/examples/<f>.md`; no Projects row.
- `:223-229` `## Users` section shows command list + link to examples; per-asset sections follow this shape (a `## Projects` section is the analogue).
- `examples/users.md` format: `## <action>` + bash block + `**JSON fields:**` + `## Scripting` with `jq`.

**Node SDK projects API (PR #54, `codemie-ai/codemie-sdk`, state OPEN, head `EPMCDME-16733_sdk-project-admin-parity`)** — exact contract. Verified from `gh pr diff 54` (fork-hosted; branch is NOT fetchable from origin, and the local checkout `C:\Projects\EPAM\codemie-dev\codemie-sdk` is on that branch name but at main commit `f679256f` with **no project.ts in `sdk/codemie-nodejs/src/services/`** — the PR content is not present locally). `client.projects` is a `ProjectService` (`src/client/client.ts`; getter `projects`). Paths relative to `/v1/projects`:

| Method | Signature (returns Promise of) | Endpoint |
|---|---|---|
| `createProject(request: ProjectCreateRequest)` | `ProjectCreateResponse` | POST `/v1/projects` |
| `listProjects(options: ListProjectsOptions = {})` | `PaginatedProjectList` (raw, no envelope) | GET `/v1/projects` |
| `getProjectDetail(projectName)` | `ProjectDetail` | GET `/{name}` |
| `updateProject(projectName, request: ProjectUpdateRequest)` | `ProjectUpdateResponse` (= ProjectCreateResponse) | PATCH `/{name}`; undefined fields dropped, `clear_description:false`, `clear_cost_center:false` always sent |
| `deleteProject(projectName)` | `ProjectDeleteResponse {message,name}` | DELETE `/{name}` |
| `transferOwnership(projectName, userId)` | `ProjectOwnershipUpdateResponse {name,created_by,message}` | PUT `/{name}/ownership` body `{user_id}` |
| `assignUserToProject(projectName, userId, isProjectAdmin = false)` | `ProjectAssignmentResponse` | POST `/{name}/assignment` |
| `updateUserProjectAssignment(projectName, userId, isProjectAdmin: boolean)` | `ProjectAssignmentResponse` | PUT `/{name}/assignment/{user_id}` |
| `removeUserFromProject(projectName, userId)` | `ProjectAssignmentResponse` | DELETE `/{name}/assignment/{user_id}` |
| `bulkAssignUsersToProject(projectName, users: BulkAssignmentUserItem[])` | `BulkAssignmentResponse` | POST `/{name}/assignments` body `{users}`; zod 1..1000 items, throws `ZodError` before request |
| `bulkRemoveUsersFromProject(projectName, userIds: string[])` | `BulkAssignmentResponse` | DELETE `/{name}/assignments?user_id=a&user_id=b`; zod 1..100 ids |
| `validateUsersFromCsv(projectName, csv: Buffer, filename = "users.csv")` | `CsvImportValidationResponse` | POST `/{name}/import-users/validate` multipart field `file`, `text/csv` |
| `importUsersFromCsv(projectName, csv: Buffer, filename = "users.csv")` | `BulkAssignmentResponse` | POST `/{name}/import-users` |
| `projectExists(projectName)` | `boolean` | calls `getProjectDetail` |

There is **no separate "members" method**: members are `ProjectDetail.members: ProjectMember[]` (`{user_id, is_project_admin, date?}`). Empty path ids throw plain `Error("path id must not be empty")`; names URL-encoded. Responses unwrap a `{data: ...}` envelope when present.

Key types (`src/models/project.ts`, exported via `models/index.ts`): `ListProjectsOptions {search?, page? (default 0), per_page? (default 20), include_counters? (true), include_budgets? (false), has_assigned_budgets? (false), sort_by?: "name"|"created_at", sort_order?: "asc"|"desc" (asc)}`; `PaginatedProjectList {data: ProjectListItem[], pagination: {total,page,per_page}}`; `ProjectListItem {name, display_name?, description?, project_type, created_by?, user_count, admin_count, created_at?, counters?: {assistants,workflows,integrations,datasources,skills _count}, cost_center_id/name?, spending?, current_spending?, budgets?, chargeback_enabled?, chargeback_attribution?, cli_analytics_enabled?}`; `ProjectDetail {name, display_name?, description?, project_type, created_by?, user_count, admin_count, created_at?, cost_center_id/name?, members, chargeback_attribution?, cli_analytics_enabled?}`; `ProjectCreateRequest {name, display_name? (<=150), description?, cost_center_id?, cli_analytics_enabled?}`; `ProjectUpdateRequest {name?, display_name?, description?, clear_description?, cost_center_id?, clear_cost_center?, enforce_member_spend_limits?, chargeback_attribution?, cli_analytics_enabled?}`; `BulkAssignmentUserItem {user_id, is_project_admin}`; `BulkAssignmentResultItem {user_id, action: "assigned"|"updated"|"removed", is_project_admin?}`; `BulkAssignmentResponse {message, project_name, total, results}`; `CsvImportValidationResponse {users: {email, role, error?}[]}`; `ProjectAssignmentResponse {message, user_id, project_name, is_project_admin?}`.

**Exists semantics / error behavior**: `projectExists` returns `true` on success, `false` only when `getProjectDetail` throws `NotFoundError`; every other error is rethrown. Backend returns 404 for both missing and not-visible projects (cannot be distinguished). `utils/http.ts` maps HTTP 404 -> `NotFoundError("Resource","unknown")` (subclass of `ApiError`, `statusCode` 404, `name="NotFoundError"`), 422 -> `ApiError` with validation text, other >=400 -> `ApiError(msg, status, data)`. 401/403 therefore surface as `ApiError`, not `false`. Also adds `ApiRequestHandler.patch`. PR also adds 11 admin methods to `UserService` (`src/services/user.ts`, `models/user.ts`) — outside this task's scope (no user-admin CLI in story).

**Local testing without a committed link** (design-neutral facts): the CLI imports from `"codemie-sdk"` resolved through `node_modules` (`package.json:131`, none installed now). The SDK package is `sdk/codemie-nodejs` (`name: codemie-sdk`, `main ./dist/index.cjs`, `types ./dist/index.d.ts`, built by `tsup src/index.ts --format cjs,esm --dts --clean --sourcemap`; `files` limited to dist). Options that leave `package.json`/lockfile untouched: build the SDK then `npm install --no-save <abs path to sdk/codemie-nodejs>` (or `npm pack` there and `npm install --no-save <tgz>`) inside codemie-code, or `npm link` from the SDK dir. Prerequisite: the PR content must first be materialised in the SDK checkout (e.g. `gh pr checkout 54 --repo codemie-ai/codemie-sdk`, since `git fetch origin pull/54/head` failed with access error and the head branch is not on origin; `gh pr diff 54` works). Note `npm install` with a different path will rewrite lockfile unless `--no-save` is used; `package-lock.json` must be checked before commit.

### Decisions Already in the Code

- All SDK-group failures funnel through `handleSdkError` -> `process.exit(1)`; the 404 text there ("The requested resource does not exist") differs from the story's required "project not found or not accessible" -> details/exists need their own 404 branch before falling to `handleSdkError`. `utils/cli-utils.ts` change vs. per-command handling: none recorded.
- Output flag convention: boolean `--json` on reads, `--data`/`--json <file>` on create/update (same flag name, two meanings by command). Projects commands taking IDs/flags (assign member etc.) have no precedent for input beyond these.
- `ApiError` / `NotFoundError` are exported by `codemie-sdk` (`ApiError` already imported in `cli-utils.ts`); `NotFoundError` is a subclass so `instanceof ApiError` + `statusCode === 404` also matches.
- ESM with `.js` import extensions, `@/` alias for non-sdk-local utils, `interface` for shapes, no `any` (AGENTS.md).

### Task Statements Checked Against the Code

- "`codemie sdk` has no projects group" — holds (`index.ts`, grep).
- "codemie-code depends on `codemie-sdk` ^0.1.648; bump to the release" (prior analysis) — holds for the current spec (`package.json:131`); the PR is unmerged and unreleased, so no release/version exists to bump to (unverified: version the release will carry; SDK package is `0.3.0` at main).
- "Existence check cannot distinguish not found from not visible" (prior analysis) — holds (`projectExists` JSDoc/impl).
- "13 operations" (prior analysis) — contradicted: `ProjectService` has 14 public methods (13 plus `projectExists`; no `members` method).
- "members" command — no SDK method; keeps reading `getProjectDetail().members` (the details output contains the same data).
- "`exists` exit 0 when found, distinct non-zero for not found (D8)" — `projectExists` returns boolean, so the CLI chooses the code itself; `handleSdkError` always exits 1, so a distinct code must differ from 1 for auth/server errors to remain distinguishable (no repo precedent for codes >1).
- "auth/server errors shown as errors not 'not found'" — holds only if CLI does not catch broadly: SDK rethrows non-404; however `handleSdkError` maps any ApiError 404 to "Not found", and SDK 404 on sub-routes (e.g. assign user to missing project/user) is indistinguishable from project 404.
- "details prints 'project not found or not accessible'" — `getProjectDetail` throws `NotFoundError` (404) which `handleSdkError` currently renders differently -> keeps existing 404 wording in place unless overridden for this command (consumers: all groups).
- "Skill Project Clarification relies on `users me`" — holds (`SKILL.md:35`).
- "tests for service wrapper" (prior analysis) — conflicts with repo rule (see Section 4).
- "Backend project endpoints fail when user management is disabled" — unverified (outside repo; backend not in reach).

### Consumers of Changed Contracts

- `createSdkCommand()` (`index.ts`) is the only registration point; consumed where the `sdk` command is mounted in the CLI (grep for `createSdkCommand` import before editing). Changing `handleSdkError` would affect every group in `src/cli/commands/sdk/*` and `assistant-builder` plus `utils/__tests__/cli-utils.test.ts`; adding a new local handler affects none.
- Skill files are copied to the dist plugin by `npm run build` (`copy-plugin`); `SKILL.md` and examples are consumed by the Claude plugin only.
- SDK `projects` surface and `codemie-sdk` version range: `package.json`, `package-lock.json` only.

### Architecture and Layers Affected

CLI command layer (`src/cli/commands/sdk/projects.ts` pattern, `services/projects.ts`, `index.ts` registration + description), utils (render/cli-utils only if shared helpers touched), dependency manifest, agent plugin skill docs. Layers respect `CLI -> Registry -> Plugin`; no registry/plugin involvement.

### Integration Points

`codemie-sdk` npm package (`client.projects`), `getAuthenticatedClient` in `@/utils/auth.js`, `ConfigLoader`. CSV/bulk: file reading uses `node:fs/promises` (precedent `readFile` in `cli-utils.ts`, `skills.ts` import). CSV API wants `Buffer` + filename (`basename` imported in `skills.ts` already). Bulk assign wants `{user_id,is_project_admin}[]` (max 1000), bulk remove `string[]` (max 100) — no CLI precedent for these input shapes (closest: `bulkAttachSkillToAssistants` in `skills.ts`).

### Patterns and Conventions

Per-group file with `create<Name>Subcommand`, spinner + try/catch, `printTable` columns with fixed widths, `printDetail` rows, multi-line `.description()` with an `Examples:` block, `--page 0-based`. Skill docs use `${CLAUDE_PLUGIN_ROOT}` links.

---

## 3. Documentation Findings

### Guides and Architecture Docs

`.ai-run/guides/` present (architecture, development, standards, testing, quality-gates). Per AGENTS.md: guides win on process, source on facts. `docs/ARCHITECTURE-*.md` do not cover the sdk CLI group. No documentation of the `codemie sdk` exit codes found. `README.md`/`docs/` mention of sdk commands not checked beyond skill (grep scope: sdk dir and skill).

### Architectural Decisions

None recorded for exit codes or projects. D4/D6/D8 are in `story.md` (D8 = distinct exit code for exists).

### Derived Conventions

See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts` — `handleSdkError` (401 case; mocks `console.error` and `process.exit`).
- `src/cli/commands/sdk/services/__tests__/assistants-builder.test.ts`, `assistant-builder/__tests__/`, `assistant-builder/report/` tests.
- No tests for users/skills/other group commands; none for projects.

### Testing Framework and Patterns

Vitest, projects `unit` (`src/**/*.test.ts`), `cli` and `agent` (`tests/integration/**`). Colocated `__tests__` dirs under `src/cli/commands/sdk`. Pattern: `vi.spyOn(process, "exit")`, `vi.spyOn(console, "error")`.

### Coverage Gaps

Whole projects group would be untested. **Flag: AGENTS.md rule "Tests only on explicit request" — do not write or run tests unless the plan/user explicitly asks.** The prior analysis's "service wrapper and tests" conflicts with this; the plan must either carry an explicit request or omit tests.

---

## 5. Configuration and Environment

### Environment Variables

None specific. Auth through `ConfigLoader`/`getAuthenticatedClient`; `CODEMIE_DEBUG=true` for debug logs.

### Configuration Files

`package.json` (dep `codemie-sdk`), `package-lock.json`, `tsconfig.json` (`@/` paths), `eslint.config.mjs`, `vitest.config.ts`.

### Feature Flags and Deployment Concerns

None found. Quality gates (`package.json:scripts`; `.ai-run/guides/quality-gates.md`): `npm run typecheck` (`tsc --noEmit`), `npm run lint` (eslint, `--max-warnings=0`; `lint:fix`), `npm run build` (`tsc && tsc-alias && copy-plugin && bundle-statusline`), `npm run check:pre-commit` (typecheck+lint, runs in husky), `npm run ci` (license-check, lint, build, unit + cli test projects), Conventional Commits via commitlint. Tests (`npm test`) only on request.

---

## 6. Risk Indicators

- Blocking dependency: PR #54 unmerged/unreleased; the local SDK checkout lacks the PR code (branch name is on main commit `f679256f`; PR head is on a fork, not on origin). Types (`ProjectDetail`, etc.) will not typecheck against `^0.1.648` (node_modules also absent).
- Speculative: the `package.json` dep range cannot be bumped to a real version until release; a local `--no-save` install must not leak into `package.json`/`package-lock.json`.
- D8 distinct exit code has no repo precedent (all failures exit 1 via `handleSdkError`); the code value and that auth/server errors must not collide with it are open (see Task Statements).
- `handleSdkError` 404 wording ("requested resource does not exist") conflicts with required "project not found or not accessible"; also shared by every group (`cli-utils.ts:79-119`).
- Sub-route 404s (assign/remove member, import) cannot distinguish project vs. user not found.
- `--json` flag dual meaning (output vs file path) — projects create/update must follow `--data`/`--json <file>`; bulk/CSV need new input conventions (no precedent for CSV file input or user-list input).
- Bulk limits enforced by SDK zod (1..1000, 1..100) throw `ZodError`, rendered by `handleSdkError`.
- Destructive commands (delete, transfer ownership, bulk remove) have no confirmation precedent in sdk groups.
- Mandatory skill step change (Project Clarification) affects all asset flows; exists cannot tell missing vs not visible, wording must say so. Non-admin users may get 404 for projects they cannot see.
- Tests-on-request rule vs. prior analysis's expectation of tests.
- Prior analysis said "13 operations"; actual 14 including `projectExists`; no `members` SDK method.

---

## 7. Summary for Complexity Assessment

The change is confined to codemie-code: one new command-group file `src/cli/commands/sdk/projects.ts`, a thin `services/projects.ts`, a registration edit in `index.ts`, and skill docs (`SKILL.md` edits in 4 places plus new `examples/projects.md`). Roughly 5 files, ~14 subcommands, all following a well-established spinner/try-catch/`--json` pattern; low architectural novelty. No DB, config or layer changes.

Real risk is outside the code pattern: the SDK API exists only in unmerged PR #54 (not materialised locally and not fetchable from origin), the CLI must pin to an unreleased version, and local verification needs `--no-save` install or pack of the built SDK. New behaviour with no precedent: a distinct non-zero exit code (D8) when every existing path exits 1, a 404 message override, and CSV/bulk input handling. Tests: none exist for the group and repo policy forbids writing them without explicit request.

---

## 8. External References

- Story: `docs/superpowers/tasks/2026-11-03-epmcdme-16734-sdk-projects-cli/story.md` — read; ACs and D8 as quoted in task context ("Open Questions: None").
- Prior analysis `C:\Projects\EPAM\codemie-dev\tickets\EPMCDME-16732\attachments\EPMCDME-16734\sdlc-analysis-technical-analysis.md` — resolved, read; verified in Section 2 (13 vs 14 operations corrected).
- PR https://github.com/codemie-ai/codemie-sdk/pull/54 — resolved via `gh pr diff 54` (state OPEN, 19 files; Node SDK files listed above). API recorded in Section 2 from the diff, not from the checkout.
- `C:\Projects\EPAM\codemie-dev\codemie-sdk` — exists, on branch `EPMCDME-16733_sdk-project-admin-parity` but at main (`f679256f`), PR code absent; `sdk/codemie-nodejs/src/schemas/project.ts` exists (older `Project` zod schema, unrelated). `node_modules` exists in the SDK package; `dist/` present but built from main.
