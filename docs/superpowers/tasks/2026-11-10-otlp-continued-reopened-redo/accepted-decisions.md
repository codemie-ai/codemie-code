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

## D-6 (PR review CR-004): failed pass on an idle reopened session

- **Behaviour:** if a pass fails (parse-state lock not acquired within 10 s, or an I/O error), the
  catch returns an empty pass without `suppressLifecycle` / `reopened`. For an idle reopened
  session the plugin then forwards the raw `Stop` / `SessionEnd` hook (and a `SessionStart` resume
  as a start). This was the behaviour on a failed pass before this change.
- **Decision:** not changed. The fix would read the state without the lock, which can be stale: on
  the first active Stop with a failed lock it still says "idle" and would drop a legitimate raw
  Stop (usage is not lost, the next pass sends it). For `SessionStart` it cannot be fixed fully,
  because the `reopened` flag is only persisted under the lock, so a later Stop would not know
  about the reopen anyway.
- **Reopen only if:** a stray `Stop` / `SessionEnd` / `session.start` after a lock timeout on a
  reopen is seen to move a session back into a day's analytics.

## Fixed after review run 4 (for reference, not accepted limits)

- CR-001: a reopen no longer moves the env baseline, so a model/permission-mode change made at
  resume is reported by the first active pass.
- CR-002: an idle reopened `SessionEnd` no longer runs the subagent backstop or the env check, so
  subagent usage is still sent once the session is active again.
- CR-003: tests added for the parent lookup when the `continued-in` record lies before the tail window.
- Review run 5 CR-001: an idle reopened `Stop`/`StopFailure`/`PreCompact` no longer settles deferred
  subagents or moves the env baseline.

Fixed after the PR review: an id-less `<synthetic>` assistant line no longer counts as reopen
activity (synthetic-ness is read from the line, not from the parsed usage); tests added for idle
PostCompact, idle env check, id-less synthetic and a parent record that lands after the first pass;
source comments describe the known limits neutrally.

## Evidence

