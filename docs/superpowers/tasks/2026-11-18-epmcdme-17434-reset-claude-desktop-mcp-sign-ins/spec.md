# Reset Claude Desktop MCP sign-ins - Spec

EPMCDME-17434 · story `story.md` (approved) · size M (15/36)

## Goal

`codemie proxy reset-mcp-auth --claude-desktop` removes the `custom3pMcpOAuth` entry from Claude Desktop's own `<Claude-3p>/config.json`, so a user whose MCP token could not be refreshed can sign in again without hand-editing a credential file whose folder differs per OS.

## Today (analysis P1-P3)

- No CodeMie code touches `<Claude-3p>/config.json`. `disconnect --claude-desktop` (`connectors/desktop.ts:979-1063`) edits only `configLibrary/`, and only what `connect` wrote (`:969-978`).
- `getClaudeDesktopBaseDir()` (`claude-desktop.paths.ts:5-36`) already yields the AC2 directories and throws `ConfigurationError` on other platforms.
- `disconnect` failures append the parser's message (`desktop.ts:993-996,1011-1014`); it can quote the input, so AC4 forbids copying that.
- Assumed, unverified Desktop behaviour: removing the entry restores sign-in; the file is confirmed on Linux only. AC10 settles both.

## Behavior

New `proxy` subcommand `reset-mcp-auth` with a `--claude-desktop` flag. No flag: list the clients it can reset, change nothing. With the flag: read `config.json` in the Claude-3p base directory, remove `custom3pMcpOAuth`, rewrite the file atomically with permissions kept and every other key unchanged, print the cleared server names and the restart and Reconnect steps. The daemon and `configLibrary/` are not touched.

| Situation | Output | Exit |
|---|---|---|
| Entry holds servers | server names, restart + Reconnect | 0 |
| Entry removed, not an object | "sign-ins cleared", no names, restart + Reconnect | 0 |
| Entry absent or empty | nothing to clear; file untouched | 0 |
| File missing | path checked | 1 |
| Unreadable, invalid JSON, not an object | path, kind, "not changed" | 1 |
| Rewrite fails | path, kind, file as it was | 1 |
| Unsupported platform | fixed text naming the platform; nothing changed | 1 |

Contract: the file logic takes `baseDir`, throws for none of these rows and returns one result per row (cleared, nothing, missing, unreadable, invalid-json, not-object, write-failed), each with the path and, for system errors, the error code. A parse failure is caught without keeping its message, so no excerpt exists to forward. The handler alone owns message text, log lines and exit code: one catch around the whole action, `getClaudeDesktopBaseDir()` included, prints fixed text, the path and the code, logs the code and never file-derived text, and sets `process.exitCode`. The nearest handlers forward `error.message` (`disconnect-orchestrator.ts:81-86`, `connect-orchestrator.ts:320-331`) and are not templates. A rename blocked on Windows (EBUSY, EPERM, EACCES) prints AC12's re-run line.

## Approaches

- **New subcommand and module (chosen).** Fits D2; handler beside `disconnect-orchestrator.ts`, file logic taking `baseDir`.
- **Fold into `disconnect` / `removeDesktopConfig` (ruled out).** `--claude-otlp` expands to Claude Desktop (`analytics-clients.ts:63`), so analytics disconnects would wipe sign-ins.

## Acceptance criteria

