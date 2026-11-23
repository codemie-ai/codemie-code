# Warn when another agent install shadows the one just installed — Story

**Date**: 2026-11-17
**Status**: Draft
**Ticket**: EPMCDME-16969 (GitHub issue #493)

---

## Context

- `codemie install <agent>` prints success once the package manager exits cleanly. It never checks that the agent command on the user's PATH is the one just installed.
- Whether an agent counts as installed comes from one shared lookup: "is any command with this name on PATH". It does not matter where it resolves, so every agent (OpenCode, Codex, Copilot CLI, Kimi, Claude and others) behaves the same way. `codemie list`, `codemie install`, `codemie uninstall`, `codemie doctor` and agent launch all use it.
- The agent that actually starts is the first match on PATH. A stale install earlier on PATH wins over the fresh one, and nothing tells the user.
- For the `codemie` command itself, the self-update flow already compares the first match on PATH with the version just installed. When they differ it prints a "put X ahead of Y on your PATH" warning with cleanup steps. Agents have no equivalent. The shadow check named in the ticket (`isShadowedCodemieShim`) does not compare PATH positions. It only recognises one specific bundled-package case, so it is not a model for this story.
- The Windows installer only appends to the user PATH, and only in `portable` mode. It never reorders PATH, and it cannot change Machine-level PATH entries, which Windows resolves before user ones.
- No automated test covers the Windows installer. Command lookup in the CLI is covered by unit tests with mocked system calls.

---

## Complexity

**Size**: M (18/36) · **Recommended flow**: sdlc-standard

Four surfaces (install, list, doctor, agent launch) consume one new shadow check. It needs the full list of PATH matches, which the shared command lookup (about 16 callers) discards today. The existing `codemie` stale-install check is a clear model.

---

## Story

**As a** Windows user installing an AI agent through CodeMie, **I want** CodeMie to tell me when a different copy of that agent earlier on my PATH would run instead of the one it just installed, **so that** I don't see "installed successfully" and then get a missing or outdated agent with no explanation.

---

## Background

Reporter of issue #493 ran `codemie install opencode` on Windows. It reported success, but `codemie-opencode` and `codemie list` then reported OpenCode as not installed. The reporter traced this to CodeMie's npm location not being first on PATH, so an older shim in another folder kept winning. Any user with leftover installs from a previous setup can hit the same thing, and today CodeMie gives no hint about the cause. The related fix for PR #588 handled stale CodeMie shims but left this case open.

---

## Acceptance Criteria

- [ ] AC1: Given an agent command on PATH resolves to an install other than the one `codemie install <agent>` just made, when the install finishes, then CodeMie shows a warning that names both locations. It shows the command to put the new location ahead of the old one on the user PATH, says a new terminal is needed, and also names the other remedy (remove or rename the stale copy, or edit the machine-wide PATH as administrator) because the user PATH change does not help when the stale copy sits in a machine-wide PATH folder.
- [ ] AC1a: Given the same shadowed state, when the user runs `codemie install <agent>` again and CodeMie finds the agent already installed, then the same shadowing warning is shown instead of a bare "already installed" message.
- [ ] AC2: Given the same shadowed state, when the user runs `codemie list`, then the affected agent is marked as shadowed, with the active location and the expected CodeMie location. It is not shown as plainly installed or plainly missing.
- [ ] AC3: Given the same shadowed state, when the user runs `codemie doctor`, then the agents check reports the shadowing as a warning with a hint on how to fix it.
- [ ] AC4: Given the same shadowed state, when the user launches the agent (for example `codemie-opencode`), then CodeMie warns that the agent being started is not the CodeMie-managed install, naming its location, before starting it.
- [ ] AC5: Given the agent command on PATH resolves to the install CodeMie made, when the user installs, lists, runs doctor or launches, then no shadowing message appears and output is the same as today.
- [ ] AC6: Given no copy of the agent is on PATH, when the user runs `codemie list` or launches the agent, then CodeMie reports it as not installed as it does today.
- [ ] AC7: Given a shadowed agent, when CodeMie shows the warning, then it changes nothing: no PATH edits, no file or shim removal, no reinstall. The user decides what to fix.
- [ ] AC8: Given the PATH check cannot be completed (the system lookup tool fails, or the install location cannot be determined), when the user installs, lists, runs doctor or launches, then CodeMie proceeds as it does today and shows no shadowing message.

---

## Out of Scope

- NG1: Changing the user or machine PATH, or deleting stale shims, from the CLI or the Windows installer. The Windows installer stays append-only.
- NG2: Changing how the Windows installer orders PATH entries. That is the other fix named in the ticket and would be its own story.
- NG3: The macOS and Linux installer scripts.
- NG4: Installing agents differently (for example forcing install into CodeMie's own location).
- NG5: Shadow detection for non-agent tools (for example `sqlite3`, `pipx`, sound players).
- NG6: A test harness for the Windows installer script.

---

## Decisions

- D1: Which fix from the ticket does this story deliver (report shadowing vs reorder PATH in the installer vs both)? → Report only — user.
- D2: How is a shadowed agent defined? → A copy of the agent exists at the location CodeMie manages for it, and the first match on PATH is a different location. When no copy exists at the managed location, no shadowing message is shown (so a user who installed the agent their own way is never warned). — proposed by PO: architecture review (AR-2).
- D3: Does the shadow verdict and warning wording get built separately for agents? → No. It is the same concept as the existing `codemie` stale-install check, shared and extended to agents. The plain "is the agent installed" answer stays yes/no; shadowing is reported alongside it, not as a third installed state. `codemie uninstall` is unchanged. — proposed by PO: architecture review (AR-3).

---

## Open Questions

- OQ1: What does the reporter's `where opencode` and PATH output on issue #493 show? The code as read says a stale copy ahead of the new one makes the agent count as installed (and run the stale one). "Not installed" needs no usable copy found at all, for example CodeMie's folder missing from PATH in that terminal. If the output shows that case instead, the story needs a criterion for it. Recommendation: confirm from the reporter's output before approval; if it cannot be obtained, keep this story on the shadowing case and file the "not installed" cause as a separate item.
- OQ2: Which agents does this story cover? Agents installed through CodeMie's package-manager location have a managed location. Claude and Kimi use their own native installers and do not. Recommendation: cover only agents with a CodeMie-managed location now; native-installed agents are out of scope for this story.
- OQ3: Does the rule apply on Linux and macOS in this story? Recommendation: Windows only for acceptance, because false positives elsewhere are unchecked.

---

## Sources

- /Users/Evgeniy_Galinovskiy/Documents/Projects/codemie-code · repository
