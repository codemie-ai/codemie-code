# EPMCDME-16734 `codemie sdk projects` Implementation Plan

**Goal:** Add the `codemie sdk projects` group (15 commands) and update the codemie-sdk skill, per `spec.md`.

**Conventions:** Commit per task using the repository's existing convention (Conventional Commits, ticket ref). Task 1 is not a commit. Do not touch `package.json`, `package-lock.json` or `utils/cli-utils.ts`. Do not write tests (AGENTS.md; spec non-goal). ESM, `.js` import extensions, no `any`, explicit return types on exports. Pattern reference: `src/cli/commands/sdk/skills.ts`, `users.ts`. Paths below are under `src/cli/commands/sdk/` unless noted.

### Task 1: Local verification setup (no commit)

- Materialise PR #54 outside tracked state of the sibling checkout: `gh pr checkout 54 --repo codemie-ai/codemie-sdk` in a scratch clone (or `git worktree`-free scratch copy under `temp/`), build `sdk/codemie-nodejs` (`npm install && npm run build`).
- In codemie-code: `npm install`, then `npm install --no-save <abs path to sdk/codemie-nodejs>` (fallback: `npm pack` + `--no-save <tgz>`).
- Confirm `client.projects` types resolve; confirm `git status` shows `package.json` and `package-lock.json` unmodified. Re-check after any later `npm install`.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 2: Service wrapper

- Create `services/projects.ts`: one-line wrappers `(client, ...args) => client.projects.<method>()` for the 13 methods used (all except `projectExists`), mirroring `services/users.ts`. This is the only file importing PR #54 types from `"codemie-sdk"`; re-export the types `projects.ts` needs (`ProjectDetail`, `ListProjectsOptions`, `BulkAssignmentUserItem`, ...).

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 3: Read commands and the single not-found rule

- Create `projects.ts` exporting `createProjectsSubcommand()` with `PROJECT_NOT_FOUND_EXIT_CODE = 2`.
- Add ONE function `readProjectDetail(client, name)`: the sole caller of `getProjectDetail` for `exists`/`get`/`members`, and the only place that extracts the status (`statusCode ?? status`, via `ApiError`) and decides the 404 branch: stderr "Project '<name>' not found or not accessible", `process.exit(2)`. Non-404 errors rethrow to the command's catch -> `handleSdkError` (exit 1). Do not copy status extraction anywhere else.
- Commands: `list` (options per spec; `--json` raw `{data, pagination}`; `printTable`), `get` (`printDetail` plus members), `members` (members only; help says it is a view of `get`), `exists` (prints "exists"; `--json` prints `{"name","exists"}`).
- `exists` help text states: exit 0 = exists, exit 2 = project not found or not accessible, exit 1 = error (auth/server).
- Implementation check: spinner must not write to stdout in `exists --json` (use ora's stderr stream or skip the spinner in JSON mode).

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 4: Mutating commands

- In `projects.ts` add `create`, `update <name>` (input via `parseDataOrJsonFile`; in `--data`/`--json <file>` mode print the response as JSON via `outputJson`), `delete`, `transfer-ownership <name> <userId>`, `assign <name> <userId> [--admin]`, `update-member <name> <userId>` (`--admin`/`--no-admin`, error if neither given), `remove-member`.
- All use `handleSdkError` as-is; note in the help of assign/remove-member/update-member that a 404 cannot distinguish project from user.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 5: Bulk and CSV commands

- Add `bulk-assign <name> --file <path>` (read JSON array of `{user_id,is_project_admin}`), `bulk-remove <name> <userIds...>`, `csv-validate <name> <csvPath>`, `csv-import <name> <csvPath>` (`readFile` to Buffer, filename `basename(csvPath)`). No client-side limit validation (ZodError surfaces through `handleSdkError`).
- Render `BulkAssignmentResponse.results` and `CsvImportValidationResponse.users` as tables (per-row `error` shown).
- Implementation check: inspect the partial-failure shape of bulk-assign and csv-import in the built SDK (PR #54) and render it; if `projects.ts` passes ~500 lines, move members/bulk/csv into a sibling file.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 6: Register the group

- `index.ts`: import `createProjectsSubcommand`, `cmd.addCommand(...)`, add "projects" to the description string. Run `npm run typecheck`, `npm run lint`, `npm run build` for this task's scope; confirm both manifests unmodified.
- Manual CLI run (implementation check): real 404, bad token, unreachable host (also check the SDK timeout does not hang) — expect exit 2, 1, 1 respectively.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 7: Update `SKILL.md`

File `src/agents/plugins/claude/plugin/skills/codemie-sdk/SKILL.md`:
- Add projects to the frontmatter description (line 4) and Asset Types (line 22); add a Projects row to the Consult Examples table (lines 74-85); add `## Projects` section modeled on `## Users` (lines 223-229), citing exit codes 0 ok / 2 not found or not accessible / 1 error.
- Project Clarification (lines 28-70), existence step (AR-2 + AR-5), precedence rule:
  - Skip `exists` for the user's default (email-named) project.
  - Admins: run `codemie sdk projects exists '<project>'` for any named non-default project.
  - Non-admins: a project listed in `applications` from `users me` needs no `exists` call; for names not in `applications`, run `exists`.
  - On disagreement, `exists` exit 0 wins over absence from `applications` (server-side visibility), and an `exists` exit 2 stops the flow even if `users me` lists it; state this once.
  - Exit 0 proceed; exit 2 tell the user and stop and ask, no retry or loop; exit 1 report as an error (auth/server), never as not found.
- Destructive safety: ask the user before `delete`, `transfer-ownership`, `bulk-remove`; after exit 1 on any mutation check state with `get`/`members` before retrying.
- Quoting: examples single-quote project names; refuse names containing shell metacharacters, explicitly including the single quote `'`.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run

### Task 8: Add `examples/projects.md`

- Create `.../codemie-sdk/examples/projects.md` in the `examples/users.md` format: `## <action>` + bash block + `**JSON fields:**` for all 15 commands, and `## Scripting` with `jq`, including an `exists` exit-code script (0/2/1). Single-quoted project names.

Test-first: no — tests not requested per AGENTS.md; verified by typecheck/lint/build and manual CLI run
