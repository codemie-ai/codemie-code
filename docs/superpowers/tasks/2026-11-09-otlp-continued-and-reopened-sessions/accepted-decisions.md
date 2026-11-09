# Accepted decisions: EPMCDME-16992 / EPMCDME-16993 (PR #779)

Owner decisions on code-review findings (review run 3, 2026-11-09). A review MUST NOT raise these
again as blocking findings unless the stated reopen condition has changed. Pass this file to the
review as an acceptance artifact (spec) together with the ticket text.

Not fixed, by decision. Each was weighed against the risk of the fix; none is a defect in the
ticket acceptance criteria (verified live, isolated, against baseline `main`).

## D-1 (review CR-001): parent lookup in project folders with more than 200 transcripts

- **Behaviour:** more than 200 sibling `.jsonl` files make `resolveInheritedUuids` return `null`
  ("incomplete"). `ensureInherited` retries an incomplete lookup on every pass. Each pass reads the
  tail of up to the 200 most recently modified siblings and streams larger ones whole (about
  250-270 ms per pass for 252 files / 75 MB; 717-798 ms for 68 files / 189 MB with no parent).
  A parent outside the 200 newest siblings is not found.
- **Decision:** not changed. We do not skip or give up on data: ending the retries (or capping the
  work) would make a missed parent permanent, which is the EPMCDME-16992 double count.
- **Why the suggested fix is rejected:** "locate the parent from the child's copied records" does
  not work on real data: in all 4 real parent/child pairs every copied line already carries the
  child's `sessionId`.
- **Reopen only if:** hook latency from this scan is observed in production, or a skip signal for
  sessions without copied history is available (idea: counted lines dated before the session's own
  `SessionStart`; unproven, `sessionStartedAt` was empty in real saved states).

## D-2 (review CR-002, decision_needed): copies reported before the parent is found

- **Behaviour:** if the parent's `continued-in` record is not on disk when a continued session's
  first pass runs, that pass reports the copied lines. They are not retracted; later passes and the
  summary exclude them (verified: first Stop sends the copies, second Stop only the own request).
- **Decision:** not changed. Could not be reproduced in practice: in the 4 real pairs the record is
  written 3-13 s (once 7.5 min) before the child's first own line. Holding events back until the
  lookup is final would delay or drop data for every ordinary session.
- **Reopen only if:** a real session is seen reporting copies on its first pass.

## D-3 (review CR-003): reopen suppression without saved parse state or with offset 0

- **No saved parse state:** a `resume` is treated as a first start by the handlers. In production the
  transition gate stops a `resume` of a session without an evidence record (`resume_unknown`; checked
  live: `resume`/`Stop`/`SessionEnd` -> `stop`, `startup`/`clear` -> `continue`). The remaining case
  (evidence record present, parse state deleted by hand) is rare; nothing in the plugin deletes
  parse state.
- **Offset 0 (state exists, no Stop ever ran):** not a defect. Nothing was reported before, so
  sending the old transcript is correct, not a duplicate (verified live).
- **Decision:** not changed. The suggested fix (move `mainOffset` to the file size on resume) would
  permanently drop work of a session that crashed before its first Stop.
- **Reopen only if:** parse state is shown to be lost in normal operation.

## D-4 (review run 4, CR-004): copied subagent transcripts

- **Behaviour:** if Claude Code copied a parent's subagent transcripts into the continued session's
  folder, their usage could be counted twice.
- **Decision:** not changed, and not valid as a finding. Checked on the 4 real parent/child pairs: no
  subagent file name appears in both folders (parents have 1/8/7/11 subagent files, children
  1/0/1/0). It was never observed, and a dedup rule would be built without a real example, which
  adds overhead and risks breaking correct counting.
- **Reopen only if:** a real continued session is seen with subagent transcripts copied from its parent.

## D-5 (review run 5): raw passthrough hooks on an idle reopened session

- **Behaviour:** hooks that are not lifecycle events (`Notification`, `InstructionsLoaded`, ...) are
  still forwarded at hook time while a reopened session has no activity of its own. This was the
  behaviour before this change.
- **Decision:** not changed. It is not shown that the backend uses these events to admit a session
  into a day's window, or that Claude Code fires them on a reopen. Gating them without that evidence
  risks dropping legitimate events (a `SubagentStop` already counts as activity by design).
- **Reopen only if:** real data shows a `Notification` (or another passthrough event) on an idle
  reopen putting the session back into the reopen day's analytics.

## Fixed after review run 4 (for reference, not accepted limits)

- CR-001: a reopen no longer moves the env baseline, so a model/permission-mode change made at
  resume is reported by the first active pass.
- CR-002: an idle reopened `SessionEnd` no longer runs the subagent backstop or the env check, so
  subagent usage is still sent once the session is active again.
- CR-003: tests added for the parent lookup when the `continued-in` record lies before the tail window.
- Review run 5 CR-001: an idle reopened `Stop`/`StopFailure`/`PreCompact` no longer settles deferred
  subagents or moves the env baseline.

## Evidence

Isolated harness and results: `C:\Users\OlehPrusak\codemie-eval\` (outside the repo). Related review
verdicts: `docs/superpowers/reviews/2026-11-09-pr779-*/code-review-final.json`.
