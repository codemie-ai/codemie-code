# Spec: Analytics sync — deliver reports to a team git repository (EPMCDME-16564)

## Intent

Teams that keep AI-usage analytics private, or cannot use Power Automate, need the daily sync to push
each developer's report to a team-owned git repository, reached with the developer's existing git
credentials. CodeMie never asks for or stores a token. The Control Plane harvests the repository later
(EPMCDME-16562). Built on EPMCDME-16488 (`src/cli/commands/analytics/sync/`), which today assumes one
webhook target and one marker.

## Design

**Targets.** Git becomes a second delivery target beside the webhook. Either or both may be configured;
at least one is required. Webhook-only installs keep working unchanged (existing settings files load).

**Settings shape** (`~/.codemie/analytics-sync.json`, 0600) — webhook becomes optional:

```ts
interface SyncSettings {
  webhookUrl?: string;
  git?: { repoUrl: string; branch?: string; path?: string }; // branch unset = remote default branch
  format: 'json';                                            // only 'json' accepted for now
  includeExternal: boolean; at: string; lookbackDays?: number;
}
```

**Per-target markers and windows.** The webhook keeps the collector-compatible
`~/.codemie/analytics-last-sent`. Git gets its own marker file under `getCodemiePath()`. Each target
computes its own window from its own marker, builds its own report, and moves its marker only after its
own successful delivery. A git outage of several days produces one catch-up report covering the whole
missed window (same as webhook behavior today). An empty window commits nothing.

**Git delivery.** Plain `git` via `exec` (`src/utils/exec.ts`), no git library. A persistent shallow
working copy lives under `getCodemiePath()`; before each delivery it is reset hard to the remote branch,
which also recovers a dirty or corrupt copy (re-clone on failure). The report is written to
`<git-path>/<lowercased email slug>/<file name>`; `--git-path` is the parent of the per-developer folder
(default: repository root). File name is the webhook attachment name from `report-builder.ts`:
`codemie-analytics-<slug>-<YYYY-MM-DD>.report.json` — the suffix names the format. The commit author is
the resolved sync email (passed with `-c user.email` / `user.name`). On a rejected push the sync
rebases onto the remote and retries, up to 3 attempts; it only ever adds or changes files inside its
own folder, so other members' files are never overwritten.

**No prompts, ever.** Every git call (install test push, scheduled run, and manual `sync run` alike)
runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, ssh `BatchMode=yes` (the developer's own
ssh config otherwise applies; precedent `src/cli/commands/skills/add.ts:86-90`), and a timeout per call
so a hung git process cannot hang an unbounded scheduler job. An unknown SSH host key fails and the
message explains how to trust the host once.

**Install.** New options `--git-repo <url>`, `--git-branch <name>`, `--git-path <dir>`,
`--format <json>`. Validation is pure and runs before any scheduler mutation. It rejects: neither
target given; an absolute `--git-path` or one escaping the repo (`..`); a repo URL with embedded
credentials (`user:token@`); a format other than `json`. With a git target, install clones and
commits and pushes a small placeholder file in the developer's folder, prompt-free, *before*
registering the job. On failure nothing is registered or written, and the message names the likely
cause (auth rejected, host key unknown, repo unreachable, branch protected) and the fix.

**Install-command builder.** A pure exported function builds the `codemie analytics sync install ...`
command line from webhook and/or repository (+ branch, path, schedule options), quoting values safely.
`bootstrap` (EPMCDME-16487) reuses it later; no bootstrap command is added here.

**Run log and exit code.** One log line per target per run, carrying the target id plus the existing
`ok sent|skip|fail <category>` grammar. `status.ts#parseLastRun` must still read lines written by the
previous single-target version. Exit code is 1 if any target fails, 0 otherwise.

**Status.** For a git target shows the repository (credentials redacted), branch/path, last successful
push (git marker), and last failure (from log). The disabled-state hint and `SyncTargetMissingError`
mention both `--webhook` and `--git-repo`.

**Uninstall.** Removes settings, the OS job, and the git working copy. Markers and log are kept
(existing convention, `uninstall.ts` header).

## Acceptance criteria

- AC1: `codemie analytics sync install --help` lists `--git-repo`, `--git-branch`, `--git-path`, `--format` next to `--webhook`; install with neither target fails with a `SyncConfigError` before touching the scheduler.
- AC2: Install with `--git-repo` performs a prompt-free test push of a placeholder file in the developer's folder before registering; on failure nothing is registered or written and the likely cause is printed.
- AC3: Install rejects an absolute or escaping `--git-path`, a credential-bearing repo URL, and any `--format` other than `json`, before touching the scheduler.
- AC4: With a git target, `sync run` (scheduled or manual) commits the report to `<git-path>/<email-slug>/codemie-analytics-<slug>-<date>.report.json` on the configured or default branch and pushes with the developer's own credentials; no token is requested or stored.
- AC5: When the remote moved, the sync rebases and retries up to 3 attempts; other members' files are never modified.
- AC6: Pushes still rejected after the retry limit log the git target as failed; its marker does not move.
- AC7: With both targets, both receive the report; each marker moves only after its own successful delivery.
- AC8: Missing or rejected credentials, unknown host key, or unreachable repo fail at once without any prompt; the git marker does not move, the webhook still delivers, and the next run re-sends the missed window to git.
- AC9: An empty window commits nothing to the repository.
- AC10: `sync status` shows the repository (no credentials), its last successful push and its last failure.
- AC11: The install-command builder emits a valid install command for webhook-only, git-only, and both.
- AC12: `uninstall` removes the local working copy together with settings and the OS job.
- AC13: Existing webhook-only settings files, markers, and run logs keep working unchanged.

## Non-goals

- No `codemie analytics sync bootstrap` command (EPMCDME-16487); only the reusable command builder.
- No flattened-OTel export (EPMCDME-16561); `format` accepts only `json`.
- No creating or provisioning team repositories, or granting access.
- No read-isolation between members of one repository; no encryption of files.
- No git host REST APIs; no git client library.
- No harvesting in the Control Plane (EPMCDME-16562).
- No interactive git at any point, including install.
- No storing tokens or credential-bearing URLs.
- No change to webhook delivery behavior or its marker path.

## Left to the builder

Marker file name for git, working-copy directory name, per-call timeout values, exact log-line shape
(within the back-compat constraint), placeholder file name, error class names, and redaction of
`user:token@` in `redact.ts`.
