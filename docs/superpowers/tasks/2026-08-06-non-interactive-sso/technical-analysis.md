# Technical Research

**Task**: sso auth non-interactive readline
**Generated**: 2026-08-06T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-13953 (Bug): CLI non-interactive SSO failure hangs and crashes instead of failing cleanly.

Description: When the CodeMie CLI has no valid SSO credentials and is executed in a non-interactive environment, it attempts to prompt for re-authentication. Since no TTY is available, the process hangs and may crash with `Error [ERR_USE_AFTER_CLOSE]: readline was closed` when killed. This breaks automation and CI-like usage.

Preconditions:
- CodeMie CLI is installed.
- Local SSO session is missing or expired.
- Command is run in a non-interactive shell or automation environment without an attached TTY.

Steps to Reproduce:
1. Ensure local CodeMie CLI SSO credentials are missing or expired.
2. Run a CodeMie CLI command in a non-interactive shell.
3. Observe message: 'No valid SSO credentials found.'
4. CLI attempts prompt: 'Re-authenticate now? (Y/n).'
5. Because no input can be provided, the process hangs.
6. Terminate the process.
7. Observe crash/error such as: 'Error [ERR_USE_AFTER_CLOSE]: readline was closed.'

Expected Result:
- CLI detects non-interactive environment.
- CLI fails fast with a clear actionable message, e.g. 'No valid SSO credentials found. Please run codemie setup interactively before using this command.'
- No interactive prompt is attempted when stdin is not a TTY.
- No readline crash occurs.

Actual Result:
- CLI attempts interactive re-authentication prompt.
- Process hangs in non-interactive context.
- Process may crash with ERR_USE_AFTER_CLOSE when terminated.

Affected Areas: CodeMie CLI authentication flow, SSO credential validation, Non-interactive/automation usage, CLI error handling.

Acceptance Criteria:
- CLI detects non-interactive execution reliably.
- Missing/expired SSO credentials in non-interactive mode produce a clean non-zero exit.
- Error message explains how to authenticate before retrying.
- Optional --non-interactive or equivalent behavior is documented.
- No readline crash occurs when authentication cannot proceed.
- Regression tests cover interactive and non-interactive authentication paths.

---

## 2. Codebase Findings

### Existing Implementations

- `src/providers/plugins/sso/sso.setup-steps.ts:263-311` — `SSOSetupSteps.promptForReauth(config)`. This is the **exact root cause**: it unconditionally calls `inquirer.prompt([{ type: 'confirm', name: 'confirm', message: 'Re-authenticate now?', default: true }])` with no TTY / non-interactive guard. The prompt message matches the ticket's reproduction step verbatim ("Re-authenticate now?"). `inquirer` opens a `readline` interface on `process.stdin` internally; when stdin is not a TTY (piped/closed), the prompt never resolves (hang), and killing the process mid-prompt surfaces as `ERR_USE_AFTER_CLOSE: readline was closed`.
- `src/providers/plugins/sso/sso.setup-steps.ts:221-261` — `validateAuth(config)`. Checks stored credentials via `CodeMieSSO.getStoredCredentials()` and tests API access via `fetchCodeMieModels`. Returns `{ valid: false, error }` on missing/expired credentials — this is the trigger that leads into `promptForReauth`.
- `src/providers/core/auth-validation.ts:1-35` — `handleAuthValidationFailure(validationResult, setupSteps, config)`. The **shared gate** invoked by all callers on auth failure: if `setupSteps?.promptForReauth` exists it is called unconditionally; otherwise it prints the error and returns `false`. Any fix must live here (or be checked before this call) to cover every caller uniformly.
- `src/agents/core/AgentCLI.ts:154-289` (`handleRun`) — the **primary CLI entry point** used by every agent binary (`bin/codemie-claude.js`, `bin/codemie-codex.js`, `bin/codemie-claude-acp.js`, etc.). Lines 267-289 call `setupSteps.validateAuth(config)` then, on failure, `handleAuthValidationFailure(...)`; if re-auth fails/declines it does `process.exit(1)` — the intended clean-failure path, but currently unreachable in non-interactive mode because the prompt hangs first.
  - Notably, `handleRun` already computes `const isNonInteractiveMode = !!options.task;` at line 171 for a *different* purpose (auto-enabling silent mode) but this signal is **not** threaded down into the auth-validation block 96 lines later — an existing non-interactive signal that isn't reused where it's needed.
