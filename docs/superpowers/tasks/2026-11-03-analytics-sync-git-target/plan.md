# Analytics sync git target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a team git repository as a second `codemie analytics sync` delivery target beside the webhook (EPMCDME-16564).

**Architecture:** Plain `git` through `exec` (`src/utils/exec.ts`) wrapped in a prompt-free client. A `GitTarget` keeps a shallow working copy under `getCodemiePath()`. `runSync` loops over the configured targets, each with its own marker, window, report and log line. Every runner keeps the injected-`*Deps` pattern.

**Tech Stack:** TypeScript ESM, Node >= 20, Vitest, commander.

**Spec:** `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/spec.md`

Commit per task using the repository's existing convention. All paths are relative to `src/cli/commands/analytics/sync/` unless they start with `src/`, `tests/` or `docs/`.

## Global Constraints

- No git library, no git host REST API, no `bootstrap` command, no OTel export. `format` accepts only `json`.
- Every git call runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and ssh `BatchMode=yes`, plus a per-call timeout. This applies to install, scheduled runs and manual runs alike.
- No token is ever requested or stored. Install rejects repo URLs with `user:token@`, and all output redacts them.
- Webhook delivery, its marker `~/.codemie/analytics-last-sent` and existing settings files/logs work unchanged (AC13).
- Git writes only inside `<git-path>/<lowercased email slug>/`.

## Review Focus

- An existing `GIT_SSH_COMMAND` or `core.sshCommand` must be kept. Append `-o BatchMode=yes` rather than replacing it (Task 2 test).
- Re-sending an identical report gives "nothing to commit". Treat that as delivered, not failed (Task 3 test).
- A dirty or corrupt working copy, or one whose remote URL differs from settings, is re-cloned (Task 3 test).
- A failed install test push leaves no working copy, no settings and no job (Task 6 test).
- A legacy log line with no target id still parses as the webhook's last run (Task 5 test).

---

### Task 1: Settings shape, validation, redaction

**Files:** Modify `types.ts`, `config-store.ts:107-175`, `redact.ts:16`, `src/utils/errors.ts:50-110` (`SyncTargetMissingError`). Test `__tests__/config-store.test.ts`, `__tests__/redact.test.ts`.

**Interfaces:**
- Produces: `SyncSettings` exactly as in spec "Settings shape". `GitSettings { repoUrl: string; branch?: string; path?: string }`. `InstallOptions` gains `gitRepo?`, `gitBranch?`, `gitPath?`, `format?` (strings).

Test-first: yes — a test where `validateInstallOptions({})` throws `SyncConfigError` naming `--webhook` and `--git-repo`; this fails today because only `--webhook` is required.

- [ ] Write failing tests. Neither target given throws. `--git-path /abs`, `C:\x` and `a/../..` throw. `https://u:t@host/r.git` throws. `--format otel` throws. Git-only validates to `{ git: { repoUrl }, format: 'json' }`. A legacy settings file without `format` or `git` loads with `format: 'json'`. A file with neither target loads as `null`. `redactSecrets('https://u:t@h/r')` gives `https://***@h/r`.
- [ ] Implement. Normalise `path` to a posix relative path. `SyncTargetMissingError` text names both `--webhook <url>` and `--git-repo <url>`. Make webhook optional everywhere `webhookUrl` was assumed (`format.ts`, `install.ts` summary).
- [ ] Run `npx vitest run src/cli/commands/analytics/sync/__tests__/config-store.test.ts src/cli/commands/analytics/sync/__tests__/redact.test.ts`. Expect PASS.

### Task 2: Prompt-free git client

**Files:** Create `targets/git-client.ts`, test `targets/__tests__/git-client.test.ts` (or `__tests__/git-client.test.ts`, matching the existing layout). Add `SyncGitError` to `src/utils/errors.ts`.

**Interfaces:**
```ts
export type GitFailureCause = 'auth' | 'host-key' | 'unreachable' | 'rejected' | 'protected' | 'timeout' | 'other';
export interface GitRunner { (args: string[], opts: { cwd?: string; network?: boolean }): Promise<string>; }
export function gitEnv(base: NodeJS.ProcessEnv): Record<string, string>;
export function classifyGitError(stderr: string): GitFailureCause;
export function gitHint(cause: GitFailureCause): string; // likely cause + fix, e.g. host-key: "ssh -T <host> once to trust it"
export function createGitRunner(execFn?: typeof exec): GitRunner;
// throws SyncGitError(message, cause: GitFailureCause), message redacted
```

