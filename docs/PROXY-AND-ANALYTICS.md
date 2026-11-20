# Proxy and Analytics Commands

How the `codemie proxy` and `codemie analytics` commands fit together, which one to reach for, and what changed from the old forms. For the full option reference see [Commands](COMMANDS.md); for report details see [Analytics Report](ANALYTICS-REPORT.md) and [Analytics Sync](ANALYTICS-SYNC.md).

## The command groups

| Group | Commands | Purpose |
| --- | --- | --- |
| Daemon | `codemie proxy start`, `stop`, `restart`, `status` | Run the one local proxy every client shares. `status` prints facts only (state, URL, port, profile, version); it adds one `Issues found` line when something is wrong. |
| Diagnosis | `codemie proxy doctor [--verbose] [--json]`, `codemie proxy clients [--json]` | `doctor` names what is wrong and the command that fixes it. `clients` lists every client and analytics connector: connected or not, config location, scope, and for an analytics client that is not connected the command that connects it. |
| Clients | `codemie proxy connect --<target>`, `codemie proxy disconnect --<target>\|--all` | Point an application at the proxy (`--claude-desktop`, `--vscode`, `--vscode-claude-code`, `--codex-desktop`, `--omp`) or turn analytics on for every client of a vendor (`--claude-otlp`, `--copilot-otlp`). |
| Collection controls | `codemie proxy analytics enable`, `disable`, `include`, `exclude`, `status` | Turn collection on or off everywhere (`enable`/`disable`) or for the current project (`include`/`exclude`) while the hooks stay installed. |
| Consent | `codemie proxy analytics consent grant`, `revoke`, `list` | Allow or stop collection from work folders that are not part of a CodeMie project. |
| Reports | `codemie analytics [--export] [-o] [--open] [--include-external <windows\|always\|never>]` | Read your own usage: sessions, tokens, cost, tools. |
| Team sync | `codemie analytics sync bootstrap`, `install`, `status`, `run`, `uninstall` | Deliver this machine's reports one way to a team webhook and/or git repository on a daily schedule. |

How they relate: `connect` sets a client or connector up, `doctor` and `clients` tell you its state, the `analytics` controls under `proxy` decide whether data is collected, and `codemie analytics` reads what was collected. `disconnect` removes a setup; `disable` and `exclude` only pause collection.

## Use cases

### First-time setup of each client

```bash
codemie proxy connect --claude-desktop          # Claude Desktop app
codemie proxy connect --vscode                  # VS Code Copilot Chat models (BYOK)
codemie proxy connect --vscode-claude-code      # Claude Code extension in VS Code
codemie proxy connect --codex-desktop           # Codex desktop app
codemie proxy connect --omp                     # oh-my-pi
codemie proxy connect --claude-otlp             # Claude Code, VS Code extension and Claude Desktop usage in analytics
codemie proxy connect --copilot-otlp            # Copilot CLI and VS Code Copilot Chat usage in analytics
codemie proxy clients                           # confirm what is connected
```

To turn analytics on for every client of a vendor in one run, use the vendor flags:

```bash
codemie proxy connect --claude-otlp     # Claude Code, the VS Code Claude Code extension and Claude Desktop
codemie proxy connect --copilot-otlp    # Copilot Chat and Copilot CLI
codemie proxy clients                   # each client connected, not connected or not found, with the command to run
```