- `src/utils/auth.ts:1-77` — `getAuthenticatedClient(config)` / `promptReauthentication(config)`. A second call path (used by `assistants/chat`, `assistants/setup`, `skills/setup`, `sdk/utils/cli-utils.ts`) that also funnels into `handleAuthValidationFailure`. On failure it throws `ConfigurationError('Authentication expired. Please re-authenticate.')` — already a clean-ish exit, but only reached *after* the hang if `promptForReauth` doesn't guard non-interactive first.
- `src/cli/commands/profile/index.ts` — third caller of `handleAuthValidationFailure` (per codegraph blast-radius; not read in full, same shared-gate pattern applies).
- `src/providers/plugins/jwt/jwt.setup-steps.ts:144-181` — JWT's `validateAuth` returns `{ valid: false, error }` on missing/expired token but **does not implement `promptForReauth`**. Because `handleAuthValidationFailure` checks `setupSteps?.promptForReauth` before calling it, the JWT path already fails cleanly today (prints error, returns `false`) — this is the precedent/pattern the SSO fix should converge toward for non-interactive mode.
- `src/providers/plugins/sso/sso.auth.ts` — `CodeMieSSO.authenticate()` drives the actual browser-based OAuth flow (`startLocalServer`, `waitForCallback`) invoked only after the user confirms re-auth; not itself interactive-prompt related but downstream of `promptForReauth`.

### Architecture and Layers Affected

- **CLI Layer** (`src/agents/core/AgentCLI.ts`, `src/cli/commands/profile/index.ts`) — entry points that call into auth validation before running an agent or executing a profile command.
- **Provider Plugin Layer** (`src/providers/plugins/sso/sso.setup-steps.ts`, `src/providers/plugins/jwt/jwt.setup-steps.ts`) — implements `ProviderSetupSteps.promptForReauth` per-provider; SSO is the only provider with an interactive re-auth flow today.
- **Provider Core Layer** (`src/providers/core/auth-validation.ts`, `src/providers/core/types.ts`) — shared `handleAuthValidationFailure` orchestration and the `ProviderSetupSteps` / `AuthValidationResult` / `AuthStatus` contracts.
- **Utils Layer** (`src/utils/auth.ts`) — secondary orchestration path for assistants/skills commands, reuses the same shared gate.

### Integration Points

- `handleAuthValidationFailure` is the single choke point through which **3 distinct call sites** (`AgentCLI.handleRun`, `src/cli/commands/profile/index.ts`, `src/utils/auth.ts getAuthenticatedClient`) reach `promptForReauth` — a fix placed only in `AgentCLI.ts` would leave the `profile` and `assistants/skills` command paths still vulnerable to the hang.
- `promptForReauth` internally calls `CodeMieSSO.authenticate()` (browser-based OAuth flow with a local callback server) — unrelated to the hang itself but is the "happy path" continuation after a user confirms.
- `inquirer` (third-party) owns the `readline` interface responsible for the crash; no project-owned `readline` module usage was found anywhere in the codebase (a direct `readline` search returned no results), so the fix must prevent `inquirer.prompt()` from ever being invoked in non-interactive contexts rather than patch a readline instance directly.

### Patterns and Conventions

