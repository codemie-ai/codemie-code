# Proxy and Analytics Commands

How the `codemie proxy` and `codemie analytics` commands fit together, which one to reach for, and what changed from the old forms. For the full option reference see [Commands](COMMANDS.md); for report details see [Analytics Report](ANALYTICS-REPORT.md) and [Analytics Sync](ANALYTICS-SYNC.md).

## The command groups

| Group | Commands | Purpose |
| --- | --- | --- |
| Daemon | `codemie proxy start`, `stop`, `restart`, `status` | Run the one local proxy every client shares. `status` prints facts only (state, URL, port, profile, version); it adds one `Issues found` line when something is wrong. |
| Diagnosis | `codemie proxy doctor [--verbose] [--json]`, `codemie proxy clients [--json]` | `doctor` names what is wrong and the command that fixes it. `clients` lists every client and analytics connector: connected or not, config location, scope. |
| Clients | `codemie proxy connect --<target>`, `codemie proxy disconnect --<target>\|--all` | Point an application at the proxy (`--claude-desktop`, `--vscode`, `--vscode-claude-code`, `--codex-desktop`, `--omp`) or install an analytics connector (`--claude-code-otlp`, `--copilot-cli-otlp`, `--copilot-chat-otlp`). |
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
codemie proxy connect --claude-code-otlp        # Claude Code usage in analytics
codemie proxy connect --copilot-cli-otlp        # Copilot CLI usage in analytics
codemie proxy connect --copilot-chat-otlp       # VS Code Copilot Chat usage in analytics
codemie proxy clients                           # confirm what is connected
```

Targets combine in one run (`codemie proxy connect --claude-desktop --vscode`). Run `codemie proxy connect` with no target to list them. Restart the application the command names afterwards.

### Analytics are not arriving

```bash
codemie proxy doctor
codemie proxy doctor --verbose
```

`doctor` checks the daemon, each client's key and port, the connectors and the delivery queue, and prints the command that fixes each finding. `--json` gives the same for scripts.

### Exclude and re-include a project

```bash
codemie proxy analytics exclude      # stop collecting for the current project
codemie proxy analytics include      # collect it again
codemie proxy analytics status       # what is collected right now, and why
```

To pause everything, use `codemie proxy analytics disable`; `enable` resumes it.

### Project scope versus user scope

```bash
codemie proxy connect --claude-code-otlp                    # user scope: every project
codemie proxy connect --claude-code-otlp --scope project    # only the current project
codemie proxy disconnect --claude-code-otlp --scope project
```

Project scope writes to the repository's own settings and tracks only that project; user scope writes your user-level settings. `codemie proxy clients` shows which scope each connector holds.

### Grant work-folder consent

```bash
codemie proxy analytics consent grant      # allow collection from the current folder
codemie proxy analytics consent list       # review granted folders
codemie proxy analytics consent revoke     # withdraw it
```

### Disconnect everything

```bash
codemie proxy disconnect --all             # everything `proxy clients` shows as connected
codemie proxy disconnect --all --stop      # and stop the daemon
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
| `codemie proxy connect --force` | `codemie proxy connect --restart-daemon --overwrite` | 2026-12-31 |
| `codemie proxy connect --silent` | `codemie proxy connect --yes` | 2026-12-31 |
| `codemie analytics --include-external` | `codemie analytics --include-external always` | 2026-12-31 |
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
