# Proxy and Analytics CLI Redesign — Story

**Date**: 2026-11-17
**Status**: Approved
**Architecture review**: intent, 2026-11-17, 40ed78c709ef
**Ticket**: —

---

## Context

- Proxy diagnostics are spread over four commands: `proxy status`, `proxy status --deep`, `proxy analytics status` and `proxy inspect desktop`. None of them gives one verdict, none exits non-zero when something is broken, and `codemie doctor` has no proxy check. Every check a doctor needs already exists as a collector that never throws; today they are all assembled inside the `proxy status` action.
- `proxy status` prints the gateway key in clear text, both as text and as `--json`, and mixes facts with warnings and repair advice.
- Whether a project is tracked depends on three separate lists with mismatched verbs: the project-scope list (`connect --scope project`), the exclusion list (`proxy analytics exclude` / `include`) and work-folder consent (`connect-folder` / `disconnect-folder`). `include` only removes an exclusion and does not make a project tracked. With no connector flag, `enable`, `disable`, `include` and `exclude` act on Claude Code only, while `status` shows every connector. `connect --scope user` clears the project list on purpose, without asking.
- `connect` and `disconnect` don't match: VS Code BYOK can be connected but not disconnected, there is no "disconnect all" and no list of connected clients, and `--force` has six different meanings across five files. `--silent` and `--yes` do the same job under two names. A bare `connect` or `disconnect` exits 0.
- Deprecation is ad hoc. There are two different message styles, both written to stdout. The `--report*` analytics flags passed their announced removal date (Nov 1, 2026) without being removed. The `connect desktop` / `connect vscode` aliases have no removal date. Docs and tips still teach the retired forms. Hints come in at least six formats (`Run:`, `Next step:`, `Repair:`, `Hint:`, …) and appear only on failure. The tip catalog has proxy and analytics tips, but its staleness check validates only top-level command names.

---

## Complexity