Test-first: yes — `gitEnv({})` returns `GIT_TERMINAL_PROMPT='0'`, `GCM_INTERACTIVE='never'`, `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` and `SSH_ASKPASS_REQUIRE='never'`; `gitEnv({GIT_SSH_COMMAND:'ssh -i k'})` keeps `-i k`; `classifyGitError` maps sample stderrs ("Authentication failed", "Host key verification failed", "Could not resolve host", "[rejected] ... (fetch first)", "protected branch") to their causes.

- [ ] Write failing tests, including a fake `exec` that checks timeouts. Network calls use 120 000 ms. Local calls use 15 000 ms. An `exec` timeout maps to `timeout`.
- [ ] Implement over `exec` from `@/utils/exec.js`. Read `core.sshCommand` via `git config --get` for the base of `GIT_SSH_COMMAND` when the env var is unset.
- [ ] Run the test file. Expect PASS.

### Task 3: Git delivery target

**Files:** Create `targets/git-target.ts`. Test `__tests__/git-target.test.ts` with a fake `GitRunner`, plus `tests/integration/analytics-sync-git-target.test.ts` using local bare repos in a tmp dir (`file://` URL).

**Interfaces:**
- Consumes: `GitRunner`, `SyncGitError` (Task 2), `GitSettings` (Task 1), `SyncReport`.
```ts
export const MAX_PUSH_ATTEMPTS = 3;
export function gitWorkingCopyPath(): string;     // getCodemiePath('analytics-sync-repo')
export function gitMarkerPath(): string;          // getCodemiePath('analytics-last-sent-git')
export class GitTarget {
  readonly id = 'git';
  constructor(git: GitSettings, email: string, run: GitRunner, dir?: string);
  deliver(report: SyncReport): Promise<void>;    // commits <path>/<slug>/<report.fileName>
  testPush(): Promise<void>;                     // commits <path>/<slug>/.codemie-sync-check
}
```

Test-first: yes — the integration test pushes from two clones of one bare repo. Member B pushes first. Then A's `deliver` rebases and succeeds. B's file is unchanged, and A's file sits at `<slug>/codemie-analytics-<slug>-<date>.report.json` on the default branch.

- [ ] Write failing tests. Integration covers the two-member rebase case (AC5), git-path nesting and the default branch when `branch` is unset. Unit tests with a fake runner cover these cases. Push rejected 3 times throws `SyncGitError` cause `rejected` after exactly 3 push calls (AC6). "nothing to commit" resolves. A failed `fetch`/`reset` or a mismatched `remote get-url` triggers `rm -rf` plus re-clone. Commit uses `-c user.email=<email> -c user.name=<email>`.
- [ ] Implement `ensureWorkingCopy`. Clone `--depth 1 [--branch b]`, or else `fetch --depth 1 origin <b>` plus `reset --hard origin/<b>` plus `clean -fdx`. Resolve the default branch from the clone's `HEAD`. Then add only the slug folder, commit and push. On `rejected`, fetch, rebase onto `origin/<b>` and retry. Use `emailSlug` from `report-builder.ts` on the lowercased email.
- [ ] Run both test files. Expect PASS.

### Task 4: Multi-target run

**Files:** Modify `run-sync.ts` (whole runner, `SyncDeps`, `realSyncDeps`), `marker.ts` header comment. Test `__tests__/run-sync.test.ts`.

**Interfaces:**
- Consumes: `GitTarget`, `gitMarkerPath` (Task 3).
- Produces: `type TargetId = 'webhook' | 'git'`. `SyncDeps.send` becomes `deliver(target: TargetId, settings: SyncSettings, email: string, report: SyncReport): Promise<void>`. `readMarker(target, now)` and `writeMarker(target, at)`. The log line is `<ISO> <outcome> <rest> [target=<id>]`. Lines from settings/identity setup failures carry no target.

Test-first: yes — with both targets, the git deliver rejects and the webhook resolves. Then only the webhook marker moves, two lines are emitted (`ok sent … target=webhook`, `fail send … target=git`), and exit is 1.

