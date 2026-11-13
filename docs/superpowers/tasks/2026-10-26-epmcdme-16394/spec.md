# Confirm Claude Code analytics before connect

## Why

`codemie proxy connect --claude-code-otlp` can start the local proxy and write Claude `~/.claude/settings.json` without telling the user what will be sent to CodeMie. This story adds a confirmation before either of those side effects, without creating a second persisted source of truth for the scope.

The scope is derived from the Claude allowlist itself:
- an empty allowlist means Global
- a non-empty allowlist means Project

This keeps the feature limited to `codemie proxy connect --claude-code-otlp` and avoids extra persisted config state that is not needed for the command itself.

When `--scope` is omitted, the scope is Global (`user`). Project is an explicit opt-in through `--scope project`.

The confirmation also has to tell the user which CodeMie account and which project(s) the change applies to. It therefore opens with the profile and the CodeMie URL, followed by one short message that states what is being enabled (and, for Project scope, which project), and then the question. Review feedback asked for this to be lean and to look like the rest of the CLI:
- the prompt does not report the current Claude Code settings ("Already enabled", "About to add", "settings are (not) configured ...") — that detail belongs to a future status command (see Non-goals);
- the Confirm / Decline question is the same inquirer list that `codemie setup` uses, not a custom full-screen view;
- after the proxy starts, the command prints a short result, not the wiring details or the tracked-project list.

## Where it applies

The confirmation, decline, cancel, `--silent`, and non-interactive error apply only to `codemie proxy connect --claude-code-otlp`.

The confirmation text (profile, CodeMie URL and the scope/project message) and the trimmed post-start output apply only to this same `--claude-code-otlp` flow. The existing `Using profile: ...` line printed by `connect-orchestrator.ts` (before `verifySsoCredentials`) stays as is for every connect target and command, with one exception: it is not printed when the `--claude-code-otlp` confirmation prompt will be shown (target includes `claude-code-otlp` and `--silent` is not passed), because the summary carries it and it would otherwise appear twice. No other target or command shows the CodeMie URL.

`--scope` keeps the values `user` and `project`, and defaults to `user` when omitted:
- `user` (default) = all projects
- `project` (explicit opt-in) = add the current project to the allowlist and keep any other enabled projects already on the list

The current scope is not stored in a separate config field. It is inferred from the allowlist in `~/.claude/settings.json` when the command runs.

## Scope selection

The allowlist is the source of truth:
- `CODEMIE_ANALYTICS_PROJECT_FILTER` missing => no scope has been configured for this Claude install; this is a fresh connection
- `CODEMIE_ANALYTICS_PROJECT_FILTER` explicitly set to `[]` => Claude Code is configured for Global analytics
- `CODEMIE_ANALYTICS_PROJECT_FILTER` with one or more entries => Project scope

When the user omits `--scope`, the command defaults to Global (`user`) in every case, whatever the allowlist holds, and behaves exactly like `--scope user`. If the allowlist is missing, a fresh connection is configured as Global. If the allowlist is non-empty, it is cleared to Global, so omitting `--scope` on an install with enabled projects expands analytics to all projects; the confirmation states that analytics are configured for all Claude Code sessions in any project. If the allowlist is explicitly empty, it stays Global. The command does not ask which scope to use when `--scope` is omitted.

`--scope project` adds the current project root to the allowlist while preserving any other enabled project paths already on the list. It does not replace the current list and is not "current project only" when other enabled projects already exist.

`--scope user` clears the project filter to Global scope, which means all projects are tracked.

This command does not persist a separate choice in CodeMie config. The allowlist in Claude settings remains the authoritative runtime state.

Disabling one project is still handled by the existing `codemie proxy disconnect --claude-code-otlp --scope project` flow. It removes only the current project from the allowlist and keeps the others intact. Decline and cancel do not remove a project.

## Confirmation

The prompt is shown before the proxy is started and before `settings.json` is updated. Both scopes use the same structure and the screen is not cleared. The prompt shown follows the invocation scope: omitted `--scope` or `--scope user` shows the Global text; `--scope project` shows the Project text.

The prompt has two parts, printed in this order: a short message, then the Confirm / Decline question.

### 1. Summary and message

Rendered by `buildAnalyticsConfirmationMessage` in `src/cli/commands/proxy/prompts/analytics-confirmation.ts`:

- `Using profile: <name>`, using the profile name the command resolved (`config.name ?? 'default'`). The `(source: ...)` verbose suffix is not repeated here.
- `CodeMie URL: <url>`, only when the profile has a CodeMie URL configured, resolved with `resolveProfileCodeMieUrl(config.baseUrl, config.codeMieUrl)` (`connect-orchestrator.ts`), the same value the post-start table uses. The resolution logic is not duplicated.