**Size**: XL (27/36) · **Recommended flow**: sdlc-autonomous, as one story (user decision D1/D4; the assessment's default would be a split into 5 slices)

The score is one point over the L/XL boundary. Affected layers and the gateway-key security change push it to XL. The assessor's suggested slices (foundation → doctor/status → analytics tracking; connect/disconnect and analytics reporting after the foundation) map onto WP0–WP5, and the plan should follow that order.

---

## Story

**As a** developer or team lead who connects AI clients to CodeMie and relies on CodeMie analytics,
**I want** proxy and analytics commands that are consistent, discoverable and diagnosable from one place,
**so that** I can set up, check, fix and undo my setup without reading the source code or guessing which of four commands explains a problem.

---

## Background

Users connecting Claude Desktop, VS Code, Codex Desktop, oh-my-pi, Claude Code or Copilot through the local proxy can't tell what is connected or why analytics aren't arriving. Answering that today takes three or four commands, and none of them returns a clear pass or fail. Command names are misleading (`include` doesn't include anything), connect and disconnect don't mirror each other, one overloaded `--force` can clobber a user's own client config, and re-running a repair command can silently wipe a tracked project list. Deprecations have broken scripts before: the `--report*` flags were removed without notice and had to be restored three days later. Old forms also linger in docs and tips long after their stated date. This story fixes the command surface as a whole and adds a deprecation standard and discoverability hints, so future changes stay consistent.

The story is delivered in this order of work packages, each leaving the CLI releasable:
- **WP0:** discoverability and the deprecation standard
- **WP1:** `proxy doctor`
- **WP2:** facts-only `proxy status`
- **WP3:** project tracking in `proxy analytics`
- **WP4:** `connect` / `disconnect` symmetry
- **WP5:** `codemie analytics` reporting cleanup
- **WP6:** documentation

---

## Acceptance Criteria

### WP0 — Discoverability and deprecation standard

- [ ] AC1: Given any `proxy` or `analytics` command or subcommand, when the user runs it with `--help`, then the help ends with a "Related commands" section listing the other commands of the same group that a user would logically run next, each with a one-line purpose.
- [ ] AC2: Given a `proxy` or `analytics` command that succeeds in an interactive terminal, when it finishes, then it prints at most one "Next:" line naming the most relevant follow-up command for what just happened (e.g. after connecting Claude Code analytics: `proxy doctor` to verify, `proxy analytics exclude` to skip a project).
- [ ] AC3: Given a command run with `--json`, when it finishes, then no "Next:" line or tip is written, stdout carries only the JSON, and a deprecation notice (if any) still goes to stderr. Given a command run from an agent hook or as the scheduled sync job, nothing extra is written at all, deprecation notices included.
- [ ] AC4: Given any fix advice printed by `proxy`, `analytics` or `doctor` commands, when it is shown, then it uses one consistent hint format instead of the current `Run:` / `Next step:` / `Repair:` / `Hint:` / `To withdraw it, run:` variants.
- [ ] AC5: Given the tip catalog, when the work is done, then it includes tips for `proxy doctor`, `proxy analytics` (enable/disable, include/exclude, consent), the Claude Code and Copilot analytics connectors, `proxy clients` and `analytics sync`, and no tip teaches a deprecated or removed form.
- [ ] AC6: Given a tip whose example command uses a subcommand or flag that no longer exists or is deprecated, when `codemie tips` validates the catalog, then that tip is flagged, and an automated check fails the build.
- [ ] AC7: Given a deprecated command, subcommand or flag, when a user invokes it, then it still works and prints exactly one line to stderr naming the replacement and the removal date. Deprecated forms are hidden from `--help`.
- [ ] AC8: Given a deprecated form, when its removal date (by default one month after the release that deprecates it) has passed and the form is still registered, then an automated check fails the build on the default branch. On any other branch (feature or hotfix), the same check only warns.
- [ ] AC8a: Given a release that deprecates one or more forms, when it ships, then a removal ticket exists listing those forms, their removal date and an owner.
- [ ] AC9: Given a release that deprecates or removes a form, when the CHANGELOG is updated, then it has a "Deprecated" (or "Removed") section listing old form → new form → removal date.

### WP1 — `codemie proxy doctor`

- [ ] AC10: Given a connected setup, when the user runs `codemie proxy doctor`, then it reports one verdict (ok / warn / error) per section: daemon, authentication and upstream reachability, connected clients and their config drift (wrong port, shared key, another installation's hooks), analytics connectors (a verdict per connector — collection on/off, corrupt preferences or scope files, Claude Code telemetry endpoint mismatch — pointing to `proxy analytics status` for the tracked and excluded project lists), analytics delivery (unsent data, next retry, last dropped reason), Claude Desktop collection, and environment (an older CodeMie CLI on PATH).
- [ ] AC11: Given any warn or error finding, when doctor reports it, then it gives one fix hint with the exact command to run. A repair hint for an analytics connector includes the connector's current `--scope`.
- [ ] AC12: Given an expired SSO session, when the user runs `proxy doctor`, then the authentication section is an error naming `codemie profile login`, even though the daemon itself answers.
- [ ] AC13: Given at least one error finding, when doctor finishes, then it exits non-zero. Given only ok and warn findings, it exits 0.
- [ ] AC14: Given no client or analytics connector is connected and the daemon isn't running, when the user runs `proxy doctor`, then it says nothing is connected, names `codemie proxy connect` as the next step, and does not report an error.
- [ ] AC15: Given `proxy doctor --json`, when it runs, then it prints only one JSON document containing every section with its verdict, message and hint, and the gateway key is not included.
- [ ] AC16: Given `proxy doctor --verbose`, when it runs, then it also prints the details `proxy inspect desktop` shows today (Claude Desktop storage directories, recent sessions and why each is or isn't eligible) and the config file paths.
- [ ] AC17: Given `codemie doctor`, when it runs, then it includes a condensed proxy section using the same checks as `proxy doctor` and pointing to `codemie proxy doctor` for detail. A proxy warning alone does not make `codemie doctor` exit non-zero; a proxy error does. A machine with nothing connected is reported as information, not as a failure.

### WP2 — Facts-only `proxy status`

- [ ] AC18: Given a running daemon, when the user runs `proxy status`, then it prints facts only (state, URL, port, profile, project, CLI version, uptime) plus, when anything is wrong, a single line saying "Issues found — run: codemie proxy doctor". Warnings and repair advice are no longer printed there.
- [ ] AC19: Given `proxy status` with or without `--json`, when it runs, then the gateway key is masked. Given `--show-key`, it is shown in full.
- [ ] AC20: Given `proxy status --deep` or `proxy inspect desktop`, when the user runs either, then it still works for the deprecation period, prints the deprecation notice pointing to `proxy doctor` / `proxy doctor --verbose`, and is hidden from help.
- [ ] AC21: Given a stopped daemon, when the user runs `proxy status`, then it reports "stopped" (in `--json`, `{"status":"stopped"}`) as it does today.

### WP3 — Project tracking in `proxy analytics`

- [ ] AC22: Given an analytics connector (Claude Code, Copilot CLI or Copilot Chat) in project scope and a project that isn't tracked, when the user runs `proxy analytics include <path>` for it, then the project becomes tracked by that connector (removed from its exclusions and added to its own project list) and the command confirms it is now tracked.
- [ ] AC23: Given a project tracked by a connector, when the user runs `proxy analytics exclude <path>` and then `include <path>` for that connector, then the project ends up tracked again. The two commands are exact inverses for every connector.
- [ ] AC24: Given a project excluded through a parent folder, when the user runs `include` on the child, then the command explains that the parent's exclusion still applies and names the command that removes it, without reporting success.
- [ ] AC25: Given several connected analytics connectors and no connector flag, when the user runs `proxy analytics enable`, `disable`, `include` or `exclude`, then it applies to every connected connector and says which ones it changed. A connector flag limits it to that connector.
- [ ] AC26: Given no connected analytics connector, when the user runs `proxy analytics disable` without a flag, then it fails with a non-zero exit and names `codemie proxy connect` with the available connector flags.
- [ ] AC27: Given `proxy analytics consent grant [path]`, `consent revoke [path]` and `consent list`, when the user runs them, then they grant, withdraw and list work-folder consent with the same confirmation and coverage behaviour `connect-folder` / `disconnect-folder` have today. The old names keep working as deprecated aliases.
- [ ] AC28: Given `proxy analytics status`, when it runs, then it shows each connector's configuration (scope, tracked projects, excluded projects, collection on/off, consented folders), and points to `proxy doctor` for delivery and health.

### WP4 — `connect` / `disconnect` symmetry

- [ ] AC29: Given VS Code (or Insiders with `--insiders`) connected through `--vscode`, when the user runs `proxy disconnect --vscode`, then the CodeMie models are removed from VS Code and models the user added themselves are kept.
- [ ] AC30: Given several connected clients and analytics connectors, when the user runs `proxy disconnect --all`, then every one of them is disconnected and each is reported. The daemon keeps running unless `--stop` is also given.
- [ ] AC31: Given any setup, when the user runs `proxy clients` (and `--json`), then it lists every supported client and analytics connector with connected / not connected, its config location and, for analytics connectors, its scope. Tracked and excluded project lists are left to `proxy analytics status`, which is the only command that lists them.
- [ ] AC32: Given a client config that wasn't written by CodeMie (another Codex provider, a user's own oh-my-pi extension, conflicting Claude settings, an invalid project list), when the user runs `connect` without `--overwrite`, then nothing is changed and the error names `--overwrite`. `--force` no longer replaces such config.
- [ ] AC33: Given a healthy running daemon, when the user runs `connect … --restart-daemon`, then the daemon is replaced, and no client config that CodeMie didn't write is overwritten.
- [ ] AC34: Given `--force`, when the user passes it during the deprecation period, then it behaves as `--restart-daemon --overwrite`, as today, and prints the deprecation notice naming both replacements.
- [ ] AC35: Given `--silent`, when the user passes it during the deprecation period, then it behaves as `--yes` and prints the deprecation notice. `--yes` skips every confirmation prompt of `connect` and `proxy analytics`.
- [ ] AC36: Given any analytics connector (Claude Code, Copilot CLI or Copilot Chat) in project scope with tracked projects, when the user runs `connect` for it with `--scope user` or with no `--scope` at all, interactively, then it lists the projects that will be dropped and asks for confirmation. Declining changes nothing for that connector.
- [ ] AC37: Given the same situation in a non-interactive environment without `--yes`, when connect runs, then it fails with a non-zero exit before changing anything, and names `--yes`.
- [ ] AC38: Given `--scope`, `--yes`, `--insiders` or `--model` passed without a target they apply to, when connect or disconnect runs, then it warns that the flag has no effect.
- [ ] AC39: Given `proxy connect` or `proxy disconnect` with no target, when it runs, then it prints the target list and exits non-zero.
- [ ] AC40: Given `proxy connect desktop` or `proxy connect vscode`, when the user runs them after this release, then the command fails with a message naming `connect --claude-desktop` / `connect --vscode`. Product messages that suggested the old forms now suggest the new ones.

### WP5 — `codemie analytics` reporting cleanup

- [ ] AC41: Given `--report`, `--report-format` or `--report-output`, when the user passes them after this release, then the command fails with a message naming `--export` / `-o`.
- [ ] AC42: Given an invalid `--from`, `--to` or `--last` value, when the user runs `codemie analytics`, then it fails with a non-zero exit and a message showing the accepted format, instead of ignoring the filter and reporting over all time.
- [ ] AC43: Given `codemie analytics --include-external <windows|always|never>`, when the user runs it, then it accepts the same values with the same meaning as `analytics sync install|bootstrap --include-external`. The bare boolean `codemie analytics --include-external` keeps working through the deprecation period, mapped to its current meaning, and prints the deprecation notice.
- [ ] AC43a: Given a team member whose report sync was set up before this release, when the scheduled sync runs after it, then it keeps working with the stored setting unchanged and no action required.
- [ ] AC44: Given a failure in `codemie analytics`, when it ends, then it exits non-zero without cutting off output that is still being written.

### WP6 — Documentation

- [ ] AC45: Given the docs, when the work is done, then a dedicated page describes the proxy and analytics commands by group (purpose, how the commands relate, when to use which), with worked use cases at least for:
  - first-time setup of each client;
  - "analytics aren't arriving" → `proxy doctor`;
  - excluding and re-including a project;
  - project vs user scope;
  - granting work-folder consent;
  - disconnecting everything;
  - setting up team report sync.
- [ ] AC46: Given the dedicated page, when a user looks up a retired form, then a deprecation table lists old form → new form → removal date.
- [ ] AC47: Given README, `docs/COMMANDS.md`, `docs/ARCHITECTURE-PROXY.md`, `docs/ANALYTICS-REPORT.md`, `docs/ANALYTICS-SYNC.md`, the root `codemie --help` text and the tip catalog, when the work is done, then none of them teaches a deprecated or removed form. An automated check (the tip staleness check plus a scan of the docs) fails if one does.

---

## Out of Scope

- NG1: Renaming the `proxy analytics` group (e.g. to `proxy tracking`).
- NG2: Changing what the daemon collects or sends, the analytics backend contract, or the analytics report contents.
- NG3: An automatic `proxy doctor --fix` that applies fixes. Doctor only names the command.
- NG4: Commands outside the `proxy` and `analytics` groups (e.g. `skill` vs `skills`), except where they print hints that point at retired proxy or analytics forms.
- NG5: Changing the meaning of "user" scope: it still tracks every project and replaces the project list. Only the confirmation is new.
- NG6: Changes to `mcp-proxy`.

---

## Decisions

- D1: How is the work packaged? → One story covering seven work packages (WP0–WP6), delivered in that order with discoverability and the deprecation standard first; not split into child stories even if sizing suggests a split — user
- D2: How long do deprecated forms keep working? → Until a fixed removal date, by default one month after the release that deprecates them; an automated check fails once the date passes. Forms already past due (`--report*`, `connect desktop` / `connect vscode`) are removed in this story — user
- D3: What hints do commands give? → A "Related commands" section in `--help`, a contextual "Next:" line after success, one hint format for all fix advice, and catalog tips with a deeper staleness check — user
- D4: What happens after approval? → The story is run with `sdlc-autonomous` — user
- D5: Does the run open a PR? → Yes. Once implemented and the tests pass, a pull request is created — user
- D6: Is documentation part of the story? → Yes. A dedicated page with details and use cases, a deprecation table, updates to every doc that mentions these commands, and a CHANGELOG section — user
- D7: What does `connect --scope user` do with an existing project list? → It keeps resetting the list, but asks for confirmation first, listing what will be dropped; `--yes` skips the prompt and is required when non-interactive — user
- D8: Does `proxy status` remain? → Yes, as a facts-only command; all diagnosis moves to `proxy doctor` — user
- D9: When does `proxy doctor` exit non-zero? → On error findings only; warnings exit 0, so scripts and CI can tell broken from degraded — proposed by PO: matches the ok/warn/error verdict model and the exit-code convention in `.ai-run/guides/integration/exposed-api.md`
- D10: What does `proxy analytics` act on with no connector flag? → Every connected connector, matching what its `status` already does; it errors when none is connected — proposed by PO: removes the silent Claude-only default that today leaves Copilot collecting after `disable`
- D11: How does the gateway key appear in output? → Masked in `proxy status` (text and `--json`) unless `--show-key`; never included in `proxy doctor` output — proposed by PO: `.ai-run/guides/security/security-practices.md` forbids printing secrets; no in-repo consumer reads the key from `status --json` (technical analysis, Consumers of Changed Contracts)
- D12: What does `--force` become? → It splits into `--restart-daemon` and `--overwrite`; `--force` keeps working during the deprecation period as both together — proposed by PO: today one flag both restarts the daemon and overwrites the user's own Codex, oh-my-pi and Claude settings
- D13: Does `include` act on Copilot's own project lists? → Yes. In project scope, `include` adds the path to the selected connector's own list, for every connector — proposed by PO: architecture review (AR-2)
- D14: What form does `--include-external` take? → The sync form `<windows|always|never>` becomes the one form; stored sync settings are untouched — proposed by PO: architecture review (AR-3)
- D15: Does a proxy warning fail `codemie doctor`? → No, only a proxy error does; "nothing connected" is information — proposed by PO: architecture review (AR-4), keeps D9 consistent across both doctors
- D16: Are deprecation notices shown under `--json`? → Yes, on stderr; they are silent only in hooks and the scheduled sync job — proposed by PO: architecture review (AR-5), so CI scripts see the notice before the removal date
- D17: Which command lists tracked and excluded projects? → Only `proxy analytics status`; `proxy clients` shows connected state, location and scope, and `proxy doctor` gives verdicts and points there — proposed by PO: architecture review (AR-7)
- D18: Where does D7's confirmation apply? → To all three analytics connectors (Claude Code, Copilot CLI, Copilot Chat), on both `--scope user` and a connect with no `--scope` — user
- D19: Which builds does the removal-date check fail, and who removes expired forms? → Only the default branch fails; other branches warn. Each release that deprecates forms gets a dated removal ticket with an owner — user

---

## Open Questions

- None
