---
schema_version: 1
id: opencode-session-resume-windows
mode: single
repository: codemie-code
children: []
---
# codemie-opencode resumes an OpenCode session with `-s <session-id>` — Story

**Date**: 2026-11-17
**Status**: Approved
**Architecture review**: intent, 2026-11-17, 52d600ed77f6
**Ticket**: EPMCDME-15955

---

## Context

- Every `codemie-<agent>` launcher shares one argument parser. It registers `-s` as the short form of `--silent` (a value-less flag) for every agent except codex and gemini, which are opted out because their own CLIs use `-s`.
- For `codemie-opencode -s <session-id>` the launcher therefore consumes `-s` as "silent" and passes the session ID on as a bare positional argument. OpenCode reads a leading bare positional as a project directory, which matches the reported "Failed to change directory to `<cwd>\<session-id>`" error. The launcher has no directory option and never changes directory itself, so the ticket's first guess (an option that captures the ID) does not hold. The message itself comes from the OpenCode binary and was not reproduced in this analysis.
- `-s <id>` is OpenCode's native resume option: the launcher's own `--resume <id>` already becomes `-s <id>` for OpenCode, and that path works.
- Session tracking for resumed runs recognises only the long native form `--session`. It assumes `-s` never reaches OpenCode, so a forwarded native `-s <id>` would resume the session but bypass resume tracking.
- Existing tests pin the current behaviour (`-s` = silent for opencode), the command reference documents it, and no test sends a `ses_*` ID through the real OpenCode plugin or checks Windows argument quoting for IDs.
- Only `codemie-code` is affected. `codemie`, `codemie-ui` and `codemie-sdk` are not touched.

---

## Complexity

**Size**: M (16/36) · **Recommended flow**: sdlc-standard

The change is small in files but sits in the launcher parser shared by all 14 `codemie-*` launchers and in resume helpers shared with sibling agents; the OpenCode binary's behaviour (including v2) is unverified.

---

## Story

**As a** developer using CodeMie CLI with OpenCode on Windows, **I want** `codemie-opencode -s <session-id>` to resume that OpenCode session, **so that** I can continue the session from the command OpenCode prints when it ends, without translating it into a CodeMie-specific form.

---

## Background

When an OpenCode session ends, OpenCode prints `opencode -s <session-id>` as the way to continue it. Developers who launch OpenCode through CodeMie replace `opencode` with `codemie-opencode` and get a directory error instead of their session. The workaround (`--resume`) is not what OpenCode shows, so the failure looks like a CodeMie defect each time and blocks resuming prior work.

---

## Acceptance Criteria

- [ ] AC1: Given an existing OpenCode session ID, when the user runs `codemie-opencode -s <session-id>` from a project directory, then OpenCode receives `-s` and the session ID unchanged and the session resumes.
- [ ] AC2: Given the same command on Windows, when the launcher starts OpenCode, then the arguments OpenCode receives contain `-s <session-id>` and no bare argument equal to the session ID, and the working directory is still the project directory.
- [ ] AC3: Given a resumed run started with `-s <session-id>`, when session tracking and analytics identify the run, then it is recognised as a resumed session of that ID, the same as a run started with `--resume <session-id>` or `--session <session-id>`.
- [ ] AC4: Given the user starts `codemie-opencode` without `-s`, or with `--resume <session-id>`, `--session <id>`, `--continue` or a task option, when the launcher starts OpenCode, then behaviour is the same as before this change.
- [ ] AC5: Given CodeMie launcher options (profile, provider, model, long-form silent and the others the launcher owns) together with native OpenCode options, when the user runs `codemie-opencode`, then the launcher owns only its own options plus `-m` and `--silent`, and `-s` is passed to OpenCode, not swallowed.
- [ ] AC6: Given the user runs `codemie-opencode --silent`, when the launcher starts, then silent mode is on as before (negative: only the short form `-s` changes meaning).
- [ ] AC7: Given the user runs `-s` through any launcher other than `codemie-opencode` (for example `codemie-claude -s`), when the launcher starts, then `-s` still means silent.
- [ ] AC8: Given the change is delivered, when a reader opens the command reference, then it states which launchers treat `-s` as silent, that for `codemie-opencode` `-s <session-id>` resumes a session, and that `codemie-code` behaviour is tracked separately.
- [ ] AC9: Automated tests cover `-s <ses_*>` through the real OpenCode launcher path (including the arguments OpenCode receives, and that a `ses_*` ID is not quoted or altered on Windows), `--silent` unchanged, other launchers unchanged, and resume tracking for `-s`; the test that now expects `-s` to be silent for OpenCode is updated to the new rule.

---

## Out of Scope

- NG1: Changing the OpenCode binary, or how OpenCode itself treats a bare positional argument.
- NG2: Launchers for other agents (claude, kimi, pi, copilot and the rest); their native meaning of `-s` was not verified.
- NG3: The wrapper's `-m, --model` short flag, which has the same wrapper-versus-upstream ambiguity.
- NG4: New resume features or changes to `--resume` behaviour.
- NG5: `codemie-opencode-acp` (the IDE/stdio launcher): it has no resume path and no user who resumes through it was named.
- NG6: A bare session ID without `-s` (`codemie-opencode ses_x`), which OpenCode still reads as a directory.

---

## Decisions

- D1: Which side owns `-s` for `codemie-opencode` → the launcher stops treating `-s` as silent and forwards it to OpenCode; long-form `--silent` stays. The existing per-launcher opt-out (the one codex and gemini use, matched on exact launcher name) is reused, so launchers under other names are not covered. — proposed by PO: `-s` is OpenCode's native resume option, the launcher already maps `--resume` to it, and the opt-out already exists (`technical-analysis.md` §2); architecture review AR-2.
- D2: Which launchers are in scope → `codemie-opencode` only; `codemie-opencode-acp` is excluded (NG5). — proposed by PO: architecture review AR-3; the ACP launcher has no resume path (`opencode-acp.plugin.ts` disables the `--resume` mapping and runs over stdio).
- D3: Non-interactive callers that relied on `-s` as silent for OpenCode → no compatibility shim; non-interactive runs are already silent automatically and `--silent` remains. — proposed by PO: only interactive use of the short form changes (`technical-analysis.md` §2, Consumers).
- D4: The OpenCode binary's behaviour on `-s <id>` and a bare positional, including v2, is not verifiable from the repository → the acceptance check is that OpenCode receives exactly `-s <session-id>`, confirmed by the launcher's tests, plus one manual resume on Windows before the story is closed. — proposed by PO: the analysis could not run the binary.
- D5: Should the built-in `codemie-code` agent get the same `-s` treatment → no; it is tracked as a separate ticket, and this story only documents that (AC8). The ticket's owner is assigned when it is created. — user

---

## Open Questions

- None