These lines are cyan and there is no separate "Project(s)" line at the top: the scope and, for Project scope, the project are stated in the message below. A blank line follows, then one short message (word-wrapped to the terminal width, 80 when unknown, starting at column 0), then a blank line.

The profile name and URL are passed into the prompt by `confirmClaudeCodeOtlp`; the prompt does not read config itself. `Using profile:` appears exactly once on the confirmation screen.

The two messages are worded in parallel; both name "your Claude Code sessions":

| Scope | Message |
|---|---|
| Global | `Global analytics will be enabled for all your Claude Code sessions.` |
| Project | `Analytics will be enabled for your Claude Code sessions in the project:` followed on the next line by the canonical path of the current project |

The project path is printed on its own line and is never word-wrapped, so a path containing spaces stays intact.

When the stored allowlist cannot be read, one extra line is printed above the message, followed by a blank line: `The project list in Claude Code settings cannot be read and will be replaced.`

The text never says whether analytics are currently enabled or disabled, never describes whether Claude Code settings are already configured, never lists existing projects, and has no closing "please confirm" sentence: the question below is the confirmation. The Global message is the same for a missing, empty and non-empty allowlist, and so is the Project message. The only state-dependent line is the unreadable-allowlist warning.

### 2. Choice

Directly below the message, `inquirer.prompt` with `type: 'list'` — the same control used by `codemie setup` — asks `Enable Claude Code analytics?` with two choices, in this order:
- `Confirm` (default, first)
- `Decline`

Examples are examples only, not additional requirements; colors are not shown and profile name, URL and paths are placeholders.

Global (default invocation), any allowlist state:

```
Using profile: work
CodeMie URL: https://codemie.example.com

Global analytics will be enabled for all your Claude Code sessions.

? Enable Claude Code analytics? (Use arrow keys)
❯ Confirm
  Decline
```

Project scope, any allowlist state:

```
Using profile: work
CodeMie URL: https://codemie.example.com

Analytics will be enabled for your Claude Code sessions in the project:
/repos/project-c

? Enable Claude Code analytics? (Use arrow keys)
❯ Confirm
  Decline
```

Confirm starts the proxy when it is not already running, then updates `settings.json` for the invocation scope. `settings.json` is not updated if the proxy is not running.

Decline does not start the proxy and does not update `settings.json`. A closed prompt (Ctrl+C) is treated the same way: nothing has been started or written when the prompt is shown, so the allowlist is left unchanged, including when the default Global prompt was shown. Cancel is not treated as Global. A daemon that is already running is left running.

The invalid-allowlist guard (stop unless `--force`) still runs before the prompt on every path.

### Post-start output

After the proxy starts and `settings.json` is updated, the command prints, in this order:
1. `✓ Claude Code Analytics configured successfully` (green).
2. The "Analytics Configuration" table with the rows `Using profile`, `CodeMie URL` (only when configured) and `Scope`. Labels are padded to the longest label plus one space, followed by `│ `.
3. The yellow line `First-time setup needs a Claude Code restart; allowlist changes apply immediately.`

It does not print the tracked-project list, the number of wired hook events, the number of OTel env vars or their settings path, the backup path, or any of the grey explanatory lines about user-level OTel env and sweeping. A failure to configure still prints the existing yellow `Could not configure Claude Code analytics: ...` line.

## Silent and non-interactive

`--silent` is a new flag on `codemie proxy connect --claude-code-otlp`. The existing `-s`/`--silent` on agent CLIs only applies to that agent and is not reused here.

`--silent` skips the prompt, starts the proxy, updates `settings.json`, and collects under the invocation scope. Omitted `--scope` defaults to Global, so `--silent` without `--scope` writes the Global (empty) allowlist and replaces any existing project entries without asking. To keep a project list, the caller passes `--scope project --silent`, which adds the current project while keeping any existing project entries. Since no prompt is shown, the confirmation summary does not appear; the existing `Using profile: ...` line (still printed once) and the post-start output are what the user sees.

A prompt is impossible in a non-interactive terminal, which means stdin is not a TTY. Detect that only with `isNonInteractiveEnvironment()` in `src/utils/interactive.ts`, which returns `!process.stdin.isTTY`. Do not add a second detector. If that helper reports non-interactive and `--silent` was not passed, the command exits with an error, whatever the scope and including an omitted `--scope`. It does not start the proxy and does not update `settings.json`.

## Acceptance criteria

