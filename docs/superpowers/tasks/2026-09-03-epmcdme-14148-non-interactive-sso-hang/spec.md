# EPMCDME-14148 — Spec

Approved design, bounded path. Grounding: `reproduction.md` (empirical, 4 cases), `technical-analysis.md` (407 lines), `complexity-assessment.json` (M, 19/36).

## Problem

In a non-TTY session with no valid SSO credentials, `codemie sdk <anything>` exits 1 by letting a `ConfigurationError` escape to Node's default handler — printing a raw stack trace — and the message it prints has lost the actionable remediation.

The non-TTY *hang* named in the ticket title is **already fixed** on main by `5b2de4b7` (PR #471). Case C in `reproduction.md` (same command with a TTY blocks; without a TTY it does not) is the control proving that guard is live. What remains is the *quality of the failure*, not the hang.

## Root cause

```
getCodemieClient()                       sdk-client.ts:73-75
  throws ConfigurationError('SSO authentication required. Please run "codemie setup"...')   ← actionable
getAuthenticatedClient() catch           auth.ts:45
  → promptReauthentication()             auth.ts:47
      → handleAuthValidationFailure()    auth-validation.ts:34  → non-TTY: skips prompt, returns false  ✅ PR #471
      → throw ConfigurationError('Authentication expired. Please re-authenticate.')  auth.ts:76  ← shadows the actionable message
getSdkClient()                           cli-utils.ts:15-18  → no try/catch → escapes to Node
```

Two independent defects. Fixing either alone is insufficient: wrapping alone still prints the vague message (`handleSdkError`'s `else` branch already renders `ConfigurationError` cleanly); message-fixing alone still prints a stack trace.

## Scope

**In scope**

1. `sdk/utils/cli-utils.ts` — wrap `getSdkClient()` so auth failures reach the existing `handleSdkError` sink. One edit covers ~50 actions across 8 files (shared-gate precedent from PR #471).
2. `utils/auth.ts` — preserve the actionable upstream error rather than letting `promptReauthentication`'s throw shadow it.
3. `providers/core/auth-validation.ts:39` — diagnostic to **stderr**, not stdout (currently pollutes piped output and `--json`).
4. `utils/sdk-client.ts:26` — no `ora` spinner when non-interactive.
5. `bin/codemie.js` — process-level `unhandledRejection` / `uncaughtException` net (template: `bin/codemie-mcp-proxy.js:75-82`).
6. `docs/AUTHENTICATION.md:104-117` — align documented promise with actual emitted message. **Non-optional**: PR #471 set the precedent, and EPMCDME-13953's CR-001 was closed specifically on this doc surface.
7. Timeboxed AC4 investigation in a real terminal.

**Out of scope**

- Any `--non-interactive` / `--ci` flag. AC3 is worded "supported **or** documented"; `docs/AUTHENTICATION.md:113` already documents the absence as intentional, and EPMCDME-13953's spec lists the flag as an explicit out-of-scope decision. Cite, do not implement.
- The other 45 unguarded `inquirer.prompt` sites across 19 files — same class of latent bug, their own ticket.
- `profile/index.ts:138-140` exiting 0 on declined re-auth — a real inconsistency, but not this defect.
- Reformatting `cli-utils.ts` double quotes (ESLint does not enforce quote style; would balloon the diff).

## Design decisions

**Why wrap at `getSdkClient()` rather than move `await getSdkClient()` inside each action's existing `try`.** The latter is ~50 mechanical edits across 8 files with 50 chances to miss one; a grep confirms all 50 are currently outside their `try`. The gate is one function and matches how PR #471 fixed the sibling defect.

**Why preserve the original error rather than add `cause` or change `promptReauthentication`'s throw.** Three constraints make this the cheapest correct option:

- `ConfigurationError`'s constructor takes only `message` — `cause` would mean touching a repo-wide base class.
- `promptReauthentication`'s declared `Promise<boolean>` is unreachable-`false`; converting its throw to a return would revive dead code and change `assistants/chat/index.ts:423`.
- `auth.test.ts:142-155` asserts that throw's message verbatim. Leaving `promptReauthentication` untouched means **that test keeps passing unmodified** — only the `getAuthenticatedClient` reauth-fails case changes, deliberately.

`no-useless-catch` is an ESLint *warn* under `--max-warnings=0`. Both new catches transform rather than bare-rethrow, so neither trips it.

**Layering.** `utils/` throws; the CLI layer formats and exits (`architecture.md:159-171`). The fix keeps user-facing formatting in `cli-utils.ts` and does not deepen `auth.ts`'s existing chalk-output smell.

## Acceptance

| AC | Disposition |
|---|---|
| Non-TTY stdin skips interactive prompt | Already met (PR #471); covered by regression test |
| CLI exits non-zero with clear remediation | **The fix.** Exit 1, no stack trace, message names `codemie setup` |
| `--non-interactive` / `--ci` supported or documented | Met by existing `AUTHENTICATION.md:113`; cite in MR |
| Kill during prompt → no readline crash | Timeboxed investigation; report "cannot reproduce" if it stays quiet |

## Testing

Unit tests live in `src/**/__tests__/` — **never** `tests/unit/`, where five files match no vitest project glob and silently never execute.

- **New** `src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts` (greenfield — `sdk/**` has zero tests across 22 files). Pattern from `skills/__tests__/commands.test.ts`: `process.exit` spy that records the code then throws.
- **Updated** `src/utils/__tests__/auth.test.ts` — the `getAuthenticatedClient` reauth-fails case now asserts the preserved actionable message.
- **Non-interactivity is injected at the seam** (`vi.mock` the function), not via `process.stdin.isTTY` — per the `auth-validation.test.ts` template.
- **Integration** via `tests/helpers/cli-runner.ts` `runSilent()` with stdin ignored: assert exit ≠ 0, remediation text present, and **no stack trace** in output.

Commit scope must be `fix(cli)` or `fix(utils)` — commitlint's `scope-enum` rejects `fix(auth)` and `fix(sdk)`.