- `ProviderSetupSteps` (`src/providers/core/types.ts:319-397`) is the interface contract every provider implements; `promptForReauth?(config): Promise<boolean>` is optional — omitting it (as JWT does) is itself a valid "no interactive re-auth" pattern already used in the codebase.
- Existing (unrelated) TTY-detection precedent: `src/cli/commands/shared/selection/interactive-prompt.ts:34,66` and `src/cli/commands/shared/agent-targets.ts:177,207` guard `process.stdin.setRawMode(true/false)` calls with `if (process.stdin.isTTY)` before entering custom keypress-driven UIs. These are a different interaction style (raw-mode keypress selectors, not `inquirer`) but establish `process.stdin.isTTY` as the codebase's existing convention for TTY detection — there is no centralized `isInteractive()`/`isNonInteractive()` utility today; each call site checks `process.stdin.isTTY` ad hoc.
- `AgentCLI.handleRun` already derives an `isNonInteractiveMode` boolean from the `--task` CLI flag (line 171) for silent-mode purposes — a reusable signal/convention that is not currently wired into the auth-failure branch.
- Error/exit convention in `AgentCLI.handleRun`: config/auth failures print a `chalk.yellow`/`chalk.red` message via `console.log`/`console.error` and call `process.exit(1)` — this is the established "clean failure" pattern the fix should follow for the non-interactive case (matches the ticket's expected message style: `console.log(chalk.yellow('\n⚠️  Authentication required\n')); process.exit(1);` already exists right after the `handleAuthValidationFailure` call at `AgentCLI.ts:279-282`, but is unreachable while the prompt is hung).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` — covers SSO under "Authentication Patterns": credentials stored in `CredentialStore` with auto-refresh; on SSO token expiry the documented remediation is "No — re-run `codemie setup`" (table row: `SSO token expired | No — throw ConfigurationError`). This documented behavior (throw, don't retry/prompt) is inconsistent with the current `promptForReauth` implementation, which retries interactively instead of throwing — the guide already implies the fail-fast behavior the ticket is asking for.
- Other P0/P1 guides exist (`architecture/architecture.md`, `development/development-practices.md`, `standards/code-quality.md`, `security/security-practices.md`, `testing/testing-patterns.md`, `standards/git-workflow.md`, `usage/project-config.md`, `quality-gates.md`, `project.md`) but were not loaded in full since `external-integrations.md` (P0 for `sso`/`auth` keywords per the Task Classifier) already surfaced the directly relevant convention; consult `development-practices.md` for error-class conventions and `testing-patterns.md` for Vitest/mocking patterns before implementing.

### Architectural Decisions

- No explicit ADR found for non-interactive/TTY handling in SSO auth. The closest documented decision is the `external-integrations.md` troubleshooting table entry ("SSO auth fails → Expired token → `codemie setup` to refresh"), which implicitly favors fail-fast + explicit re-run over in-flow interactive prompting.

### Derived Conventions

- Because no non-interactive detection utility exists, the implementation will need to introduce one (e.g., `!process.stdin.isTTY` combined with existing `--task`/`isNonInteractiveMode` semantics from `AgentCLI.ts`), and should centralize it (e.g., in `src/providers/core/auth-validation.ts` or a new shared util) so all three callers of `handleAuthValidationFailure` benefit uniformly rather than duplicating a check inside `sso.setup-steps.ts` alone.
- The JWT provider's omission of `promptForReauth` is a de facto convention for "provider has no interactive re-auth" — the SSO fix can follow the same shape by making `promptForReauth` a no-op (return `false` immediately) when non-interactive, letting `handleAuthValidationFailure`'s existing fallback branch (`console.log(chalk.red(...)); return false;`) produce the clean, actionable message already in place.

---

## 4. Testing Landscape

### Existing Coverage

- None found. Codegraph's blast-radius analysis flags **every symbol in the affected call chain** as having no covering tests: `SSOAuthConfig`, `SSOAuthResult`, `AuthValidationResult`, `AuthStatus`, `handleAuthValidationFailure` (`src/providers/core/auth-validation.ts:22`), `getAuthenticatedClient` and `promptReauthentication` (`src/utils/auth.ts:22,63`), and `AgentCLI` itself. No `*.test.ts` files were surfaced for `sso.setup-steps.ts`, `auth-validation.ts`, `AgentCLI.ts`, or `utils/auth.ts`.