`--claude-otlp` connects Claude Code analytics, Claude Desktop and the VS Code Claude Code extension. Claude Desktop and the VS Code Claude Code extension are routed through the proxy only when they are not configured yet: the extension when `claude auth status` (with the shell's routing variables stripped) reports no login and its VS Code settings hold no other route or key, Claude Desktop when it has no applied Claude-3p config and no first-party data directory. A local gateway whose key is not CodeMie's counts as another gateway, and disconnect leaves it in place. A client already configured is left as it is and a line says so; an existing route is refreshed. `--claude-desktop` and `--vscode-claude-code` always route their client and print that its model requests now go through the gateway, not the Claude login. `--copilot-otlp` connects Copilot Chat and Copilot CLI. A client whose application is not found is configured all the same and reads `configured (not installed yet — takes effect once installed)`; it works once installed. Without `--scope`, a connector already limited to named projects keeps its list, and no confirmation is asked. `codemie proxy disconnect --claude-otlp` / `--copilot-otlp` reverse them. The earlier per-client analytics flags are deprecated (removal on 2026-12-31, listed under [Deprecated and removed forms](#deprecated-and-removed-forms)): they keep working until then, are hidden from `--help` and print a notice naming the vendor flag.

Targets combine in one run (`codemie proxy connect --claude-desktop --vscode`). Run `codemie proxy connect` with no target to list them. Restart the application the command names afterwards.

### Analytics are not arriving

```bash
codemie proxy doctor
codemie proxy doctor --verbose
```

`doctor` prints one heading per section — Daemon, Authentication and upstream, Clients, Analytics connectors, Analytics delivery, Claude Desktop collection, Environment — each with at least one line (`ok` or `info` when there is nothing to report), the command that fixes each finding, and a closing count such as `2 warnings, 0 errors`. It exits 1 only on an error. `--json` carries every section for scripts.

### Exclude and re-include a project

```bash
codemie proxy analytics exclude      # stop collecting for the current project
codemie proxy analytics include      # collect it again
codemie proxy analytics status       # what is collected right now, and why
```

To pause everything, use `codemie proxy analytics disable`; `enable` resumes it.

### Project scope versus user scope

```bash
codemie proxy connect --claude-otlp --scope user       # user scope: every project
codemie proxy connect --claude-otlp --scope project    # only the current project
codemie proxy disconnect --claude-otlp --scope project
```

Both scopes write the same file, your user-level `~/.claude/settings.json`; no repository settings file is written. User scope tracks every project. Project scope adds only the current project to the tracked-project list in that file (run it again in another repository to add that one too), and `disconnect --scope project` removes only the current project from the list. `codemie proxy clients` shows which scope each connector holds, and `codemie proxy analytics status` lists the tracked projects.

### Grant work-folder consent

```bash
codemie proxy analytics consent grant      # allow collection from the current folder
codemie proxy analytics consent list       # review granted folders
codemie proxy analytics consent revoke     # withdraw it
```

### Disconnect everything

```bash
codemie proxy disconnect --all             # everything `proxy clients` shows as connected
codemie proxy stop                         # and stop the daemon
```

`--all` continues past a failing target, reports each, and exits non-zero if any failed.

### Set up team report sync

```bash
codemie analytics sync bootstrap           # asks where reports are delivered and shows the steps
codemie analytics sync status              # check the schedule and last delivery
codemie analytics sync run                 # send now
```

See [Analytics Sync](ANALYTICS-SYNC.md) for the team-lead and developer steps.

## Deprecated and removed forms

Deprecated forms still work until the removal date and print one notice line on stderr naming the replacement. Removed forms fail with a message naming the replacement and exit non-zero.

### Deprecated

<!-- deprecation-table:start -->
| Old | New | Removal |
| --- | --- | --- |
| `codemie proxy status --deep` | `codemie proxy doctor` | 2026-12-31 |
| `codemie proxy inspect desktop` | `codemie proxy doctor --verbose` | 2026-12-31 |
| `codemie proxy analytics connect-folder` | `codemie proxy analytics consent grant` | 2026-12-31 |
| `codemie proxy analytics disconnect-folder` | `codemie proxy analytics consent revoke` | 2026-12-31 |
| `codemie proxy connect --force` | `codemie proxy connect --overwrite` / `codemie proxy restart` | 2026-12-31 |
| `codemie proxy connect --silent` | `codemie proxy connect --yes` | 2026-12-31 |
| `codemie analytics --include-external` | `codemie analytics --include-external always` | 2026-12-31 |
| `codemie proxy connect --claude-code-otlp` | `codemie proxy connect --claude-otlp` (also connects Claude Desktop and the VS Code Claude Code extension; routes them only when not configured yet) | 2026-12-31 |
| `codemie proxy connect --copilot-chat-otlp` | `codemie proxy connect --copilot-otlp` (connects both Copilot Chat and Copilot CLI) | 2026-12-31 |
| `codemie proxy connect --copilot-cli-otlp` | `codemie proxy connect --copilot-otlp` (connects both Copilot Chat and Copilot CLI) | 2026-12-31 |
| `codemie proxy disconnect --claude-code-otlp` | `codemie proxy disconnect --claude-otlp` (also removes the proxy route of Claude Desktop and the VS Code Claude Code extension) | 2026-12-31 |
| `codemie proxy disconnect --copilot-chat-otlp` | `codemie proxy disconnect --copilot-otlp` (disconnects both Copilot Chat and Copilot CLI) | 2026-12-31 |
| `codemie proxy disconnect --copilot-cli-otlp` | `codemie proxy disconnect --copilot-otlp` (disconnects both Copilot Chat and Copilot CLI) | 2026-12-31 |
| `codemie proxy analytics --claude-code-otlp` | `codemie proxy analytics --claude-otlp` | 2026-12-31 |
| `codemie proxy analytics --copilot-chat-otlp` | `codemie proxy analytics --copilot-otlp` (covers both Copilot connectors) | 2026-12-31 |
| `codemie proxy analytics --copilot-cli-otlp` | `codemie proxy analytics --copilot-otlp` (covers both Copilot connectors) | 2026-12-31 |
<!-- deprecation-table:end -->

### Removed

<!-- deprecation-table:start -->
| Old | New | Removal |
| --- | --- | --- |
| `codemie proxy connect desktop` | `codemie proxy connect --claude-desktop` | 2026-12-31 |
| `codemie proxy connect vscode` | `codemie proxy connect --vscode` | 2026-12-31 |
| `codemie analytics --report` | `codemie analytics --export` | 2026-12-31 |
| `codemie analytics --report-format` | `codemie analytics --export <format>` | 2026-12-31 |
| `codemie analytics --report-output` | `codemie analytics -o <path>` | 2026-12-31 |
<!-- deprecation-table:end -->
