# Spec: `codemie sdk projects` CLI and codemie-sdk skill update (EPMCDME-16734)

Story: `story.md` (approved; its acceptance criteria are the definition of done). Research: `technical-analysis.md`. Architecture review: `arch-review/arch-review-brief.local.md` (AR-1..AR-4 applied below).

## Goal

Add a `codemie sdk projects` command group over `client.projects` (Node SDK PR #54, unreleased) and update the codemie-sdk skill so agents confirm a named project exists before creating or changing assets.

## Approach

Follow the existing group pattern (`src/cli/commands/sdk/skills.ts`, `users.ts`): one `projects.ts` exporting `createProjectsSubcommand()`, a thin `services/projects.ts` (`(client, ...) => client.projects.<method>()`), registered in `index.ts` (also add "projects" to its description string). Each action: `getSdkClient()`, spinner, service call, `--json` ? `outputJson` : `printTable`/`printDetail`, catch -> error handling below. `utils/cli-utils.ts` is not modified.

Only `services/projects.ts` imports PR #54 types from `"codemie-sdk"`; it re-exports what `projects.ts` needs, so a type change in the SDK touches one file.

### Commands (all take `<name>` project argument unless noted)

| Command | SDK method | Notes |
|---|---|---|
| `list` | `listProjects` | `--search`, `--page` (0-based, default 0), `--per-page` (default 10), `--sort-by name\|created_at`, `--sort-order asc\|desc`; `--json` outputs the raw `{data, pagination}` |
| `get <name>` | `getProjectDetail` | detail view including members |
| `exists <name>` | `getProjectDetail` | success only checks; see exit codes |
| `members <name>` | `getProjectDetail` | view of `get`, stated in its help; prints only `members` (no SDK members method) |
| `create` | `createProject` | `--data <json>` or `--json <file>` via `parseDataOrJsonFile`; prints the response |
| `update <name>` | `updateProject` | same input convention; prints the response |
| `delete <name>` | `deleteProject` | |
| `transfer-ownership <name> <userId>` | `transferOwnership` | |
| `assign <name> <userId>` | `assignUserToProject` | `--admin` flag |
| `update-member <name> <userId>` | `updateUserProjectAssignment` | `--admin` / `--no-admin`, one required |
| `remove-member <name> <userId>` | `removeUserFromProject` | |
| `bulk-assign <name>` | `bulkAssignUsersToProject` | `--file <path>`: JSON array of `{user_id, is_project_admin}` |
| `bulk-remove <name> <userIds...>` | `bulkRemoveUsersFromProject` | variadic user ids |
| `csv-validate <name> <csvPath>` | `validateUsersFromCsv` | reads file to Buffer, filename = `basename(csvPath)` |
| `csv-import <name> <csvPath>` | `importUsersFromCsv` | same |

`--json` on read/action commands is a boolean output flag, as in existing groups; only create/update reuse `--json <file>` as an input per the existing `parseDataOrJsonFile` convention. In `--data`/`--json <file>` input mode their output is the response as JSON (AR-4), so scripts can read the created or updated project. SDK limits (bulk-assign 1..1000, bulk-remove 1..100) surface as `ZodError` through `handleSdkError`; no extra client-side validation.

### Exit codes and not-found handling

One rule, decided in one place (`projects.ts`): a helper treats a 404 `ApiError` (`statusCode ?? status` === 404) from `getProjectDetail` as "project not found or not accessible". The exit code is a single constant `PROJECT_NOT_FOUND_EXIT_CODE = 2` defined once in `projects.ts`; the skill docs cite it as a documented value (0 ok, 2 not found or not accessible, 1 error).

- `exists`, `get`, `members`: success -> normal output (`exists` prints "exists"), exit 0. 404 -> prints "Project '<name>' not found or not accessible" to stderr, exit 2. Any other error (401/403, 5xx, network) -> `handleSdkError`, exit 1, never read as not found. `exists --json` prints `{"name": ..., "exists": bool}` with the same exit codes.
- `projectExists` is not used: its behaviour on non-404 errors is known only from the PR diff, and a shared `getProjectDetail` + 404 branch keeps `exists` and `get` identical by construction.
- Exit 2 is chosen because no code other than 0/1 has precedent in `src/cli` and 1 is already every error.
- Mutating commands use `handleSdkError` as-is (its generic 404 text stands; sub-route 404s cannot distinguish project from user, noted in the command help). Shared `handleSdkError` is untouched.

### Destructive actions

No CLI confirmation prompt and no `--yes` flag: existing groups have none (`skills.ts:214-228`). The safeguard lives in the skill (AR-3), below.

### Skill (`src/agents/plugins/claude/plugin/skills/codemie-sdk/`)

- `SKILL.md`: add projects to the frontmatter description and the Asset Types list; add a Projects row to the Consult Examples table (`${CLAUDE_PLUGIN_ROOT}/skills/codemie-sdk/examples/projects.md`); add a `## Projects` section modeled on `## Users`.
- Project Clarification gets an existence step (AR-2):
  - The user's default project (the email-named personal project) is not checked: skip `exists` for it, because whether `GET /v1/projects/{name}` serves it to a non-admin is unverified.
  - For any named non-default project, run `codemie sdk projects exists '<project>'` before creating or changing assets. Exit 0: proceed. Exit 2: tell the user the project is missing or not accessible, stop and ask; do not retry or loop. Exit 1: report it as an error (auth or server), never as not found.
- Destructive safety (AR-3): ask the user before `delete`, `transfer-ownership` and `bulk-remove`. After exit 1 on any mutation, check state with `get` or `members` before retrying, since the change may have been applied.
- Examples single-quote project names (`'<project>'`); the skill tells the agent to refuse names containing shell metacharacters.
- New `examples/projects.md` in the `examples/users.md` format (`## <action>` + bash block + JSON fields + Scripting with `jq`, including the `exists` exit-code script).

### SDK dependency and merge condition (AR-1)

The CLI is built against PR #54 types. The PR is opened as a DRAFT and held until the SDK release (EPMCDME-16733, codemie-sdk#54) is published. The requester/owner of this task is the gate owner (parent decision D6). Bumping the `codemie-sdk` range in `package.json` and `package-lock.json` is part of this change's merge condition, done as the first step after the release and before undrafting; it is not an unowned follow-up.

In the working branch `package.json` and `package-lock.json` stay untouched, with a clearly noted placeholder (PR description and a note in the draft) that the bump is pending. Local verification: materialise the PR in `C:\Projects\EPAM\codemie-dev\codemie-sdk` (`gh pr checkout 54 --repo codemie-ai/codemie-sdk`), build `sdk/codemie-nodejs`, then in codemie-code `npm install --no-save <abs path to sdk/codemie-nodejs>` (or `npm pack` + `--no-save <tgz>`). Verify `git status` shows neither manifest modified before committing the working branch.

## Acceptance criteria

Those in `story.md`, concretely:

1. `codemie sdk projects` exposes all 15 commands above; each works in human-readable and `--json` modes, and create/update print the response as JSON in `--json` mode.
2. `exists` on a visible project prints that it exists and exits 0.
3. `exists` on a missing/not visible project prints "not found or not accessible" and exits 2.
4. `get` and `members` on a missing/not visible project print "project not found or not accessible" and exit 2.
5. Auth (401/403) and server errors in any projects command print the usual `handleSdkError` output with exit 1, never "not found".
6. The skill's Project Clarification skips the check for the user's default project, runs `projects exists` for named non-default projects, stops and asks on exit 2 (no looping) and treats exit 1 as an error.
7. The skill asks the user before delete, transfer-ownership and bulk-remove, and checks state with `get`/`members` after exit 1 on a mutation.
8. The skill lists projects in Asset Types and Consult Examples, and `examples/projects.md` exists.
9. With the PR #54 build installed locally via `--no-save`, `npm run typecheck`, `npm run lint` and `npm run build` pass and the working branch leaves `package.json` and `package-lock.json` unchanged. The merge condition is: PR is draft until the SDK release is published, then the `codemie-sdk` range bump in `package.json` + lockfile is the first step and these checks pass against the released version before undrafting.

## Non-goals

- No new tests (AGENTS.md: tests only on explicit request; none was requested).
- No SDK changes, no SDK parity guide, no User admin methods from PR #54.
- No change to shared `handleSdkError` or other groups' behavior.
- No `codemie-sdk` version bump, link, file or tarball dependency committed in the working branch before the SDK release.
- No CLI confirmation prompts or `--yes` flag.
- No CLI for services that exist only in Python.
- No client-side re-validation of SDK limits.

## Decisions

- `exists` via `getProjectDetail` + 404 branch over `projectExists`: one not-found rule shared with `get`, and non-404 behaviour of `projectExists` is unverified.
- Exit code 2 for not found over another value or reusing 1: no precedent beyond 0/1, and 1 must stay distinguishable for auth/server errors.
- Exit 2 for `get`/`members` not-found as well, over exit 1: one constant defined once, one rule in one place.
- Local 404 helper in `projects.ts` over changing shared `handleSdkError`: avoids altering every group.
- Only `services/projects.ts` imports PR #54 types, over importing them in command code: limits SDK-change blast radius.
- Skill skips the `exists` check for the email-named default project over checking it: visibility via `GET /v1/projects/{name}` is unknown — user.
- Skill stops and asks after exit 2, no retry loop, over retrying: avoids agent loops — user.
- PR held as DRAFT until the SDK release, with the range bump as the first post-release step, over merging with an unowned follow-up; requester is gate owner — user.
- Skill-level confirmation ask for delete/transfer-ownership/bulk-remove over a CLI `--yes` flag or prompt: existing groups have none — user.
- Create/update print the response as JSON over printing nothing in `--json` mode — user.
- `members` as a view of `getProjectDetail` over a new SDK call: the SDK has no members method.
- Bulk-assign input via `--file <json path>` over inline `--data`: up to 1000 entries is unwieldy inline.
- Bulk-remove ids as variadic arguments over a file: limit is 100 and ids are short.
- CSV commands take a file path argument over inline CSV or stdin: the SDK wants a Buffer plus filename.
- Command names kebab-case verbs over nested subgroups: matches the flat style of existing groups.
- Single-quoted project names in skill examples over double quotes — user.

## Open risks

- PR #54 may change before merge; signatures here come from `gh pr diff 54`, and the PR code is not in the local SDK checkout.
- Whether the email-named personal project is visible via `GET /v1/projects/{name}` stays unverified; it is skipped, not resolved.
- The 404 mapping and exit codes go untested (no tests per AGENTS.md); verify manually the three cases: real 404, bad token, unreachable host.
- Sub-route 404s (assign, import) cannot tell project from user not found.
- Typecheck/build fail on CI until the SDK is released and the range is bumped; the draft state covers this.