- AC1: Saved sign-ins in `config.json` -> the `custom3pMcpOAuth` entry (all servers) is removed, every other setting unchanged, and the command ends by telling the user to fully quit and restart Desktop, then press **Reconnect** on each MCP server under Customize → Connectors. (story AC1)
- AC2: The file is `config.json` directly in `~/.config/Claude-3p/` (Linux, honouring `XDG_CONFIG_HOME`), `~/Library/Application Support/Claude-3p/` (macOS) or `%LOCALAPPDATA%\Claude-3p\` (Windows). (story AC2)
- AC3: No entry, or an empty one -> nothing changed, "nothing to clear", exit 0. (story AC3)
- AC4: Cleared servers are named. On every outcome and log level nothing printed or logged holds a token value or an excerpt of `config.json`; failures name the path and kind of failure, not the parser's text. (story AC4)
- AC5: The proxy keeps running; Desktop's gateway settings and managed MCP server list are unchanged. (story AC5)
- AC6: No client flag -> lists the clients it can reset, changes nothing. (story AC6)
- AC7: Missing `config.json` -> message naming the path checked, nothing changed, non-zero exit. (story AC7)
- AC8: Unreadable or invalid-JSON `config.json` -> message naming the path and saying the file was not changed, no content quoted, non-zero exit. (story AC8)
- AC9: `codemie proxy --help`, `docs/COMMANDS.md` and `README.md` list the command with the restart and Reconnect steps. (story AC9)
- AC10: On each of macOS, Windows and Linux, with Desktop open: run the command, quit and reopen Desktop, press Reconnect. The file was at the AC2 path, the entry stayed gone (absent after the reopen, after a second quit and after Desktop's next write to `config.json`, seen by its mtime), other settings are intact, sign-in works; the result per OS goes in the merge request. If the entry returns, the closing message says: quit Desktop first, run the command, then start Desktop. (story AC10)
- AC11: A failed rewrite -> message naming the path and kind of failure, file as it was, non-zero exit.
- AC12: The closing message also says: if the sign-ins come back, quit Desktop, run this command again, then start Desktop; `--help`, `docs/COMMANDS.md` and `README.md` carry the same line.
- AC13: AC4 check: a sentinel string in an invalid `config.json`, and one in a valid one beside the removed entry, appears in no stdout, stderr or log line at any level; a manual run recorded with AC10, or a test if one is requested.

## Non-goals

- NG1: Quitting, relaunching or pressing Reconnect for the user. (story NG1)
- NG2: Finding why an expired token cannot refresh over the proxy. (story NG2)
- NG3: A backup copy of `config.json`. (story NG3)
- NG4: Clients other than Claude Desktop. (story NG4)
- NG5: Clearing one named server. (story NG5)
- NG6: Detecting or warning that Desktop is running. (story NG6)
- NG7: The Windows 10 MSIX directory and `%APPDATA%\Claude-3p\`. (story NG7)

## Decisions

- D1: Which MCP sign-ins does the command clear? → All servers: the whole `custom3pMcpOAuth` entry — user
- D2: Command name and invocation → `codemie proxy reset-mcp-auth --claude-desktop`, the client-flag style of `connect` and `disconnect` — user
- D3: What if Claude Desktop is running? → No detection; clear the entry and tell the user to restart Desktop — user
- D4: Out of scope → restart or re-sign-in automation, root-cause fix, backup of `config.json`, other clients — user
- D5: Where is `config.json` on each OS? → Directly in the documented Claude-3p directory (AC2); confirmed on Linux only, so AC10 makes per-OS verification a release criterion — proposed by PO
- D6: Missing file versus missing entry → a missing file is an error (AC7); a file with no sign-ins is a no-op success (AC3) — proposed by PO
- D7: Other documented Windows locations? → No; only `%LOCALAPPDATA%\Claude-3p\` (NG7) — user
- D8: Does AC4's no-credential rule cover failures? → Yes, every outcome and log level; failures name path and kind, not parser text — proposed by PO: architecture review
- D9: Where is the check that sign-in comes back? → AC10, per OS, in the merge request, "stayed gone" meaning absent after the reopen, after a second quit and after Desktop's next write; if the entry returns the message becomes quit-first, no Desktop detection — proposed by PO: architecture review
- D10: How does the user sign in again? → Press **Reconnect** on each MCP server under Customize → Connectors; `mcp auth` is not used — user
- D11: What does the closing message say if Desktop writes the entry back? → AC1's steps plus "if the sign-ins come back, quit Desktop, run this command again, then start Desktop" (AC12), over a message that is right only if the entry stays gone — proposed by PO: architecture review
- New subcommand over extending `disconnect`, whose scope is what `connect` wrote and whose aggregates include Claude Desktop.
- New module taking `baseDir` over growing `connectors/desktop.ts` (over 1,000 lines); `baseDir` matches how its functions are tested (`desktop.test.ts:1384-1394`).
- `getClaudeDesktopBaseDir()` over a command-local path table: it already resolves the AC2 paths.
- `writeJsonFileAtomic` (`src/utils/atomic-write.ts:49`) over plain `writeFile`: atomic, keeps file mode; costs a re-indent of Desktop's tab-indented file to 2 spaces, JSON content unchanged.
- Entry absent, `null` or `{}` is nothing to clear; any other value is removed whatever its type (names printed only for an object), over failing on an unexpected shape.
- A top-level value that is not a JSON object fails as unreadable, file not changed, over treating it as empty.
- Failure messages from fixed text, the path and the error code over forwarding `error.message`.
- File logic returns a closed result and the handler owns text, logs and exit code, over throwing from the file logic and catching in the handler: one throw site or catch that forwards `error.message` breaches AC4.
- A rename blocked on Windows prints the re-run line (AC12) over the failure text alone: an open Desktop is the likely holder (assumed; AC10 on Windows shows it).
- Logs carry path, outcome and server count, never server names, over logging names.
- Bare invocation exits 0 over non-zero: AC6 names no code and bare `disconnect` prints its list and exits 0 (`disconnect-orchestrator.ts:257-263`).
