# Codex session metrics lose file edits and active time — Story

**Date**: 2026-11-10
**Status**: Approved
**Architecture review**: intent, 2026-11-10, efab90590a61
**Ticket**: EPMCDME-17102

---

## Context

- Codex edits files with its `apply_patch` tool. In the Codex rollout this call is a custom tool call, not a regular function call. The per-call metrics that the CLI sends to the platform are built only from regular function calls, so every `apply_patch` call is dropped and no metric record carries file operations or lines.
- A parser for `apply_patch` patches already exists in the Codex plugin. It feeds only the local parsed-session summary, not the records that the CLI syncs to the platform. It has no call identity, reports an added file as an edit (the opencode and Copilot CLI plugins report it as a write), ignores moved files, and takes the call status as the patch result, although Codex writes "completed" before the patch is applied. The fix uses one per-call parse for both the synced records and the local summary.
- Codex reports the result of each patch in its own events (success flag and changes per file). No code reads them today.
- Active time is counted between the prompt-submit and stop hooks. Codex fires no prompt-submit hook, so active time stays 0 for every Codex session, and the session end metric leaves the field out. The Pi plugin has the same limit and measures from first to last record, idle time included. Unlike Pi, Codex marks the start and end of each turn, so active time can be the sum of the turns, as with the prompt-submit and stop hooks.
- Evidence (CLI 0.16.6, macOS, provider AI/Run SSO, `codemie-codex`, 2026-11-10): one Codex run with 11 rollouts (main session + sub-agents) holds 37 `apply_patch` calls, all of them in sub-agent rollouts (the sub-agent rollouts already reach the synced records for regular tool calls). Its metrics file holds 358+ records: no `apply_patch`, no file operations, `activeDurationMs: 0`. Earlier runs on three tasks (2026-11-05/06) show the same: `codemie analytics` reports File Operations 0 and Lines +0 −0 although the branches hold 5–41 changed files.

---

## Complexity

**Size**: M (17/36) · **Recommended flow**: sdlc-standard

Requirements are clear, but the fix touches 3–4 Codex plugin components plus the core session store, needs a new shared per-call patch parse, and has Codex-specific risks (patch result source, new-file type change in native analytics, double-count of active time on the shared session-end path, resume dedupe) that no existing Codex test covers.

---

## Story

**As a** developer who works through `codemie-codex`, **I want** my file edits and active time to reach CodeMie analytics **so that** my Codex work is not reported as zero code and zero time next to the same work done with other agents.

---

## Background

Teams compare agent usage and delivered code in CodeMie analytics. For Codex sessions the analytics show tool calls but no changed files, no added or removed lines and no active time, because the edits that Codex makes itself are never recorded. A developer who works mostly in Codex looks as if they wrote no code. The same work done through Claude, opencode or Copilot CLI is counted.

---

## Acceptance Criteria

Part 1 — file edits

- [ ] Given a Codex session in which `apply_patch` adds, updates, moves and deletes files, when the session metrics sync, then the synced records count `apply_patch` as a tool and carry one file operation per touched file with its path and its added and removed lines; a moved file is recorded under its new path.
- [ ] Given a Codex run in which a sub-agent applies patches, when the session metrics sync, then those patches are counted once, under the same CodeMie session.
- [ ] Given the same rollout, when the local analytics summary and the synced records are built, then they report the same file operations (type, path, lines).
- [ ] Given an `apply_patch` call that adds a new file, when it is recorded, then the file operation is a write (created file), as for the other agents, not an edit.
- [ ] Given a Codex session with `apply_patch` calls, when the user runs `codemie analytics` for that branch, then File Operations and Lines are above zero and match the patches.
- [ ] Given an `apply_patch` call whose patch Codex reports as not applied (patch result not successful, or an error output), when it is recorded, then it counts as a failed tool call and its lines are not counted as changed code.
- [ ] Given an `apply_patch` call with no result yet (session still running), when an incremental sync runs, then the call is not sent; it is sent once, with its real status, after its result appears.
- [ ] Given a session that was already synced, or a resumed run over the same rollout, when it syncs, then no `apply_patch` call, file operation or turn from an earlier run is counted again.

Part 2 — active time

- [ ] Given a Codex session with at least one completed turn, when the session ends, then the session end metric carries an active duration above zero, made of the turns of this run only, and not above the wall-clock span of the session.
- [ ] Given a turn that is interrupted or still open when the session ends, when active time is computed, then the turn counts up to its last record and not past the session end.
- [ ] Given a Codex session that sat idle between turns, when active time is computed, then the idle gap between turns is not counted.
- [ ] Given a Codex session with no turns, when the session ends, then active duration is not invented (stays absent or 0).

---

## Out of Scope

- Backfill of sessions that were already synced before the fix.
- Token usage in the per-call metrics (Codex rollouts carry no per-call usage).
- Branch attribution of a session that switched branch after it started (separate topic, see issue #648).
- Retry of metric records left `failed` after a server 503.
- Backend or UI changes: the platform already accepts and shows file operations and active duration from other agents.

---

## Decisions

- D1: One issue or two for file edits and active time → one issue with two parts — user
- D2: Where to file → Jira EPMCDME (project tracker, `.ai-run/guides/project.md`) and a linked GitHub issue in `codemie-ai/codemie-code` — user
- D3: One apply_patch parser or two → one per-call parse feeds both the synced records and the local summary (new file = write, move under new path, result from the patch result) — proposed by PO: architecture review AR-1
- D4: Sub-agent edits → in scope, counted once under the parent CodeMie session — proposed by PO: architecture review AR-2; evidence shows all 37 patches in sub-agent rollouts
- D5: Resumed runs → must not re-count earlier patches, lines or turns — proposed by PO: architecture review AR-3
- D6: Implementation flow → sdlc-light, fix PR from fork to `codemie-ai:main` — user

---

## Open Questions

- None