- [ ] Write failing tests. Each target's window comes from its own marker. An empty window gives `skip … target=git` and no deliver call (AC9). Webhook-only output is identical to today except for the trailing `target=webhook`. Git-only never touches the webhook marker.
- [ ] Implement. Resolve identity once, then loop over the configured targets in order webhook, git. Each target runs window, `buildReport`, deliver, marker move and emit. Exit 1 if any target failed. A git failure maps to category `send`, and the detail carries `gitHint(cause)`.
- [ ] Run the test file. Expect PASS.

### Task 5: Status per target

**Files:** Modify `status.ts:30-150`. Test `__tests__/status.test.ts`.

**Interfaces:** `parseLastRun(log, target: TargetId): LastRun | null`. `StatusDeps.readMarker(target, now)`.

Test-first: yes — a log with a legacy line `… ok sent x.json 10` and then `… fail send auth … target=git` shows the webhook's last run as the legacy line and the git's last failure as the second line.

- [ ] Write failing tests. The git block shows `Repository:` (redacted), branch (`default` when unset), path, `Last successful push` from the git marker and `Last failure` from the log. The disabled hint names `--webhook <url>` and `--git-repo <url>`.
- [ ] Implement. A line without `target=` counts as webhook. Run the test file. Expect PASS.

### Task 6: Install with test push, CLI wiring, docs

**Files:** Modify `install.ts:31-200`, `src/cli/commands/analytics/index.ts:73-135`, `docs/ANALYTICS-REPORT.md:384-530`. Test `__tests__/install.test.ts`, `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts`.

**Interfaces:** `InstallDeps.testGitPush(git: GitSettings, email: string): Promise<void>` and `InstallDeps.removeWorkingCopy(): Promise<void>`. In the real deps, `testGitPush` is `new GitTarget(...).testPush()`.

Test-first: yes — a test where `testGitPush` rejects with `SyncGitError` cause `auth`. Then exit is 1, the output contains `gitHint('auth')`, and `unregister`, `writeSettings` and `register` are never called, while `removeWorkingCopy` is.

- [ ] Write failing tests. Order is validate, preflight, email, collector check, `testGitPush`, unregister, write, register. The summary prints `Repository: <redacted url>`. In the CLI test, `sync install --help` lists `--git-repo <url>`, `--git-branch <name>`, `--git-path <dir>` and `--format <json>` next to `--webhook`. Help texts no longer say "to the team's webhook" only.
- [ ] Implement. Update the docs options table, the state-file table (git marker, working copy) and the no-prompt/host-key note.
- [ ] Run both test files. Expect PASS.

### Task 7: Install-command builder

**Files:** Create `install-command.ts`. Test `__tests__/install-command.test.ts`.

**Interfaces:** `export function buildInstallCommand(opts: { webhook?: string; gitRepo?: string; gitBranch?: string; gitPath?: string; at?: string; lookbackDays?: number; includeExternal?: IncludeExternalPolicy }): string`. It throws `SyncConfigError` when neither target is given.

Test-first: yes — webhook-only, git-only and both each return `codemie analytics sync install …` with single-quoted values. A value containing `'` or a space is escaped POSIX-safe.

- [ ] Write tests, implement, run. Expect PASS. Do not add a `bootstrap` command.

### Task 8: Uninstall removes working copy

**Files:** Modify `uninstall.ts:19-60` (header comment too). Test `__tests__/uninstall.test.ts`.

**Interfaces:** `UninstallDeps.removeWorkingCopy(): Promise<boolean>`. In the real deps this is `rm(gitWorkingCopyPath(), { recursive: true, force: true })`.

Test-first: yes — `runUninstall` calls `removeWorkingCopy` and reports it. Both marker files and the log are not deleted.

- [ ] Write the test, implement, run. Expect PASS.

## Negative-constraint pass

- No bootstrap command: Task 7 adds only the builder.
- No OTel: Task 1 accepts only `json`.
- No git library or REST API: Task 2 uses `exec` only.
- No interactive git, including install: Task 2's env is used by every caller (Tasks 3 and 6).
- No stored tokens or credential URLs: Task 1 rejects them and redacts them, and Tasks 5 and 6 print redacted.
- No webhook behaviour or marker-path change: Task 4 keeps `analytics-last-sent`, and the git marker is a separate file.
- No overwriting other members' files: Task 3 adds only the slug folder and rebases, never force-pushes.
- No provisioning or harvesting: no task.