1. `codemie proxy connect --claude-code-otlp` without `--scope` behaves as `--scope user`: it shows the Global prompt and, on accept, writes the Global (empty) allowlist.
2. `--scope project` is an explicit opt-in: it shows the Project prompt and, on accept, adds the current project while keeping other enabled projects.
3. The prompt appears before the proxy starts and before `settings.json` is updated. Confirm is the first, default choice and Enter accepts it.
4. Decline and cancel (Ctrl+C) do not start the proxy, do not change `settings.json`, leave the existing allowlist untouched, and leave an already running daemon running.
5. `--silent` skips the prompt: without `--scope` it configures Global; with `--scope project` it adds the current project.
6. Without `--silent`, a non-interactive terminal (per `isNonInteractiveEnvironment()`) makes the command exit with an error, without starting the proxy or updating `settings.json`.
7. Scope is derived from the Claude allowlist; no new persisted config field is added.
8. Docs describe the Global default, and regression tests cover default scope, confirmation, decline, cancel, silent, the non-interactive error, and the prompt and output changes in criteria 9-14.
9. The prompt text starts with `Using profile: <name>`, then `CodeMie URL: <url>` only when a CodeMie URL is configured (resolved with `resolveProfileCodeMieUrl(config.baseUrl, config.codeMieUrl)`, same as the post-start table). There is no separate project line at the top; for Project scope the current project path appears once, under the message (criterion 11).
10. The prompt does not contain "Already enabled", "About to add", "Claude Code settings are not yet configured" or "Claude Code settings are configured", does not say whether analytics are currently enabled or disabled (for example no "already enabled" or "currently collected" wording), and does not list previously enabled projects.
11. The message is exactly `Global analytics will be enabled for all your Claude Code sessions.` for Global, and `Analytics will be enabled for your Claude Code sessions in the project:` followed on the next line by the current project path for Project scope. The two are worded in parallel, neither uses "we" (the subject is the analytics, not an unnamed actor), there is no closing "please confirm" sentence, the path is never wrapped, and the text is identical for a missing, empty and non-empty allowlist; the only extra line is the unreadable-allowlist warning.
12. The Confirm / Decline question is an inquirer `list` prompt, as in `codemie setup`; the screen is not cleared and no custom raw-mode key handling remains.
13. The post-start output is the success line, the Analytics Configuration table (`Using profile`, `CodeMie URL` when configured, `Scope`) and the yellow restart line. It contains no tracked-project rows, no hook-event or env-var counts, no backup path and no grey explanatory text.
14. `Using profile:` appears exactly once on the confirmation screen: when the `--claude-code-otlp` prompt will be shown (target includes `claude-code-otlp`, no `--silent`), the pre-prompt `Using profile:` line from `connect-orchestrator.ts` is not printed and the summary carries it. For other targets, other commands and `--silent`, the pre-prompt line is still printed exactly once, unchanged. The CodeMie URL appears only in this command's confirmation summary and table.

## Non-goals

- No persisted analytics-scope field in CodeMie config and no second source of truth besides the Claude allowlist.
- No prompt or `--silent` on `proxy start`, `codemie hook`, `ensureOtlpProxy`, or `codemie setup`.
- No interactive question about which scope to use when `--scope` is omitted.
- No change to allowlist semantics, hook-side filtering, or the daemon.
- No change to `codemie proxy disconnect` behavior.
- No reuse of the agent CLIs' `-s`/`--silent`, and no second non-interactive detector.
- No update to `.ai-run/guides/usage/project-config.md`.
- The CodeMie URL is not shown for other connect targets or commands, and the existing `Using profile: ...` line is not changed for other targets and commands, nor for `--silent`; it is skipped only when the `--claude-code-otlp` confirmation prompt will be shown.
- No status command in this ticket. Showing the detailed state (tracked projects, wired hook events, OTel env vars, settings path, backup) is a separate follow-up, for example `codemie proxy status`; this story only removes that detail from the connect output and the prompt.
- No change to the Copilot Chat or Copilot CLI connect output.

## Documentation and coverage

Update user-facing command docs that already describe this connect flow, including `docs/COMMANDS.md`, so they describe the Global default, the `--scope` selection (Project as explicit opt-in), how the allowlist is the source of truth, the project add/Global behavior, the confirmation (profile, CodeMie URL, a one-line message naming Global or the current project, then Confirm / Decline), decline and cancel, the new connect `--silent` flag (including its effect when `--scope` is omitted), the non-interactive error, and the shortened post-start output (sample output without tracked-project rows). Review the root `README.md` and update it only if it describes this flow. Do not add a new persistent config field or cross-command shared state.

Implementation area, no code change made here: the `--scope <user|project>` option on `proxy connect` in `src/cli/commands/proxy/index.ts` already defaults to `'user'`, and `src/cli/commands/proxy/connectors/claude-code-otlp.ts` already writes `[]` for any non-project scope. The Global default therefore needs no change to the option definition or the connector's allowlist write; keep the default as `'user'` and add the confirmation and `--silent` handling ahead of `ensureDaemon` and the settings write.
