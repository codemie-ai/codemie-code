# EPMCDME-16396: Disabling analytics (investigation)

Ticket: [EPMCDME-16396](https://jiraeu.epam.com/browse/EPMCDME-16396). This doc checks what already exists and how AC2, AC3 and AC5 could be built. Related tickets: EPMCDME-16394 (consent before proxy), EPMCDME-16440 (classify sessions by subscription, in progress, no code yet), EPMCDME-16390.

## Summary

| AC | Your assumption | Finding |
|---|---|---|
| AC1 Disable all | Already exists as `disconnect` | **Partly.** `codemie proxy disconnect --claude-code-otlp` stops the hook pipeline, but it *uninstalls* the wiring rather than turning it off, and it does not touch the daily collector. |
| AC2 Personal subs | Drop `--include-external` when harvesting | **Wrong.** `--include-external` is about *who launched* the session, not *which account* it used. It also lives in a different tool (the collector) and has no effect on the hook pipeline. |
| AC3 Disable project | Add an exclusion array | **Right direction.** Today you can't exclude a project under Global scope (the command does nothing). |
| AC4 Persist + view | Already in `settings.json` | **Partly.** Settings are saved and picked up live. There's no command to view them, and no on/off flag that installed hooks check. |
| AC5 Regression | n/a | Nothing exists yet. A test matrix is below. |

## How it works today (two separate pipelines)

1. **Hook pipeline (real time).** `codemie proxy connect --claude-code-otlp [--scope user|project]` writes the following into **`~/.claude/settings.json`**: 16 hook events → `codemie hook --agent claude-code-otlp`, the OTEL env vars, and `env.CODEMIE_ANALYTICS_PROJECT_FILTER` (a JSON *string* of absolute paths; `[]` means Global).
   - On every hook call, the hook re-reads that file. The gate is `ClaudeCodeOtlpPlugin.isTracked` → `isProjectTracked` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:91`).
   - The gate runs **before** the daemon starts, the SSO check, and any spool write (an invariant in `src/agents/core/OtlpAgentAdapter.ts:69-80`). This is the single right place to add every new "disable" rule.
   - The daemon spool only sends sessions that have hook data, so OTEL-only data for a session that was gated out is never sent.
2. **Daily collector (batch).** `~/.codemie/codemie-onboarding/codemie-analytics-collector` (scheduled task, **not in this repo**) runs `codemie analytics --export json [--include-external]`. Its policy (`windows|always|never`) lives in `~/.codemie/analytics-sync.json`.

## AC1: Disable all

- **What exists:** `disconnect --claude-code-otlp` (scope `user`) removes the hooks, the OTEL env vars and the filter, then restores the backup. With the hooks gone, there is no SSO prompt and nothing is forwarded. ✔
- **Gaps:**
  - The ticket says "without removing or reinstalling". Turning analytics back on means running `connect` again, which **needs a live daemon** and **resets the project list**.
  - The collector keeps sending sessions (it reads local session data, not hooks).
  - Copilot connectors are separate. They are probably out of scope, since the ticket only covers Claude Code.
- **Proposal:** add an `enabled: false` flag that `isTracked` checks first. The hooks stay installed (AC4 bullet 3), there's no SSO prompt (gate runs before SSO), and turning it back on is instant. `disconnect` stays as the "uninstall" option. Open question: should the collector honour the same flag (it lives in another repo)?

## AC2: Disable personal subscriptions

- `native-external` means "plain `claude` with no CodeMie ownership marker" (`src/cli/commands/analytics/native-loader.ts:801-808`). A corporate account running plain `claude` is also `native-external`. Dropping the flag would therefore lose corporate data, miss personal sessions launched via CodeMie, and change nothing in the hook pipeline.
- **The real signal:** the `oauthAccount` block in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), especially `organizationUuid` / `organizationName` / `organizationType` / `billingType`. Nothing in the repo reads it today.
- **Proposed classification** (should match EPMCDME-16440):
  - CodeMie: `ANTHROPIC_BASE_URL` points at the CodeMie proxy.
  - Corporate: `organizationUuid` is in the installation's corporate org list.
  - Personal: any other OAuth account.
  - API key / Bedrock / Vertex (no `oauthAccount`): **needs a decision.**
- **Where:** in the same `isTracked` gate, with the decision **pinned at SessionStart** in the session state. `/login` can switch accounts mid-session, and re-checking on every event could leave half-sent sessions.
- **Blocker:** where does the "corporate organizations" list come from (backend, profile config, hardcoded)? That's the EPMCDME-16440 dependency.

## AC3: Disable a project (incl. Global)

- Today, `disconnect --scope project` only removes an entry from the allowlist. Under Global (`[]`) it returns *"all projects are tracked"* and does nothing (`connectors/claude-code-otlp.ts:660-672`).
- **Proposed rule:** tracked = `(allowlist empty OR cwd inside allowlist) AND cwd NOT inside any excluded path` (exclusion wins). Reuse `canonicalizePath` / `isPathInside` from `src/agents/core/project-allowlist.ts`, which already handle symlinks, Windows case and drive roots.
- **Storage (needs a decision):**
  - **Option A** (your idea): another env key in `settings.json`. Because it's `env`, it has to be a JSON *string*, not an array. It also gets passed to every tool subprocess, and the backup/strip logic has to learn about it.
  - **Option B (recommended):** a CodeMie-owned file, e.g. `getCodemiePath('claude-analytics.json')` holding `{ enabled, excludePersonal, excludedProjects }`. Copilot already does this (`src/agents/core/copilot-connector-scope.ts`). It survives `disconnect`/`connect` cycles and keeps `settings.json` for wiring only.
- **CLI behaviour to define:**
  - `connect --scope project` removes the project from the exclusions.
  - `connect --scope user` must **not** wipe the exclusions. Today it resets the allowlist to `[]`.
  - Today `connect --scope project` under Global silently narrows Global down to one project.

## AC4: Persist + display

- Persisted: ✔ (`settings.json`, re-read on every hook call, so it even applies to sessions that are already running).
- View: ✘. `proxy status` shows only the daemon. Add e.g. `codemie proxy status --analytics` (or `codemie analytics config`) showing the effective state: enabled, Global vs Project, the allowlist, exclusions, the personal-subscription rule, and whether the current cwd is tracked and why.
- "No forwarding through installed global hooks": covered by the `isTracked` gate from AC1 to AC3.

## Edge cases to cover

- **Managed launches:** `codemie claude` also loads `~/.claude/settings.json` hooks. Unlike `copilot-cli-otlp` (`CODEMIE_SESSION_ID` guard), `claude-code-otlp` has no guard, so the same gate applies to managed sessions too. Decide whether that's intended.
- **`CLAUDE_CONFIG_DIR`:** `getClaudeSettingsPath()` hardcodes `~/.claude`, so connect/disconnect write the wrong file when this is set.
- **cwd changes mid-session or nested repos:** decide per session (pin at SessionStart) rather than per event, so a session is never half-sent. Worktrees live outside the main repo path, so an excluded repo doesn't automatically exclude its worktrees.
- **Invalid filter or config:** today an invalid allowlist means nothing is tracked. Keep failing closed for exclusions and the disabled flag.
- **Deleted project folders:** `removeProjectPath` already matches the raw string. Do the same for exclusions.
- Out of scope per ticket: bulk listing or disabling.

## AC5: Regression matrix

Operations {disable all, disable personal, exclude project} × scope {Project, Global} × launch {native `claude`, `codemie claude`}. For each, assert: no spool write, no `ensureOtlpProxy`, no SSO call; other projects still forward; re-enable restores collection; `connect --scope user` keeps the exclusions. Extend the existing `claude-code-otlp.allowlist.test.ts`, `claude-code-otlp.plugin.test.ts`, `disconnect-orchestrator.test.ts` and `connect-wiring.test.ts`.

## Open questions

1. AC2: where does the corporate org list come from, and how are API-key / Bedrock sessions classified? (depends on EPMCDME-16440)
2. Storage: Option A (settings.json env) or Option B (CodeMie-owned file)?
3. Should "disable all" also stop the daily collector (separate repo)?
4. Command shape: new flags on `proxy connect/disconnect`, or a dedicated `codemie analytics enable|disable|status`?
