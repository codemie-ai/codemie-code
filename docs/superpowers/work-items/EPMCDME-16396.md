# EPMCDME-16396 — [CodeMie CLI][Analytics] Allow users to disable analytics globally or for specific projects

**Link:** https://jiraeu.epam.com/browse/EPMCDME-16396
**Type:** Story
**Status:** In Progress
**Assignee:** Oleh Prusak
**Epic:** EPMCDME-12917
**Related:** EPMCDME-16479 (personal subscriptions, split out, Horizon2), EPMCDME-16440 (session classification), EPMCDME-16394 (analytics confirmation, merged as PR #702), EPMCDME-16383 (secret masking in forwarded hooks)

## Description

Provide CLI commands to manage analytics collection after CodeMie analytics has been configured, including when Global scope has already been enabled.

Users must be able to stop analytics collection without removing or reinstalling the CodeMie integration.

_Disabling analytics for personal subscriptions (former AC2) was moved to EPMCDME-16479. It is out of scope here._

## Acceptance Criteria

**AC1 — Disable all analytics**
- Provide a CLI command to stop all analytics collection.
- No Claude Code sessions should send analytics to the CodeMie backend while collection is disabled.
- CodeMie SSO must not be triggered solely for analytics collection.

**AC2 — Disable analytics for a specific project**
- Provide a CLI command to disable analytics for a selected project.
- Analytics for other enabled projects must continue working.
- The exclusion must also be respected when Global scope is enabled.

**AC3 — Persist and display configuration**
- Changes must be saved and applied to subsequent Claude Code sessions.
- Provide a way to view the effective analytics scope, enabled projects, and exclusions.
- Disabled sessions must not trigger analytics forwarding through previously installed global hooks.

**AC4 — Regression coverage**
Verify both disable operations (all analytics and a specific project) under Project and Global scopes, including native Claude Code launches. Verify that disabling one project does not affect other projects and that disabling all analytics stops collection entirely.

**Out of scope:** listing or disabling several analytics configurations at once; personal subscriptions (EPMCDME-16479).

## AC4 — accepted coverage limitation (decided 2026-10-28)

The implementation does not include an automated test that drives a real, native `claude` CLI launch
end-to-end through the hook pipeline. AC4's "including native Claude Code launches" sub-requirement is
instead covered by `claude-code-otlp.disable-matrix.test.ts`, which exercises the full Project/Global ×
disable-all/exclude-one matrix at the `ClaudeCodeOtlpPlugin.processOtlpEvent()` level (with
`ensureOtlpProxy`/`forwardOtlpEventsToSpool`/SSO mocked), not by spawning the real binary.

This was raised during code review and deliberately **not closed with new code**, because such a test
would be a net liability rather than added confidence:

- **Unreliable** — depends on process-startup timing, the installed `claude` CLI version's exact hook
  payload shape, and OS differences; failures would often be unrelated to the gate logic under test.
- **Needs a correctly authenticated `claude` invocation** — requires either a live credential in CI
  (a secrets-handling risk) or mocking the auth path so deeply the test collapses back into the same
  synthetic-payload shape already covered.
- **Slow and brittle** — a real process spawn adds real CI wall-clock time and couples the test to an
  external CLI's evolving behavior, risking false-red noise from changes outside this repo.

The gate logic itself (`evaluateClaudeAnalyticsGate`/`isTracked()`) does not depend on how the hook
process was launched, so the existing coverage is considered sufficient. No native-launch test will be
added for this ticket; verifying a real native launch is left as a manual/out-of-automation-scope step.
See `docs/superpowers/tasks/2026-10-28-epmcdme-16396-analytics-disable/plan.md` ("Known coverage gap").

---

## Pre-run context (from the 2026-10-28 investigation): HYPOTHESES, RE-VERIFY

> **Instruction to the run:** treat every statement below as a lead, not a fact. Stage 1 (tech-analyst) must re-check each one against the **current `origin/main`** and record confirmed / changed / wrong in `technical-analysis.md`. Line numbers may have shifted. Where the code disagrees with this file, the code wins. Note the difference in the plan's `## Clarification assumptions`.

### Goal of the approach (the user's constraint)

Deliver the ACs with the **fewest changes that could break anything**:
- Add new modules and keep edits to existing code to a minimum.
- When the new config is absent, behaviour must be **identical to today**.

### Proposed approach (validate, don't assume)

1. **New CodeMie-owned config file** `getCodemiePath('claude-analytics.json')` holding `{ version: 1, enabled: boolean, excludedProjects: string[] }`.
   - Absent or empty file → defaults (`enabled: true`, `excludedProjects: []`). Corrupt file → fail closed on the hook path; CLI writes refuse to overwrite it.
   - Write atomically (temp file + `rename`).
   - Precedent: `src/agents/core/copilot-connector-scope.ts` (`readCopilotConnectorScope` / `writeCopilotConnectorScope`).
   - **Why not `~/.claude/settings.json`:** its connector has complex backup/strip/conflict logic, `env` values must be strings, and `connect --scope user` resets the allowlist to `[]`, which would wipe exclusions stored there.
2. **One gate.** `ClaudeCodeOtlpPlugin.isTracked` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`, ~line 91) delegates to a new `evaluateClaudeAnalyticsGate(cwd)`. Evaluation order: corrupt config → disabled → project excluded → existing `isProjectTracked(cwd, readAllowlistState())`. Exclusion wins over the allowlist.
   - Reuse `canonicalizePath` / `isPathInside` from `src/agents/core/project-allowlist.ts`.
   - Import the allowlist functions from `./claude-code-otlp.allowlist.js` so the existing `vi.mock` in `claude-code-otlp.plugin.test.ts` keeps working.
3. **New CLI subcommand group** `codemie proxy analytics`: `disable`, `enable`, `exclude [path]`, `include [path]`, `status [--json]`.
   - The path defaults to `resolveProjectRoot()`.
   - Register it in `src/cli/commands/proxy/index.ts`. Do not change existing `connect` / `disconnect` behaviour.
4. **`status`** shows: hooks installed (marker `hook --agent claude-code-otlp` in `~/.claude/settings.json`), scope (use `inferAllowlistScope` added by PR #702), tracked projects, enabled/disabled, exclusions, a corrupt-config warning, and whether the current dir is tracked and why.
5. **Docs:** add a block to `README.md` (the `proxy connect --claude-code-otlp` section) and `docs/COMMANDS.md#claude-code-otlp-analytics`, explaining that `disconnect` uninstalls while `analytics disable` turns analytics off and keeps the hooks.

### Facts observed (re-verify)

| # | Claim | Where to check |
|---|---|---|
| F1 | The gate runs **before** `ensureOtlpProxy`, the SSO check and any spool write (an invariant). So the new rules cover AC1 "no SSO" and AC3 "installed hooks". | `src/agents/core/OtlpAgentAdapter.ts` `processOtlpEvent` (INVARIANT comment) |
| F2 | The hook re-reads `~/.claude/settings.json` on every invocation (file, not process env), so a config file is picked up by the next event, even in running sessions. | `claude-code-otlp.allowlist.ts` `readAllowlistState` |
| F3 | OTel-only sessions are never sent; only sessions with hook data are. So a blocked hook path also stops OTel data. | `src/providers/plugins/sso/proxy/plugins/otlp-spool/completeness-gate.ts` |
| F4 | `codemie hook` startup runs migrations and the update check only, with no SSO before `processOtlpEvent`. A running daemon only re-reads stored credentials and never starts an interactive login. | `bin/codemie.js`, `src/cli/commands/hook.ts`, `otlp-spool/auth-state.ts` |
| F5 | Under Global (`[]`), `disconnect --scope project` is a noop ("all projects are tracked"), which is the AC2 gap. | `src/cli/commands/proxy/connectors/claude-code-otlp.ts` `removeClaudeCodeOtlpConfig` |
| F6 | `connect --scope user` writes allowlist `[]` (resets the project list). | same file, `writeClaudeCodeOtlpConfig` |
| F7 | Managed `codemie claude` sessions also load `~/.claude/settings.json` hooks, so the gate applies to them too. `claude-code-otlp` has no `CODEMIE_SESSION_ID` guard (unlike `copilot-cli-otlp`). | `src/agents/plugins/claude/` (no `CLAUDE_CONFIG_DIR` override), `copilot-cli-otlp.plugin.ts` |
| F8 | Env reaching hook subprocesses (isolated `claude -p` probe, Claude Code 2.1.312): shell env and settings `env` ✔; `OTEL_*` ✘ (stripped). | probe result, not in the repo |
| F9 | PR #702 (EPMCDME-16394) is merged into `main`. It touched `claude-code-otlp.allowlist.ts` (`AllowlistScope`, `inferAllowlistScope`), `connectors/claude-code-otlp.ts`, `proxy/index.ts` (`--silent`), and added `claude-code-otlp-flow.ts` and `prompts/analytics-confirmation.ts`. Its AC6 explicitly defers a status command as a "separate follow-up", which is AC3 here. | `git log origin/main`, PR #702 |

### Open decisions (ask the user in Stage 2 if still open, ≤3 questions)

1. **Managed-session sync channel.** `codemie claude` (provider `ai-run-sso`) also sends `/v1/metrics` and `/v1/conversations` through `src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.ts`, bypassing hooks.
   - An existing switch already covers it: `isSyncEnabled()` reads `CODEMIE_SESSION_SYNC_ENABLED` or the profile's `session.sync.enabled`.
   - Disabling it also stops the conversation history in the CodeMie UI.
   - **Recommendation: out of scope** (the ticket targets configured hook analytics), pending PO confirmation. If it is ruled in scope, AC1 and AC2 are not complete without it.
2. **`connect` after `disable`.** Recommended: `connect` does not touch `claude-analytics.json`, so analytics stays disabled. `status` shows this, and `enable` turns it back on.
3. **Preferences survive `disconnect`.** Recommended: yes, the file is not deleted.

### Constraints for the run

- Do not modify: `OtlpAgentAdapter.processOtlpEvent`, the daemon/spool/completeness gate, the backup/strip/merge logic in `connectors/claude-code-otlp.ts`, `native-loader.ts`, `--include-external`, or Copilot connectors.
- Follow AGENTS.md: ESM `.js` imports, `@/` alias, no `any`, `ConfigurationError`, `logger.debug` + `sanitizeLogArgs`.
- Tests are required by AC4, so writing and running them is in scope. `vitest.config.ts` isolates `CODEMIE_HOME`.
- **Git:** at investigation time the checkout was on an unrelated branch (`EPMCDME-15411_global-profile-identity-isolation`). Branch `EPMCDME-16396` from a **freshly fetched `origin/main`**. AGENTS.md allows git operations only on explicit user request, so confirm with the user before creating the branch and before the first commit.
- Edge cases to cover:
  - Windows path casing, trailing slash, and the sibling-prefix case (`/repo` vs `/repo2`);
  - `cwd` undefined → not excluded;
  - a corrupt config file;
  - `exclude` run twice → a single entry;
  - `include` of a path that is not excluded → "Nothing to change.";
  - exclusions survive `connect --scope user` and `disconnect`.

### Reference material (historical; AC2/personal parts are superseded by EPMCDME-16479)

- `docs/superpowers/specs/2026-10-28-epmcdme-16396-analytics-disable-investigation.md`
- `docs/superpowers/plans/2026-10-28-epmcdme-16396-analytics-disable.md`: Tasks 1, 3–6 apply, minus everything personal/subscription-related. **Do not execute this plan directly.** sdlc-light must write its own plan from fresh research.
