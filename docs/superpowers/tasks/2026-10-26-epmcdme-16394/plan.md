# Confirm Claude Code analytics before connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `codemie proxy connect --claude-code-otlp`, default an omitted `--scope` to Global (`user`), identical to `--scope user`, and ask once before the proxy starts or `~/.claude/settings.json` is written. `--scope project` is an explicit opt-in. No shared config state between commands.

**Architecture:** The allowlist in `~/.claude/settings.json` is the source of truth. Empty allowlist = Global, non-empty allowlist = Project. No `ConfigLoader` changes, no persistent `analytics.claudeCode.scope`, and no setup-state coupling. `--scope` stays `user` | `project` (default `user`) and updates the allowlist for this invocation. The connector already writes `[]` for any non-project scope; the work is the default, the confirmation, and `--silent` handling ahead of `ensureDaemon` and the settings write.

**Tech Stack:** TypeScript ESM, Commander, inquirer (`list` prompt, as in `codemie setup`), Vitest. No new dependencies.

Do not commit, stage, push, or open a pull request.

**Current-tree note:** The working tree already contains an earlier implementation with a Project default (`index.ts:315-322`, `connectors/claude-code-otlp.ts:503`, `connect-orchestrator.ts:685` and `:809`, the existing confirmation prompt, `docs/COMMANDS.md` table). Tasks below describe the delta from that state to the revised spec; do not recreate what exists. Tasks 1-4 are implemented and committed; Task 5 is the delta for the amended spec (criteria 9-13) and re-adds profile/URL to the prompt as a view-level header, superseding the "drop profile/URL" part of Task 2. Tasks 5-6 are implemented (uncommitted). Task 6 supersedes Task 5's 2-space margin rule (and the "pre-prompt `Using profile:` line unchanged for every target" wording) per amended criteria 11 and 14. Task 7 supersedes Task 5's "gray individual paths only; `none`/`All projects`/etc. stay plain" rule per amended criterion 10: every list item is gray. **Task 8 (review-feedback rework) supersedes the prompt layout, colors, alignment and post-start output defined in Tasks 2, 5, 6 and 7:** the custom raw-mode screen, "Already enabled" / "About to add" lists, yellow title, gray list items, margin rules and the grey post-start lines are removed. Where Tasks 2, 5, 6 or 7 conflict with Task 8 or the spec, Task 8 and the spec win; their wiring parts (header data flow via `display`, `--silent`, pre-prompt line suppression) remain valid.

## Global Constraints

- This work is only `codemie proxy connect --claude-code-otlp`. It does not add or change setup persistence, project config, or profile metadata.
- `--scope` stays `user` | `project`, default `user`. Non-interactive detection is only `isNonInteractiveEnvironment()` (`src/utils/interactive.ts`); no second detector.
- `--silent` is a new long flag on `proxy connect` only. Do not reuse the agent CLIs' `-s/--silent`, and add nothing to `proxy start`, `codemie hook`, `ensureOtlpProxy`, `codemie setup`, or `proxy disconnect`.
- The effective scope is derived from the Claude allowlist, not from a saved property.
- Project title is exactly `Enable Claude Code analytics for the current project?` with no directory or application name. Global title is exactly `Enable global Claude Code analytics?`.
- The confirmation text starts with `Using profile: <name>` and `CodeMie URL: <url>` (only when configured), followed by one short message: `Global analytics will be enabled for all your Claude Code sessions.` for Global, or `Analytics will be enabled for your Claude Code sessions in the project:` plus the current project path on the next line for Project scope (Tasks 5, 8). There is no separate project line at the top and no "we" in the wording. The CodeMie URL appears only in this command's confirmation text and post-start table; the pre-prompt `Using profile:` line printed for every connect target stays unchanged, except that it is not printed when the `--claude-code-otlp` confirmation will be shown (Task 6), so `Using profile:` appears once on that screen.
- Prompt content and style (Task 8): no "Already enabled" / "About to add" lists and no "Claude Code settings are (not) configured ..." sentences; the profile/URL lines are cyan, the message starts at column 0 and is word-wrapped (the project path line never is), the screen is not cleared; the text never says whether analytics are currently enabled or disabled; Confirm / Decline is an inquirer `list` prompt like `codemie setup`.
- Post-start output (Task 8): success line, Analytics Configuration table (`Using profile`, `CodeMie URL` when configured, `Scope`) and the yellow restart line only; no tracked-project rows, no hook-event/env-var counts, no backup path, no grey text. Detailed status is a separate follow-up command, not part of this ticket.
- `~/.claude/settings.json` changes only after `enable` or `--silent` on that connect.
- Do not update `.ai-run/guides/usage/project-config.md`.

