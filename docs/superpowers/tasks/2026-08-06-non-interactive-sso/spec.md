# Spec: Fail-fast non-interactive SSO re-authentication

**Ticket**: [EPMCDME-13953](https://jiraeu.epam.com/browse/EPMCDME-13953) (Bug)
**Date**: 2026-08-06
**Complexity**: M (18/36) — see `complexity-assessment.json`

## Problem

When the CodeMie CLI has no valid SSO credentials and runs in a non-interactive environment (no
TTY — CI, automation, scripts), it still attempts to prompt for re-authentication via `inquirer`.
Since `inquirer` opens a `readline` interface on `process.stdin` and no input can ever arrive, the
process hangs indefinitely. Killing it surfaces `Error [ERR_USE_AFTER_CLOSE]: readline was closed`.
This breaks automation and CI-like usage of the CLI.

## Root Cause

`SSOSetupSteps.promptForReauth` (`src/providers/plugins/sso/sso.setup-steps.ts:263-311`) calls
`inquirer.prompt(...)` unconditionally, with no TTY / non-interactive guard.

The fix's blast radius is wider than that one file: `promptForReauth` is invoked from the shared
gate `handleAuthValidationFailure` (`src/providers/core/auth-validation.ts:1-35`), which is itself
reached independently from three call sites:

- `AgentCLI.handleRun` (`src/agents/core/AgentCLI.ts:267-289`) — every agent binary
- `src/cli/commands/profile/index.ts`
- `src/utils/auth.ts:getAuthenticatedClient` (assistants/skills commands)

A fix scoped to only one caller (e.g. `AgentCLI.ts`) would leave the other two paths still
vulnerable to the hang. The fix must therefore live at (or before) the shared
`handleAuthValidationFailure` gate.

`inquirer`'s `readline` interface is a third-party internal — there is no project-owned `readline`
code to patch. The fix must prevent `inquirer.prompt()` from ever being invoked in a non-interactive
context, not attempt to catch/handle `ERR_USE_AFTER_CLOSE` after the fact.

## Design

### 1. New utility: TTY / non-interactive detection

Add `src/utils/interactive.ts`:

```ts
export function isNonInteractiveEnvironment(): boolean {
  return !process.stdin.isTTY;
}
```

Single source of truth for "can we prompt the user right now?". Mockable in tests (no existing
centralized helper exists today — the codebase's only precedent, `process.stdin.isTTY` checks in
`interactive-prompt.ts` and `agent-targets.ts`, guards a structurally different raw-mode keypress
UI and isn't reusable verbatim).

Detection is TTY-only. No new `--non-interactive` CLI flag, and no `CI` env var check — the
ticket's "optional `--non-interactive` or equivalent" acceptance criterion is satisfied by
documenting the auto-detect behavior.

### 2. Guard the shared gate

Modify `handleAuthValidationFailure` (`src/providers/core/auth-validation.ts`): before calling
`setupSteps?.promptForReauth(...)`, check `isNonInteractiveEnvironment()`. When true, skip the
call to `promptForReauth` entirely and fall into the same branch already used when a provider has
no `promptForReauth` at all (the JWT provider's existing pattern) — print the actionable failure
message and return the clean "no interactive re-auth available" result.

This is the single edit that fixes all three call sites and every current/future
`ProviderSetupSteps` implementer at once. None of the three callers need individual changes: they
already handle a failed/`false` result from `handleAuthValidationFailure` correctly today
(`AgentCLI.handleRun` calls `process.exit(1)`; `utils/auth.ts` throws `ConfigurationError`;
`cli/commands/profile/index.ts` follows the same shared-gate pattern).

`sso.setup-steps.ts` itself is unchanged — `promptForReauth` keeps calling `inquirer.prompt()`
unconditionally; it is simply never reached in a non-interactive context because the caller
short-circuits first.

### 3. Message and exit behavior

- **Interactive** (TTY present): unchanged. Prompt still appears; same UX as today.
- **Non-interactive** (no TTY) + missing/expired SSO credentials: clean, actionable message —
  "No valid SSO credentials found. Please run `codemie setup` interactively before using this
  command." (per the ticket's expected result) — followed by a non-zero exit. No
  `inquirer.prompt()` call, no hang, no `ERR_USE_AFTER_CLOSE`.
- **JWT** (and any provider without `promptForReauth`): behavior unchanged — already fails cleanly
  today, since `handleAuthValidationFailure` already skips calling `promptForReauth` when it's
  absent.

### Out of scope

- No new `--non-interactive` CLI flag or `CI` env var detection (explicit decision — TTY check
  only).
- No changes to `sso.setup-steps.ts`'s `promptForReauth` implementation itself, or to the
  browser-based OAuth flow (`CodeMieSSO.authenticate()`) it calls on the happy path.
- No changes to `ProviderProfile` / `CodeMieConfigOptions` persisted config shape.

## Testing

Vitest, per project convention (`.ai-run/guides/testing/testing-patterns.md`). Zero existing test
coverage exists across this entire chain today — all of the following are net-new:

- `isNonInteractiveEnvironment()` — true/false branches via `process.stdin.isTTY` mocking.
- `handleAuthValidationFailure`:
  - TTY present + `promptForReauth` exists → prompt still invoked (interactive UX regression
    guard).
  - TTY absent + `promptForReauth` exists → prompt skipped, clean failure result returned, no
    `inquirer` call.
  - No `promptForReauth` (JWT-style) → unchanged existing behavior.
- `AgentCLI.handleRun` auth-failure branch (lines 267-289): non-interactive + expired/missing SSO
  credentials → exits 1, never hangs, no crash.
- `utils/auth.ts:getAuthenticatedClient` — same non-interactive short-circuit reached via the
  second call path.

## Acceptance Criteria Mapping

| Ticket AC | Satisfied by |
|---|---|
| CLI detects non-interactive execution reliably | `isNonInteractiveEnvironment()` via `process.stdin.isTTY` |
| Missing/expired SSO credentials in non-interactive mode produce a clean non-zero exit | Shared-gate guard + existing `process.exit(1)` / `ConfigurationError` paths, unchanged |
| Error message explains how to authenticate before retrying | Actionable message in the "no interactive re-auth" branch |
| Optional `--non-interactive` or equivalent behavior is documented | Auto-detect behavior documented (README/CLI help as applicable); no flag added |
| No readline crash occurs when authentication cannot proceed | `inquirer.prompt()` never invoked when non-interactive |
| Regression tests cover interactive and non-interactive authentication paths | See Testing section above |
