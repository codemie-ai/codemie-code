# Reset Claude Desktop MCP sign-ins — Story

**Date**: 2026-11-18
**Status**: Approved
**Architecture review**: intent, 2026-11-18, 8384e0f45818
**Ticket**: [EPMCDME-17434](https://jiraeu.epam.com/browse/EPMCDME-17434)

---

## Context

- No CodeMie command touches Claude Desktop's own `config.json`. `codemie proxy disconnect --claude-desktop` only edits the gateway and managed-MCP files that `connect` wrote under `configLibrary/`, so saved MCP sign-ins survive both commands.
- Claude Desktop in third-party mode keeps its data in an application-data directory named `Claude-3p`. Anthropic documents it as `~/Library/Application Support/Claude-3p/` (macOS), `%LOCALAPPDATA%\Claude-3p\` (Windows) and `~/.config/Claude-3p/` (Linux). CodeMie already resolves these three locations for `connect`, `disconnect` and `inspect`.
- Anthropic's docs say OAuth tokens of managed MCP servers are stored in that directory, encrypted with the operating system's secure storage, and that a **Reconnect** button under Customize → Connectors is the official remedy when a refresh is rejected. The docs never name `config.json`, `custom3pMcpOAuth` or `mcp auth`; the docs are at claude.com/docs/third-party/claude-desktop (data-storage, mcp-sign-in, configuration-format).
- Observed on a Linux install: `~/.config/Claude-3p/config.json` exists and holds a top-level `custom3pMcpOAuth` entry with one child per MCP server, next to Desktop's own state keys. Its location on macOS and Windows, and the effect of deleting the entry, are not confirmed anywhere in the repo or the docs.
- Desktop-affecting commands tell the user to quit and reopen Claude Desktop, never detect whether it is running, and on a bad or unreadable file stop with a message saying the file was not changed.

---

## Complexity

**Size**: M (15/36) · **Recommended flow**: sdlc-standard

Follows the existing Desktop disconnect pattern, but is the first CodeMie code to edit a credential-bearing file that Desktop owns outside `configLibrary/`, and its behaviour on macOS and Windows is unverified.

---

## Story

**As a** Claude Desktop user whose MCP servers are reached through the CodeMie proxy, **I want** one command that clears Desktop's saved MCP sign-ins **so that** I can sign in to those servers again after a token expired and could not be refreshed.

---

## Background

When an MCP sign-in token expires, Claude Desktop running over the CodeMie proxy cannot reconnect or refresh it, and the user is stuck. Today the only fix is manual: find Desktop's `config.json`, delete the `custom3pMcpOAuth` entry that holds the tokens, restart Desktop and sign in to each server again. The folder differs on macOS, Windows and Linux, and the file holds credentials, so users make mistakes or give up. A single command removes that guesswork.

---

## Acceptance Criteria

- [ ] AC1: Given Claude Desktop's `config.json` holds saved MCP sign-ins, when the user runs `codemie proxy reset-mcp-auth --claude-desktop`, then the `custom3pMcpOAuth` entry (all MCP servers) is removed, every other setting in the file is unchanged, and the command ends by telling the user to fully quit and restart Claude Desktop and then press **Reconnect** on each MCP server under Customize → Connectors to sign in again.
- [ ] AC2: Given Linux, macOS or Windows, when the command looks for the file, then it uses `config.json` directly inside the Claude Desktop third-party application-data directory: `~/.config/Claude-3p/config.json` on Linux (honouring `XDG_CONFIG_HOME`), `~/Library/Application Support/Claude-3p/config.json` on macOS and `%LOCALAPPDATA%\Claude-3p\config.json` on Windows.
- [ ] AC3: Given the file exists and has no `custom3pMcpOAuth` entry, or the entry is empty, when the command runs, then nothing is changed, the command says there was nothing to clear and it exits successfully.
- [ ] AC4: Given the command cleared sign-ins, when it prints its result, then it names the MCP servers whose sign-in was cleared. Whatever the outcome, nothing the command prints or logs, at any log level, contains a token value or an excerpt of `config.json`; failure messages name the path and the kind of failure, not the parser's text.
- [ ] AC5: Given the command is run, when it finishes, then the proxy keeps running and Claude Desktop's gateway settings and managed MCP server list are unchanged.
- [ ] AC6: Given the user runs `codemie proxy reset-mcp-auth` with no client flag, when it starts, then it lists the clients it can reset and changes nothing.
- [ ] AC7 (negative): Given `config.json` does not exist at the location above, when the command runs, then it fails with a message that names the path it checked, changes nothing and exits with a non-zero code.
- [ ] AC8 (negative): Given `config.json` cannot be read or is not valid JSON, when the command runs, then it fails with a message that names the path and says the file was not changed, without quoting the file's content, and exits with a non-zero code.
- [ ] AC9: Given a user reads `codemie proxy --help` or the commands reference, when they look for MCP sign-in problems, then the new command is listed with the restart and Reconnect follow-up steps.
- [ ] AC10: Given a Claude Desktop install on each of macOS, Windows and Linux, when the command is run with Desktop open, Desktop is then quit and reopened, and the user presses **Reconnect** on an MCP server under Customize → Connectors, then `config.json` was at the AC2 path, the cleared entry has stayed gone, Desktop's other settings are intact and the sign-in works; the result per OS is recorded in the merge request. If the entry comes back, AC1's message instead tells the user to quit Claude Desktop first, run the command, then start Desktop.

---

## Out of Scope

- NG1: Quitting or relaunching Claude Desktop, and pressing Reconnect for the user; the command only tells them to.
- NG2: Finding out why an expired MCP token cannot refresh over the CodeMie proxy.
- NG3: A backup copy of `config.json` before editing.
- NG4: Clients other than Claude Desktop (VS Code, Codex Desktop and so on).
- NG5: Clearing the sign-in of one named MCP server; the command clears all of them.
- NG6: Detecting or warning when Claude Desktop is running.
- NG7: The other documented Windows locations: the Windows 10 (before build 22000) MSIX package directory and the `%APPDATA%\Claude-3p\` directory used by Desktop versions before 1.5186.0.

---

## Decisions

- D1: Which MCP sign-ins does the command clear? → All servers: the whole `custom3pMcpOAuth` entry, as in the manual workaround — user
- D2: Command name and invocation → `codemie proxy reset-mcp-auth --claude-desktop`, the same client-flag style as `connect` and `disconnect` — user
- D3: What if Claude Desktop is running? → No detection; the command clears the entry and tells the user to restart Desktop — user
- D4: Out of scope → restart or re-sign-in automation, root-cause fix, backup of `config.json`, other clients — user
- D5: Where is `config.json` on each OS? → Directly in the documented Claude-3p application-data directory (AC2). The file name is confirmed on Linux only, so AC10 makes verifying it, and the effect of removing `custom3pMcpOAuth`, on a macOS and a Windows Claude Desktop install a release criterion — proposed by PO: Anthropic 3P data-storage docs for the directories; technical analysis P1 for what was observed
- D6: Missing file versus missing entry → A missing file is an error (non-zero exit, AC7); a file with no sign-ins is a success that changes nothing (AC3) — proposed by PO: a fix command that silently succeeds on the wrong path would mislead; this differs from `disconnect`, which treats a missing Desktop config as "nothing to disconnect" with exit code 0, and follows its "file not changed" convention for bad files
- D7: Should the command also look in the other documented Windows locations (Windows 10 before build 22000 MSIX directory, and `%APPDATA%\Claude-3p\` for Desktop before 1.5186.0)? → No; Windows 10 before build 22000 and Desktop versions before 1.5186.0 are out of scope (NG7), so only `%LOCALAPPDATA%\Claude-3p\` is used on Windows — user
- D8: Does AC4's no-credential rule also cover failures? → Yes, every outcome and log level; failure messages name the path and the kind of failure, not the parser's text; the `--verbose` clause is dropped because the command has no such flag (D2) — proposed by PO: architecture review
- D9: Where is the check that sign-in comes back after the reset? → AC10, a per-OS check with Desktop open, recorded in the merge request; if the entry returns, the message becomes quit-first, with no running-Desktop detection (D3 stands) — proposed by PO: architecture review
- D10: What does the user do in Claude Desktop to sign in again after the restart? → Press **Reconnect** on each MCP server under Customize → Connectors, the step Anthropic documents; the command's closing message, AC9's docs entry and AC10's check all say so, and the term `mcp auth` is not used — user

---

## Open Questions

- None
