---
schema_version: 1
id: copilot-cli-version-probe-timeout
mode: single
repository: codemie-code
children: []
---
# GitHub Copilot CLI version check must not hang `codemie update` / `codemie list` — Story

**Date**: 2026-11-17
**Status**: Approved
**Architecture review**: intent, 2026-11-17, 246e6a4b4684
**Ticket**: EPMCDME-16976

---

## Context

- The bug is confined to `codemie-code` (the CodeMie CLI). `codemie`, `codemie-ui` and `codemie-sdk` have no Copilot CLI version check (grep-level check in the technical analysis), so no per-repository split is needed.
- `codemie update` and `codemie list` both ask each installed agent for its version. For Copilot, "installed" means only that a command named `copilot` exists on PATH. The VS Code "GitHub Copilot Chat" extension can put such a command there without the standalone Copilot CLI.
- The version query has no time limit. The shared process runner only arms a timer when a caller asks for one, and neither the Copilot plugin nor the common agent base class does. A query that never finishes blocks the command forever, with no output or error. `codemie list` checks agents one after another, so one hung agent also blocks every agent after it.
- The repository already bounds the version checks of other tools (frameworks, native installer) with a 2–10 second limit, most often 5 seconds. Agent version checks have none. A timed-out check already ends as "version unknown" for every caller, so no caller needs to learn a new outcome.
- The same unbounded check also exists in the codex, gemini, claude and kimi agent plugins, in the doctor checks and in a few other places. The ticket names only Copilot and the base-class equivalent.
- No test covers the Copilot or base-class version check. The hang was derived from code reading and was not reproduced. The claim that the VS Code `copilot` command blocks waiting for input is unverified.

---

## Complexity

**Size**: M (17/36) · **Recommended flow**: sdlc-standard

Two version-check call sites in one repository, but AC6 (release the unresponsive process) likely needs a change in the shared process runner, which has no timeout tests and unverified Windows behaviour. If the codex, gemini, claude and kimi agents come into scope, the estimate rises to about 21–24 (L), still `sdlc-standard`.

---

## Story

**As a** CodeMie CLI user who has the VS Code GitHub Copilot Chat extension but not the standalone Copilot CLI, **I want** `codemie update` and `codemie list` to give up on an unresponsive Copilot (or base-class agent) version check after a short, fixed time **so that** the commands no longer freeze on that check and I never have to kill a hidden process by hand.

---

## Background

On a common developer setup, running `codemie update` or `codemie list` freezes with no output and no error. The only way out is to find and kill a hidden child process. It affects anyone with the Copilot Chat extension and without the standalone Copilot CLI, and it blocks the routine update and agent-listing flows for all other agents too. The ticket was raised from GitHub issue 539.

---

## Acceptance Criteria

- [ ] AC1: Given the `copilot` command on PATH never finishes answering a version query, when the user runs `codemie list`, then the command finishes within a bounded time, shows Copilot as installed with no version, and still lists every other agent.
- [ ] AC2: Given the same unresponsive `copilot` command, when the user runs `codemie update`, then the command finishes within a bounded time, skips Copilot, and still checks every other agent for updates.
- [ ] AC3: Given an agent that uses the common agent base-class version check and does not answer it, when the user runs `codemie list` or `codemie update`, then it is bounded in the same way as Copilot in AC1 and AC2.
- [ ] AC4: Given the Copilot CLI answers the version query within the time limit, when the user runs `codemie list` or `codemie update`, then the version is reported and used exactly as it is today.
- [ ] AC5: Given a version query was abandoned because of the time limit, when the command finishes, then no new error, stack trace or warning specific to the timeout is printed, and the output equals today's output for an agent whose version is unknown (including the existing "Could not check ... for updates" line of `codemie update <agent>`).
- [ ] AC6: Given a version query was abandoned because of the time limit and the unresponsive process ignores termination requests and never closes its output, when the command finishes, then the CodeMie CLI process still exits within the time limit plus a short margin; the timeout must release the unresponsive process, not only stop waiting for it.
- [ ] AC7: Given the time limit applies, when the limit is reached on one agent in `codemie list`, then the extra wait for that agent is no longer than the limit.

---

## Out of Scope

- NG1: Verifying what the VS Code Copilot Chat `copilot` command actually does. The fix does not depend on it.
- NG2: Making "installed" detection for Copilot stricter, so a non-Copilot `copilot` command stops counting as installed.
- NG3: Changing the version checks of other agents that do not use the base-class version check (codex, gemini, claude, kimi), the doctor checks, or other unbounded probes in the CLI (decision D5).
- NG4: Giving the shared process runner a default time limit for all commands.
- NG5: Checking agents in parallel in `codemie list`.

---

## Decisions

- D1: Which time limit? → 5 seconds — proposed by PO: it is the most common limit for version checks already in the repository (technical-analysis.md §2, "Bounded `--version` probes already in the code"); the ticket asks for "a bounded timeout" without a value.
- D2: What does the user see when the check times out? → Nothing new: Copilot is treated as "version unknown", the same as when the check fails today — proposed by PO: every caller already handles that outcome (technical-analysis.md §2, "Failure semantics").
- D3: Does the story cover the common agent base class too? → Yes — proposed by PO: the ticket asks for "the equivalent base-class path".
- D5: Bound the same version check in the codex, gemini, claude and kimi agents too? → No, only Copilot and the base class, as the ticket says; those four agents keep the same hang risk until a follow-up ticket is raised (owner to be named by the requester) — user
- D4: Accepted trade-off of the limit → a genuine but slow Copilot (for example a cold start over 5 seconds) is reported as "version unknown": `list` shows no version, `update` skips it, and the launch-time minimum-version check does not block it. The 5 seconds was not measured against a real `copilot --version`; that is recorded as not verified — proposed by PO: architecture review (AR-4).

---

## Open Questions

- None

---

## Constraints

- Only `codemie-code` changes. It is a public repository; its git-workflow guide applies before any commit or push.
- The workspace `AGENTS.md` and `CLAUDE.md` define no landing order and no owner approvals for this change (not found).
- End-to-end check for the parent: AC1–AC7 are all verified inside `codemie-code`; there is no cross-repository contract.

---

## Sources

- EPMCDME-16976 (Jira) · documents
- https://github.com/codemie-ai/codemie-code/issues/539 · not read: remote URL, no local copy supplied
- `codemie-code` · repository (read-only research reference; it is the change-owning repository)