Isolated harness and results: `C:\Users\OlehPrusak\codemie-eval\` (outside the repo). Related review
verdicts: `docs/superpowers/reviews/2026-11-09-pr779-*/code-review-final.json`.

## Second pass after Preview QA (2026-11-10)

D-1..D-6 above carry over unchanged. #779 was merged, tested on Preview and reverted (#787); what QA
found, and what was decided:

- **16992, Started still the parent's.** Cause confirmed offline and in the live suite: copies were
  dropped by `uuid` only, so a copied line without a `uuid` but with a `timestamp` (`queue-operation`)
  still set the summary's `started_at`. Fixed: every line before the first own line with a `uuid` is a
  copy; a continuation reports nothing until it has done work of its own (`continuationActive`).
- **Local commands are not work.** A user line that only records `/exit`, `/model`, ... no longer counts
  as a genuine turn for the reopen/continuation activity bar (live scenario S2 showed 2 turns and 1 usage
  request for such a continuation). Ordinary-session turn counting is unchanged.
- **16993, duration still grew.** Claude Code's own OTel records are posted straight to the proxy daemon
  and are forwarded for any session with an evidence record, even with no hooks data (confirmed live
  after the spool was swept, scenario S11). The forwarder now holds them for a reopened idle session.
- **D-7 (new): the startup race is bounded, not eliminated.** Records that arrive before the resume hook
  has marked the reopen are kept back for `OTLP_REOPEN_SETTLE_MINUTES` (15 s) when the session had already
  ended. A resume hook slower than that, with Claude Code exporting before it finishes, can still let the
  earliest records through. *Reopen only if* such a leak is seen in real data.
- **D-8 (new): native startup records in the live suite are synthetic.** Capturing them from real
  Claude Code 2.1.319 needs the user's OAuth credentials (token refresh could rotate the real login), so
  they are modelled on the list in the QA comment. *Reopen when* the user agrees to a capture.
- **D-9 (new): a held reopen is dropped after the abandoned-session grace.** If a reopen stays idle for
  `OTLP_ABANDONED_SESSION_GRACE_MINUTES` (60) with no new OTel write, the held records are discarded unsent
  (recorded as `idle_reopen_expired`).
- **D-10 (SUPERSEDED by D-14, fixed 2026-11-11): a reopen that works but never gets a Stop hook.** A reopened
  session is released from the hold only when a hook pass (`Stop`/`SessionEnd`) has seen its own
  activity in the transcript. If the terminal is killed after real work and before any such hook, the
  daemon still sees an idle reopen and drops the held OTel records after the abandoned-session grace
  (60 min), unsent. Accepted: the hook-side events of that session are not affected, and the case needs a
  crash right after a reopen. *Reopen if* such lost records are seen in real data; the fix would be for
  the hold to look at the transcript for own-activity lines before dropping.
- **D-11 (new, code review CR-004): no clamp of a continuation's Started to its `SessionStart` time.**
  The plan proposed `max(started_at, sessionStartedAt)` as a safety net. It was tried and removed: the
  hook's wall-clock can be later than the continuation's first own line (slow SSO or cold start), and the
  clamp then moves Started *later* than the session's real first request; the live suite caught this
  (S3). Positional ownership already covers the known cases. *Reopen if* a real continuation shows a
  Started earlier than its own first line; then clamp only when the gap is larger than a few minutes.
- **D-12 (new, code review CR-007): parent lookup stays at 3 passes and in the child's own folder.**
  A parent record that lands after the third hook pass, or a parent in another project folder, leaves the
  copies counted. Retrying longer would add a sibling-folder scan (up to 200 transcripts) to every hook of
  every ordinary session. *Reopen if* such a continuation is seen in real data.
- **D-13 (SUPERSEDED by D-15, fixed 2026-11-11): the startup-race guard needs the session status.** A reopen after the
  status file was swept, with a resume hook slower than the first OTel export, can still let the startup
  records through. Same family as D-7; a fix needs a new live scenario that sweeps and races.

## Third pass: reviews of 2026-11-11 and the live results of the reporter (2026-11-11)

D-1..D-13 carry over, except D-10 and D-13, which are now fixed (below). Two reviews of this day flagged
`breaking-change` and a finding about project selection (`AgentCLI`, `identity-fields`, the copilot launcher,
`ConfigLoader`). Both ran against a local `main` that was behind `origin/main` and so lacked #782. Against
the current `origin/main` this branch touches only the OTLP plugin and the spool forwarder. The branch was
rebased onto `origin/main` (01f46cf3, after #775) and local `main` brought up to date.

### Fixed

- **D-14 (fixes D-10; reviews CR-001, CR-002, CR-003 of 2026-11-11): the hold looks for real work and cuts safely.**
  A held reopen is released at the first record of real work in its own log stream, with no wait for a `Stop`.
  A record counts only by its exact event name: in the NDJSON stream a log record whose `event.name` is
  `api_request` / `tool_result` (or whose body is `claude_code.<name>`), parsed per line; in the protobuf
  stream the prefixed text `claude_code.api_request` / `claude_code.tool_result`. A bare word elsewhere in a
  payload does not count, and metrics and traces are never looked at. The release stands until the next
  reopen marks the parse state again (`reopenedAt`, set where the resume marks the reopen), whatever the
  hook passes save in between; the memo is bounded by dropping the oldest entries. The expiry after 60 min
  still exists for a reopen that stays idle: before it drops anything it scans everything still unsent for
  work (not just the next 8 MB), it cuts an NDJSON stream at the last whole line and a protobuf stream at its
  end (a newline byte can occur inside a protobuf message), and it leaves a stream alone while earlier records
  of it still wait for a retry. Live: S13 (fails on the earlier hold, passes now).
  *Residual:* after a daemon restart the release memo is gone and the scan starts again at the cursor, so
  records written after the last work record can be held until the next one; a reopen that works and is killed
  leaves only those trailing records (hook_execution_* of the shutdown, no usage) held, dropped after the
  grace. *Unverified:* that Claude Code's real startup records carry neither event name; the live suite's
  startup records are synthetic (D-8). A wrong guess fails closed (the hold waits for a `Stop`, as before).
  To confirm: run the real `claude --resume` check once more on this build.
- **D-15 (fixes D-13): the startup-race guard works after a sweep.** Besides "bytes written after the
  session ended", the hold now recognises a spool file created within the settle window for a session whose
  saved parse state is much older than that file (older by more than the settle time): the status is gone,
  the state file is not. Bounded by the settle time (15 s from the file's creation), so a long turn is not
  held. A brand-new ordinary session is not affected: its state is written within seconds of its first
  record. Live: S14 (7 records leaked on the earlier hold, 0 now). *Residual:* a hook slower than 15 s still
  lets records through (D-7), and a state file touched by an unrelated pass shortly before the reopen defeats
  the age test (the pass would then have marked the reopen or been an ordinary session).
- **Test added (review CR-006):** a continuation with queue lines before and after the copies, a synthetic
  placeholder and `/exit` lines reports nothing on Stop and SessionEnd; once real work follows, its start is
  its own first line (the placeholder Claude Code wrote at the open, as in QA's report), not a copied or queue
  line. A resume without a saved start still counts as a first start by design (D-3).

### Not fixed, with the reason

- **Parent lookup limits, copied subagent transcripts, late `continued-in` record (reviews of 2026-11-10 CR-002 and
  2026-11-11 CR-004): D-1, D-2, D-4, D-12 stand.** A larger change with a high regression risk and a data-loss
  risk: a longer or wider lookup adds a scan of up to 200 transcripts (and other project folders) to every hook
  of every ordinary session, can pick the wrong parent, and any rule that drops uuids as inherited can hide
  real work from a session. Lines already reported are never retracted. Not verified: the
  copied-subagent case was never seen in the 4 real pairs, so a rule would be built without an example.
  Fixing the lookup means scanning other project folders on every hook of every ordinary session (cost) and
  risks choosing the wrong parent (ambiguity), and reported lines can never be retracted anyway. The branch
  is unchanged for the real cases checked.
- **Passthrough hooks (D-5).** Not verified: no real capture shows `Notification` on an idle reopen (the real
  `claude --resume` run sent 0 records). Gating those hooks risks dropping events of ordinary sessions,
  which fire the same hooks.
- **Failed lock forwards the raw Stop/SessionEnd (D-6).** Rare (lock timeout) and not fixable without a
  lock-free marker file, which adds persistence and a new failure mode for a case not seen in practice.
- **Reopen hold reads the parse state without its lock.** A stale read delays a release by one tick; the
  lock would make the forwarder wait on hook processes. Documented in the code.
- **`inheritedUuids` has no size cap; sibling scans repeat while a lookup is incomplete.** Bounded by the
  3-pass limit and the 200-file cap; a cap would drop uuids and bring back double counting.
- **An assistant line without a model counts as activity.** Not verified: only the id-less synthetic
  placeholder was ever seen (already handled); a rule without an example risks hiding real work.
- **Project attribution, "duration ends at the last original activity", the Postgres regression test and the
  backend fixes of comment 16077824.** Outside this repository (backend/UI). On the CLI side an idle reopen
  now sends nothing, so those figures cannot move because of it. Needs the Preview check after merge.