### Testing Framework and Patterns

- Vitest is the project-wide test framework (per `package.json` scripts and `.ai-run/guides/testing/testing-patterns.md`, not loaded in detail here — consult it directly for dynamic-import mocking conventions before writing tests, since `AgentCLI.handleRun` uses dynamic `await import(...)` for `ProviderRegistry` and `handleAuthValidationFailure`, which typically requires the project's established dynamic-import mocking pattern).

### Coverage Gaps

- `promptForReauth` (SSO) — no test exercises the TTY vs non-TTY branches.
- `handleAuthValidationFailure` — no test covers the "no promptForReauth available" fallback vs "promptForReauth exists" branch.
- `AgentCLI.handleRun` auth-validation block (lines 267-289) — no test covers the `validateAuth` failure → `process.exit(1)` path at all, interactively or non-interactively.
- `getAuthenticatedClient` / `promptReauthentication` (`src/utils/auth.ts`) — no test covers the SSO-expired-credentials re-auth branch used by assistants/skills commands.
- This is a direct, explicit acceptance criterion gap: "Regression tests cover interactive and non-interactive authentication paths" currently has zero existing coverage to build from — tests will need to be authored from scratch, including `process.stdin.isTTY` mocking.

---

## 5. Configuration and Environment

### Environment Variables

- No existing env var governs non-interactive/TTY behavior in the auth path. Related env vars found nearby: `CODEMIE_JWT_TOKEN`, `CODEMIE_AUTH_METHOD` (set/read in `AgentCLI.handleRun` for JWT overrides), `CODEMIE_DEBUG` (gates verbose stack-trace logging in `sso.models.ts`), `CODEMIE_INSECURE` (SSL verification toggle in `src/utils/auth.ts`). None of these currently signal "non-interactive."
- Standard `CI`/`process.stdout.isTTY`/`process.stdin.isTTY` detection is used elsewhere in the CLI only for raw-mode keypress UIs (see Patterns section) — not for `inquirer`-based prompts, and not exposed as a reusable helper.

### Configuration Files

- `src/env/types.ts` — `ProviderProfile` / `CodeMieConfigOptions` (the persisted profile shape) has no `nonInteractive` or similar field today; if the ticket's optional `--non-interactive` flag needs to be persisted or profile-scoped, this type would need extending. More likely, per the ticket's phrasing ("Optional --non-interactive or equivalent behavior"), TTY auto-detection (`!process.stdin.isTTY`) is sufficient without a new persisted config field, mirroring the `--task`-implied `isNonInteractiveMode` pattern already in `AgentCLI.ts`.

### Feature Flags and Deployment Concerns

- No feature flag infrastructure was found gating this behavior. The `--task` flag on `AgentCLI` and the `--jwt-token` CLI override are the closest existing "non-interactive mode" signals; a new `--non-interactive` flag (if added) would follow the same commander `.option(...)` registration pattern seen in `AgentCLI.ts:65-83`.

---

## 6. Risk Indicators

- Root cause is precise and isolated: `SSOSetupSteps.promptForReauth` (`src/providers/plugins/sso/sso.setup-steps.ts:268-311`) calls `inquirer.prompt(...)` with no TTY/non-interactive guard — but the **fix must be applied at (or before) the shared `handleAuthValidationFailure` gate** (`src/providers/core/auth-validation.ts:22`), not just in `AgentCLI.ts`, because two other independent call sites (`src/cli/commands/profile/index.ts`, `src/utils/auth.ts:getAuthenticatedClient`) reach the same hang through the same shared function. Fixing only `AgentCLI.handleRun` would leave `profile` and `assistants/skills` commands still vulnerable.
- `inquirer`'s `readline` interface is the crash source, and it is a third-party dependency internal — no project-owned `readline` code exists to patch directly (confirmed via a dedicated codegraph search returning zero results). The fix must prevent `inquirer.prompt()` from being called at all in non-interactive contexts, not attempt to catch/handle the `ERR_USE_AFTER_CLOSE` after the fact.
- Zero existing test coverage across the entire affected chain (`sso.setup-steps.ts`, `auth-validation.ts`, `AgentCLI.ts`, `utils/auth.ts`) — the acceptance criterion "regression tests cover interactive and non-interactive authentication paths" starts from a clean slate, increasing effort and requiring `process.stdin.isTTY` mocking patterns not yet established in the test suite.
- No centralized non-interactive/TTY-detection utility exists; the codebase's only precedent (`process.stdin.isTTY` checks in `interactive-prompt.ts` and `agent-targets.ts`) guards a structurally different interaction style (raw-mode keypress UI, not `inquirer`), so it cannot be reused verbatim — a new shared helper is effectively required to avoid duplicating the check across 3 call sites and 2+ providers.
- An existing but disconnected non-interactive signal (`isNonInteractiveMode` derived from `--task` in `AgentCLI.ts:171`) is computed but not passed into the auth-validation block 96 lines later — a design gap that, if left unaddressed, means even explicitly automation-style invocations (`--task "..."`) would still hit the interactive prompt today.
- JWT's `promptForReauth`-omission pattern is the only in-repo precedent for "no interactive re-auth"; converging SSO's non-interactive behavior to look like JWT's is low-risk but means the fix touches a provider-plugin contract (`ProviderSetupSteps`) shared by every current and future provider — care is needed not to regress the *interactive* re-auth UX for TTY sessions.

---

## 7. Summary for Complexity Assessment

The bug is narrowly caused by `SSOSetupSteps.promptForReauth` (`src/providers/plugins/sso/sso.setup-steps.ts:268-311`) calling `inquirer.prompt()` unconditionally, but the fix's blast radius is wider than one file: the shared orchestration function `handleAuthValidationFailure` (`src/providers/core/auth-validation.ts`) is reached from three independent call sites — `AgentCLI.handleRun` (all agent binaries), `src/cli/commands/profile/index.ts`, and `src/utils/auth.ts:getAuthenticatedClient` (assistants/skills commands) — so a correct fix must guard at or before that shared gate, not patch a single caller. Layers touched: CLI entry layer, provider-plugin layer (SSO setup-steps, and by contract shape all `ProviderSetupSteps` implementers), provider-core shared auth-validation layer, and the `utils/auth.ts` orchestration layer. Expected file-change surface is moderate (4-6 files: `sso.setup-steps.ts`, `auth-validation.ts`, possibly `AgentCLI.ts` to wire an existing-but-unused `isNonInteractiveMode` signal, possibly a new small TTY-detection utility, plus any `--non-interactive` flag wiring).

Technical novelty is low — no new architecture is needed; the fix follows a pattern already present in the codebase (JWT's provider already fails cleanly because it never implements `promptForReauth`; `process.stdin.isTTY` checks already exist for a different interaction style; `AgentCLI` already computes a similar non-interactive signal for silent mode). The main design decision is *where* to centralize the TTY/non-interactive check so all three call sites and all current/future `ProviderSetupSteps` implementers benefit consistently, and what the exact fail-fast message/exit-code contract should be.

Risk is dominated by test-coverage posture, not implementation difficulty: every symbol in the affected chain currently has zero test coverage (confirmed via codegraph blast-radius flags on `SSOAuthConfig`, `SSOAuthResult`, `AuthValidationResult`, `handleAuthValidationFailure`, `getAuthenticatedClient`, `promptReauthentication`), and the ticket explicitly requires regression tests for both interactive and non-interactive paths — this is new test infrastructure (TTY mocking, `inquirer` mocking) rather than an extension of existing patterns. Overall this is a **medium-complexity** bug fix: small, well-understood code change with a clear root cause, but touching a shared multi-caller function and requiring net-new test coverage across an entirely untested auth-validation subsystem.