## Edge cases

1. If the allowlist key is missing because Claude Code analytics has never been configured for this install, treat it as a fresh connection and configure Global for this invocation when `--scope` is omitted. The prompt text is the same as for any other Global state.
2. An explicitly empty allowlist (`[]`) means analytics is currently Global; a non-empty allowlist means Project scope. The prompt does not display or hint at this state; the Global and Project texts are identical for every allowlist state (only an unreadable allowlist adds a warning).
3. Omitted `--scope` always defaults to Global, identical to `--scope user`. It clears the allowlist to `[]`; if the prior allowlist was non-empty, this expands tracking to all projects, which the Global text conveys ("all Claude Code sessions in any project"). The user is never asked which scope to use.
4. `--scope project` is an explicit opt-in and additive: it adds the current project to the existing list instead of replacing it. If the list is empty, the project becomes the only item (Global to Project switch, covered by the Project prompt wording).
5. `--scope user` clears the allowlist and means Global scope for the current invocation.
6. If the user declines or cancels (Decline, Ctrl+C), the command does not start the proxy and does not update `settings.json`; the existing allowlist is left untouched, including when the default Global prompt was shown. Cancel is not treated as Global.
7. `--silent` skips the prompt and is the non-interactive success path. Without `--scope` it writes Global (`[]`) and replaces existing project entries without asking; `--scope project --silent` adds the current project and keeps existing entries. No prompt means no confirmation header; the pre-prompt `Using profile:` line and the post-start table are what is shown.
8. Non-interactive (`isNonInteractiveEnvironment()`) without `--silent` is the error path for any scope, including omitted: exit with an error before the proxy starts, SSO is verified, or `settings.json` is touched.
9. If the proxy is already running, the command still follows the same confirmation/decline logic and leaves the daemon running if it was already active.
10. With explicit `--scope project`, a current project already included in the allowlist is not duplicated (the connector's add is idempotent); the prompt shows the same Project text as for any other allowlist state.
11. If `ensureDaemon` fails after enable, do not write `settings.json`.
12. An invalid allowlist still stops `connect` unless `--force` is passed, on the prompt path and the `--silent` path alike.
13. There is no cross-command persisted scope; the allowlist is the runtime truth and remains the only state that matters.
14. A profile without a configured CodeMie URL omits the `CodeMie URL:` header line and the table row; the `Using profile:` header line is always present.

---

### Task 1: Default the scope to Global and align the allowlist-scope helper

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:315-322` (connect `--scope` option: `.default('user')`, help text "user" (default) tracks all projects and resets the project list; "project" adds the current project and preserves others)
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts:503` (`opts.scope ?? 'user'`)
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:685` and `:809` (`?? 'user'`)
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts:24-31` (`inferAllowlistScope`: a missing allowlist is a fresh connection and maps to `user`; non-empty stays `project`; invalid stays `project` so it never broadens tracking; update the doc comment)
- Tests: `src/cli/commands/proxy/__tests__/connect-wiring.test.ts:52`, `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts:177`, `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:541`, `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.allowlist.test.ts:22-37`

**Interfaces:**
- Consumes: current `CODEMIE_ANALYTICS_PROJECT_FILTER` state in `~/.claude/settings.json`
- Produces: omitted `--scope` resolves to `user` end to end; `--scope project` remains the only path that adds the current project.

**Test-first: yes — default-scope tests assert Global: `connect --claude-code-otlp` without `--scope` forwards `scope: 'user'` (rewrite the "defaults to Project" wiring test); `writeClaudeCodeOtlpConfig()` with no scope writes `[]` and replaces an existing project list (rewrite the "switches Global to current project when scope is omitted" test); explicit `{ scope: 'project' }` adds the current project, preserves other entries, and turns `[]` into the current project only; the Analytics Configuration summary shows `Scope user` / all projects when scope is omitted; `inferAllowlistScope({ kind: 'absent' })` is `user`.**

- [ ] **Step 1:** Rewrite the default-scope tests above to assert Global, and add explicit `--scope project` cases for the Project path; confirm they fail.
- [ ] **Step 2:** Flip the four `'project'` defaults, fix the option help text, and update `inferAllowlistScope` and its absent-state test.

### Task 2: Align the confirmation prompt with the Global default and drop profile/URL

**Files:**
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts` (remove `name`/`url` from `AnalyticsConfirmationOptions` at `:22-23` and the `CodeMie profile:`/`URL:` lines at `:126-127`; body wording and Already enabled/About to add logic already match the spec, verify only)
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:710-740` (`confirmClaudeCodeOtlp` stops taking `profile`/`url`) and its call at `:808-813`
- Test: `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts`

**Interfaces:**
- Consumes: `buildSingleChoiceRow` (`src/cli/commands/shared/selection/ui.ts`)
- Produces: a confirmation view whose body follows the invocation scope and the allowlist state (missing / non-empty / empty), with "Already enabled" (`none` for missing, `All projects` for empty, listed paths otherwise) and "About to add" (`All projects` for Global, the current project path for Project), and no profile or URL text.

**Test-first: yes — the default (Global) prompt for a missing allowlist reads "not yet configured … all projects", Already enabled `none`, About to add `All projects`; Global with listed projects says it expands to all projects and lists them; Global with `[]` says it keeps all projects and shows `All projects`; explicit Project prompts cover missing, non-empty (adds current, keeps others) and `[]` (limits to current, Already enabled `All projects`); no view contains `CodeMie profile` or `URL:`; Enter on Enable analytics returns `enable`; Decline, Esc, and Ctrl+C return `cancel`; arrow keys return `null`.**

- [ ] **Step 1:** Update the prompt tests: remove `name`/`url` from fixtures and add negative assertions for profile/URL text; add the Global-default cases.
- [ ] **Step 2:** Remove `name`/`url` from the options, the view, and the orchestrator call chain.

### Task 3: Add `--silent` and the non-interactive error to connect

**Files:**
- Modify: `src/cli/commands/proxy/index.ts` (add `--silent` to the connect options near `:315`, add `silent?: boolean` to `UnifiedConnectOptions` at `:43`, forward it in the action at `:324-338`; help text must say it applies to `--claude-code-otlp`)
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts` (add `silent?: boolean` to `ConnectOptions` near `:86`; in `connectTargets` at `:742-821`)
- Related: `src/utils/interactive.ts`
- Tests: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`, `src/cli/commands/proxy/__tests__/connect-wiring.test.ts`

**Interfaces:**
- Consumes: `isNonInteractiveEnvironment()`
- Produces: a connect flow where, for the Claude Code OTLP target, (a) non-interactive without `--silent` raises a `ConfigurationError` through the existing `printProxyError` path before `resolveSsoProxyConfig` (`:781`), so nothing starts or is written; (b) `--silent` skips `promptAnalyticsConfirmation` but still runs the invalid-allowlist guard in `confirmClaudeCodeOtlp` (`:716-722`), then proceeds to `ensureDaemon` and the settings write with `opts.scope ?? 'user'`.

**Test-first: yes — `--silent` without `--scope` skips the prompt and calls the writer with `scope: 'user'` (empty allowlist, replacing project entries); `--scope project --silent` skips the prompt and calls the writer with `scope: 'project'`; with `isNonInteractiveEnvironment()` true and no `--silent`, connect with omitted scope and with `--scope project` each exit with an error and call neither `ensureDaemon`, the prompt, nor the writer; interactive default shows the Global prompt, and Decline/Esc/Ctrl+C start no proxy, never call the writer, and leave an already running daemon running; `connect --claude-code-otlp --silent` is forwarded as `silent: true` by the wiring test.**

- [ ] **Step 1:** Write the failing tests for silent, non-interactive, default-scope prompt, and decline/cancel.
- [ ] **Step 2:** Thread `silent` from the Commander option into `connectTargets`, add the early non-interactive guard and the silent bypass, keeping `--silent` the only bypass.

### Task 4: Update the docs

**Files:**
- Modify: `docs/COMMANDS.md:1589-1650` (the connect/disconnect allowlist table at `:1634-1640` and the paragraph at `:1642`)
- Modify: `README.md:606-627` (Claude Code OTLP analytics section; review root README and update because it describes this flow)

**Interfaces:**
- Consumes: the final behavior of the connect command
- Produces: docs describing the Global default (omitted `--scope` equals `--scope user`), `--scope project` as explicit opt-in, allowlist-as-source-of-truth, the confirmation with decline and cancel, `--silent` (including that omitted `--scope` writes Global and replaces project entries, and `--scope project --silent` keeps them), and the non-interactive error.

**Test-first: no — documentation only; there is no behavior to fail.**

- [ ] **Step 1:** Rewrite the COMMANDS.md table row and `:1642` paragraph that assume a Project default, add confirmation/`--silent`/non-interactive text, and add the `--silent` option row and prompt note to the README section. Do not touch `.ai-run/guides/usage/project-config.md` and mention no stored config state.

### Task 5: Prompt header, colors, alignment and table label

> **Superseded in part by Task 8:** the view builder, yellow title, gray items, alignment rules and the table's `Tracked projects` rows no longer apply. Still valid: the `display` data flow into `confirmClaudeCodeOtlp` and `runClaudeCodeOtlp`, the single resolved CodeMie URL, and the `Using profile` table label.

Implements spec "Header (fixed)", "Style and alignment", "Post-start table" and acceptance criteria 9-13.

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts`
  - In `connectTargets` (`:727-753`, `:805-813`): after the `Using profile:` line at `:728-733` (unchanged, still printed for every target), compute the display URL once, `config.codeMieUrl ? resolveProfileCodeMieUrl(config.baseUrl, config.codeMieUrl) : undefined`, only when `targets.claudeCodeOtlp`. Reuse that single value for the `confirmClaudeCodeOtlp` call at `:741` and for `runClaudeCodeOtlp` at `:806-813`, replacing the inline resolution there. `resolveProfileCodeMieUrl` (`:278`) stays the one resolver and stays non-exported (no duplication, no new module); declare the variable next to `config`/`state` so both call sites see it.
- Modify: `src/cli/commands/proxy/claude-code-otlp-flow.ts`
  - `confirmClaudeCodeOtlp` (`:78-109`): add a fourth parameter `display: { profile: string; codeMieUrl?: string }` and pass `profile`/`codeMieUrl` into `promptAnalyticsConfirmation` (`:102-106`). The prompt does not read config.
  - `runClaudeCodeOtlp` table (`:45`): rename the label `'Profile'` to `'Using profile'`. Padding at `:50-53` (longest label + 1, `│ `, empty padded label on continuation rows) already satisfies the alignment rule and widens automatically; verify, do not rewrite.
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts`
  - `AnalyticsConfirmationOptions` (`:28-35`): add `profile: string` and `codeMieUrl?: string`.
  - `buildAnalyticsConfirmationView` (`:119-165`): rebuild the line list so the first lines are the header, `chalk.cyan('Using profile: <profile>')` then, only when `codeMieUrl` is set, `chalk.cyan('CodeMie URL: <url>')`, then a blank line, then the title. Because it lives in the builder, every redraw (`render`, `:71-74`, including Up/Down) keeps it.
  - Title: `chalk.yellow(title)` for both scopes; "Already enabled:" / "About to add:" headings keep their current style.
  - Gray: wrap only individual project paths in `chalk.gray` (listed paths in `getAlreadyEnabledLines` `:260-271`, and the current-project path in "About to add"). `none`, `All projects`, `none (already enabled)` and `unable to read existing projects` stay plain. (Superseded by Task 7: every list item is gray.)
  - Alignment: all lines start at the 2-space margin; list items (paths, `none`, `All projects`, and the "About to add" item) all use the same 4-space indent (heading margin + 2), which fixes the current items sitting at the heading's indent (`:147`, `:150`); the body is word-wrapped (width from `process.stdout.columns`, fallback 80, minus the margin) with every wrapped line prefixed by the 2-space margin (currently one unwrapped line at `:144`); choice rows and the key hint keep the 2-space margin. Add one small private wrap helper in this file; no new dependency.
- Docs: `docs/COMMANDS.md:1619-1624` (sample output row `Profile` becomes `Using profile`, labels re-padded so the value column still aligns) and the **Confirmation** paragraph at `:1646` (one sentence: the prompt opens with the profile and, when configured, the CodeMie URL it applies to). `README.md:606-643` describes neither the prompt layout nor the table, so leave it unchanged after reviewing it.
- Tests: `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts`, `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (wiring; reuse the existing mocks of `claude-code-otlp-flow.js`/prompt), and the existing `runClaudeCodeOtlp` coverage (locate with grep for `Analytics Configuration`, add there or in `connect-orchestrator.test.ts`).

**Interfaces:**
- Consumes: `resolveProfileCodeMieUrl(baseUrl: string, codeMieUrl?: string): string` (`connect-orchestrator.ts:278`); `config.name ?? 'default'` (the `profile` const at `:727`).
- Produces: `AnalyticsConfirmationOptions` gains `profile: string; codeMieUrl?: string`; `confirmClaudeCodeOtlp(scope, force, silent, display: { profile: string; codeMieUrl?: string }): Promise<boolean>`; `buildAnalyticsConfirmationView` output starts with the header. `--silent` path is untouched (no prompt, no header).

**Test-first: yes — view-builder tests (set `chalk.level` to 1 or higher inside the test file and restore it, so ANSI codes are asserted; otherwise assert on stripped text): header is the first two lines, `Using profile: work` then `CodeMie URL: https://codemie.example.com`, followed by a blank line and the title; with no `codeMieUrl` the `CodeMie URL:` line is absent and `Using profile:` remains; the header is present in the view for `selectedIndex` 0 and 1 (redraw); the title carries the yellow ANSI code for Global and Project; each listed path and the Project "About to add" path carry the gray code while `none`, `All projects`, `none (already enabled)` and `unable to read existing projects` do not (inverted by Task 7); alignment: every non-empty line begins with exactly 2 spaces (header, title, headings, choice rows, hint), all list items under both headings begin with exactly 4 spaces, and every wrapped body line begins with the 2-space margin (assert with a long body and a narrow stubbed `process.stdout.columns`); post-start table: the first row label is `Using profile`, no row is labelled `Profile`, the CodeMie URL row is unchanged, and continuation rows for a multi-project allowlist align to the value column of `Using profile`'s `│`. Wiring tests: with a profile whose `baseUrl` origin equals the workspace `codeMieUrl`, `confirmClaudeCodeOtlp` receives `{ profile: <config.name>, codeMieUrl: <that url> }` and `runClaudeCodeOtlp` receives the identical `codeMieUrl`; with a workspace `codeMieUrl` of a different origin both receive the `baseUrl` origin (same resolver result); with no `codeMieUrl` both receive `undefined` and the profile name still reaches the prompt. Negative tests: a non-`--claude-code-otlp` connect (for example `--vscode` or `--claude-desktop`) never calls `confirmClaudeCodeOtlp`, its output contains no `CodeMie URL:` line from the confirmation, and its pre-prompt `Using profile: <name>` line is unchanged.**

- [ ] **Step 1:** Write the failing view-builder, table-label and wiring tests above; run them and confirm they fail for the right reason (missing header, no color, 4-space indent, `Profile` label, missing `display` argument).
- [ ] **Step 2:** Add `profile`/`codeMieUrl` to `AnalyticsConfirmationOptions`; rebuild `buildAnalyticsConfirmationView` with the header, yellow title, gray paths, the wrap helper and the list-indent rule.
- [ ] **Step 3:** Add the `display` parameter to `confirmClaudeCodeOtlp`, compute the display URL once in `connectTargets` and pass it to both `confirmClaudeCodeOtlp` and `runClaudeCodeOtlp`; rename the table label to `Using profile`.
- [ ] **Step 4:** Update the `docs/COMMANDS.md` sample table and the Confirmation paragraph; confirm the README needs no change.

### Task 6: Single Using-profile line and no left margin

> **Superseded in part by Task 8:** the margin and `LIST_INDENT` rules are gone with the custom view. Still valid: the pre-prompt `Using profile:` suppression in `connectTargets`.

Implements amended spec criteria 11 and 14 (supersedes Task 5's 2-space margin and its unconditional pre-prompt line).

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:742-747` (the pre-prompt `Using profile:` `console.log`, before `verifySsoCredentials`): print it only when NOT `targets.claudeCodeOtlp && !opts.silent`. Compute that condition once next to `otlpDisplay` (`:734`) so it names "the confirmation prompt will be shown"; leave the line itself, including the verbose `(source: ...)` suffix, byte-identical for every other case. The non-interactive-without-`--silent` error already fires earlier, so that condition is exactly when the prompt is shown. Do not change `confirmClaudeCodeOtlp`, `otlpDisplay`, or the post-start table.
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts:24-27,149-181`: delete `MARGIN` (`:24-25`) and every `${MARGIN}` prefix in `buildAnalyticsConfirmationView` (header, title, headings, hint, wrapped body lines, and the `buildSingleChoiceRow` output, which keeps its own cursor prefix: `>`/`●` on the selected row, two spaces on the other); keep `LIST_INDENT` as a plain 2 spaces, applied to list items only. `getWrapWidth` (`:179-181`) becomes `Math.max(20, process.stdout.columns || 80)` (no margin subtracted); fix the doc comments that mention the margin.
- Docs: `docs/COMMANDS.md:1613-1650` shows neither the prompt layout nor a duplicated `Using profile:` line (the sample at `:1619-1624` is the post-start table), so expect no change; edit only if a re-read finds otherwise.
- Tests: `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts:252-327` (alignment `describe`), `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (near the wiring tests at `:800-852`).

**Interfaces:**
- Consumes: `opts.silent`, `targets.claudeCodeOtlp` (`connectTargets`); `process.stdout.columns`.
- Produces: no new exports or signatures. `Using profile:` is printed once on the confirmation screen (by the header only); `buildAnalyticsConfirmationView` lines start at column 0, list items at 2 spaces.

**Test-first: yes — (a) orchestrator: `connectTargets({ targets: { claudeCodeOtlp: true } })` (not silent) never prints a `Using profile:` line before the prompt, in both default and verbose modes, while the prompt mock still receives `profile`; (b) `{ claudeCodeOtlp: true }` with `silent: true`, and `{ vscode: true }` / `{ claudeDesktop: true }`, print exactly one `Using profile: <name>` line, with the `(source: ...)` suffix when verbose; (c) a combined `{ vscode: true, claudeCodeOtlp: true }` non-silent run omits the line; (d) view: no non-empty line starts with a space except list items and the non-selected choice row's cursor prefix; the header, title, `Already enabled:`, `About to add:` and hint lines equal their text exactly; every list item under both headings matches `/^ {2}- \S/` in all scope/allowlist states; with `process.stdout.columns` stubbed to 40 every wrapped body line starts at column 0 (`/^\S/`) and is at most 40 characters; with columns undefined, wrapped lines are at most 80.**

- [ ] **Step 1:** Rewrite the margin assertions in the alignment `describe` (header/title/heading/hint at column 0, list items `^ {2}- `, wrapped lines `^\S`, choice rows without extra margin, 40-column and 80-fallback widths) and add the orchestrator cases (a)-(c); run them and confirm they fail (2-space margin, 4-space items, line still printed).
- [ ] **Step 2:** Add the suppression condition in `connectTargets` and remove the margin/re-wrap at full width in the view builder; update any other Task 5 assertion that hard-codes the margin.

### Task 7: Gray every list item

> **Superseded by Task 8:** the lists it colors no longer exist.

Implements amended spec criterion 10 (supersedes Task 5's "gray paths only" rule).

**Files:**
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts:140-144` (the "About to add" item: `none (already enabled)`, the current-project path, `All projects`) and `:292-303` (`getAlreadyEnabledLines`: `none`, `unable to read existing projects`, `All projects`, listed paths). Gray the item text in every branch with `chalk.gray`, keeping the `- ` bullet and the 2-space list indent outside the gray span exactly as paths are handled today. A small private helper (for example `listItem(text) => \`- ${chalk.gray(text)}\``) used by both sites keeps the rule in one place. Header, title, headings, body text, choice rows and hint stay unchanged.
- Docs: no change. `docs/COMMANDS.md` and `README.md` describe neither prompt colors nor list styling (Tasks 5-6 already confirmed this for layout).
- Test: `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts:227-249` (the `colors` `describe`).

**Interfaces:**
- Consumes: `chalk` (already imported in the file).
- Produces: no new exports or signatures; every `- ` item line in the view carries the gray ANSI code on its text.

**Test-first: yes — in the `colors` `describe`, replace the `keeps "%s" uncolored` table test (`:237-249`) with `colors "%s" gray`, asserting the item line contains the gray code immediately before the text (`${ANSI_GRAY}${text}`) for the same five cases: `none` (Global, absent), `All projects` (Global, `[]`, Already enabled), `All projects` (Global, absent, About to add), `unable to read existing projects` (Global, invalid), `none (already enabled)` (Project, current project listed). These five fail on the current code. Add one regression test, which already passes, that the `Already enabled:` and `About to add:` headings, the title's non-yellow text, and the body lines contain no gray code; and keep the existing path-gray test (`:227-235`) unchanged.**

- [ ] **Step 1:** Invert the five uncolored cases to gray, add the headings/body not-gray test; run and confirm the five fail because the item text carries no gray code.
- [ ] **Step 2:** Route both item builders through the gray helper; re-run the file and update any other assertion in it that expects an uncolored `none`/`All projects` item.

### Task 8: Review-feedback rework — lean prompt, setup-style choice, trimmed output

Implements the revised spec "Confirmation" and "Post-start output" sections and acceptance criteria 9-14. Source: review feedback — no "Already enabled" / "About to add"; no "Claude Code settings are (not) configured ..." sentences; profile and CodeMie URL followed by one short, parallel Global / Project message (project path under it, no separate top line, no "we"); Confirm / Decline styled like `codemie setup`; no sentence about whether analytics are currently enabled or disabled; no grey wiring text or tracked-project list after the proxy starts; detailed status deferred to a separate command.

**Files:**
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts` — replace the raw-mode screen with `buildAnalyticsConfirmationMessage(options): string` (pure) and `promptAnalyticsConfirmation(options)`: `console.log` the message, then `inquirer.prompt` `type: 'list'`, message `Enable Claude Code analytics?`, choices `Confirm` (first, default) and `Decline`; map `ExitPromptError` / `AbortPromptError` to `'cancel'`, rethrow anything else. Delete `KEY`, `ANSI`, `releaseStdin`, `moveSelection`, `resolveAnalyticsConfirmationKey`, the `buildSingleChoiceRow` import, `LIST_INDENT`, `listItem`, `getAlreadyEnabledLines` and the per-allowlist body helpers. Keep `AnalyticsConfirmationOptions` (`profile`, `codeMieUrl?`, `scope`, `allowlist`, `currentProjectPath`) and the `wrapText` / `getWrapWidth` helpers. Message wording exactly as in the spec table; the project path is pushed as its own unwrapped line.
- Modify: `src/cli/commands/proxy/claude-code-otlp-flow.ts` — `runClaudeCodeOtlp`: drop the `projectRows`, the hook-event / env-var / backup grey lines and the three grey OTel explanation lines; keep the success line, the table (`Using profile`, `CodeMie URL` when set, `Scope`) and the yellow restart line; remove the now-unused `CLAUDE_CODE_OTLP_AGENT_NAME` import. `confirmClaudeCodeOtlp`: stop canonicalizing the existing allowlist for display (only `currentProjectPath` needs canonicalizing); keep the invalid-allowlist guard and the `silent` bypass.
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts` — update the comment above `confirmationWillBeShown` (the prompt no longer clears the screen; its profile line carries the profile, so the line is skipped to avoid a duplicate). Condition unchanged.
- Tests: `src/cli/commands/proxy/prompts/__tests__/analytics-confirmation.test.ts` (rewrite), `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:692,729` (table assertions) plus any prompt mock shape.
- Docs: `docs/COMMANDS.md:1619-1624` (drop the `Tracked projects` row from the sample table), `:1642` (remove "lists the entries under 'Already enabled'"), `:1646` (Confirmation paragraph: profile, CodeMie URL, a one-line message naming Global or the project, then a Confirm / Decline choice; Decline or Ctrl+C stop the command; no Esc). `README.md:606-643` re-check only; change only if it mentions the old prompt or output.

**Interfaces:**
- Consumes: `inquirer` (already a dependency; same list prompt style as `src/cli/commands/setup.ts`), `chalk`.
- Produces: `buildAnalyticsConfirmationMessage(options: AnalyticsConfirmationOptions): string`; `promptAnalyticsConfirmation(options): Promise<'enable' | 'cancel'>` (unchanged signature); `ClaudeCodeOtlpDisplay` / `confirmClaudeCodeOtlp` / `runClaudeCodeOtlp` signatures unchanged.

**Test-first: yes —**
- Message builder (assert on text with ANSI stripped): the exact line list is `Using profile: work`, `CodeMie URL: https://codemie.example.com`, a blank line, then `Global analytics will be enabled for all your Claude Code sessions.` (Global) or `Analytics will be enabled for your Claude Code sessions in the project:` followed by the project path (Project), then a blank line, identical for allowlist absent, `[]` and non-empty; without `codeMieUrl` the URL line is absent; the project appears exactly once and no top-level `Project:`/`Projects:` line exists; a path containing spaces stays on one line even in a narrow terminal; an invalid allowlist adds the "cannot be read and will be replaced" line plus a blank line above the message in both scopes; both messages are worded in parallel and contain no "we"; negative assertions for every string in criterion 10 (`Already enabled`, `About to add`, `not yet configured`, `are configured`, `already enabled`, `currently collected`, `Please confirm`) and that no existing project path from the allowlist appears; with `process.stdout.columns` stubbed to 30 every wrapped message line starts at column 0 and is at most 30 characters, with columns undefined at most 80.
- Prompt: with `inquirer.prompt` mocked, `{ enable: true }` resolves `'enable'`, `{ enable: false }` resolves `'cancel'`, a rejection named `ExitPromptError` resolves `'cancel'`, any other rejection propagates; the prompt is called once with `type: 'list'` and choices `Confirm` then `Decline`; the message is printed before the prompt and the screen-clear escape is never written.
- Post-start output (existing orchestrator tests): replace the `Tracked projects` assertions with negative ones — output has `Using profile`, `Scope`, the success line and the restart line, and contains none of `Tracked projects`, `wired to codemie hook`, `OTel env var`, `Backup written`; no row is labelled `Profile`; CodeMie URL row unchanged.
- Existing silent / non-interactive / decline / wiring tests keep passing unchanged.

- [ ] **Step 1:** Rewrite the prompt tests and the orchestrator output assertions above; run only those two files and confirm they fail for the right reason (old view, old output).
- [ ] **Step 2:** Rewrite `analytics-confirmation.ts` as the message builder plus inquirer prompt; remove the dead raw-mode code.
- [ ] **Step 3:** Trim `runClaudeCodeOtlp` and simplify `confirmClaudeCodeOtlp`; fix the orchestrator comment.
- [ ] **Step 4:** Update `docs/COMMANDS.md` as listed; re-check `README.md`.
- [ ] **Step 5:** Run `npx tsc --noEmit` and the two test files; lint the changed files.

**Out of scope (follow-up ticket):** a status command (for example `codemie proxy status`) that shows tracked projects, wired hook events, OTel env vars, settings path and backup. Nothing in this ticket adds it.
