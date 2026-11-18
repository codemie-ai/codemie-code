# Review facts for the final review of 252233ba...<final HEAD> (inputs, not conclusions)

Evaluate independently; these are source-backed facts, not a verdict. Report real defects as findings.

## Requirements and the one approved limitation

- Spec: Jira snapshot (EPMCDME-17385, EPMCDME-17410) and `../record.md`.
- **Explicit user decision (2026-11-18) accepting ONE narrow edge case only:** a still-running Cowork task already
  collected by the OLD CLI/daemon, its spool bound to project P1; the daemon then runs the NEW CLI while the task
  continues; no pin exists yet; the current folder/config now resolves a DIFFERENT project P2. The project stays P1 and the
  funding classification may remain `unknown` (old data does not establish the project source). A new Cowork task after the
  update is the supported way to get funding attribution. If the project remains P1 the limitation does not apply. Not
  covered: fresh tasks, transient origin-resolution failures, project drift or lost ends, arbitrary unresolved projects,
  any blanket old-session exemption. No backend change is authorized. Historical stored-data repair is also out of scope.
  Judge every other case against the full acceptance criteria.

## Round history (all earlier rounds are superseded, not final)

- `superseded-ee54d4da/` (round at ee54d4da) and `superseded-ad8ba2f4/` (round at ad8ba2f4, `request-changes`: CR-001 security
  sign-off, CR-002 AC1 partial, CR-003 hard-link failure, CR-004 unreadable-pin overwrite).
- `superseded-c02998c5/` (round at c02998c5, `request-changes`, one item CR-001: no-project / non-ASCII fresh sessions, judged to need a human decision; the evidence below was added after it).
- Since ad8ba2f4: `eee936ee` rewrote the pin save (valid pin never replaced and returned; only a corrupt file replaced;
  other read errors throw and leave the file alone; only writer is the producer, serialized per session by the runner;
  no cross-process lock claimed; hard-link-less filesystems not handled, reachability unproven) with a test for the I/O
  failure case. Retry-before-append (`c38b2fe4`) regression tests are unchanged.

## Consumer and backend facts

- Real-local-backend runs r4 and r6 (synthetic Cowork input) in `../record.md`: fresh served session stored under the first
  project, final, `codemie`, API spend > 0 with subscription spend 0, tokens equal to unique spooled usage; r6 adds a
  transient identity failure that appended nothing, then recovered.
- Probe r7: a funding request WITHOUT `Project-Source` adopts a legacy project only when the backend already holds legacy
  rows; with none it was routed by `default_project`. So the accepted edge case cannot be closed by sending without
  `Project-Source`; this change does not do that.
- CLI Analytics overview cards read `api_cost_usd`/`subscription_cost_usd`; the Cost view reads `total_cost_usd`; `/cost`
  `funding` buckets show Cowork `unknown` and no cli-analytics UI component reads them (`codemie-ui` origin/main search only).
- Served mark: pruned only when the session is no longer listed and older than the backfill window; recreated by the next
  served request. A project that cannot travel as a header is dropped at baseline too and never declares funding.

## Evidence on the fresh-session cases the round at c02998c5 raised (CR-001; judge it, it is not a waiver)

The acceptance criterion is "when a Cowork session is **sent**, its row has `subscription_type: codemie`".
- **Fresh session with no resolvable project:** it is not sent. A legacy (non-evidence, unrecorded) session with hook events and
  no project is `unbound`, whose policy is DISCARD for hooks and OTEL (`session-project.ts` `evaluateProjectPolicy`: only
  `sendMode === 'evidence'` sends without a project; Cowork is not recorded), recorded locally as `lastLoss: no_project`
  (`spool-io.ts` `applyProjectPolicyLocked`). Baseline behavior, identical for native sessions. No row exists, so no
  `unknown` row is produced. The producer test "appends without a project name or a project binding when no project is
  resolved" and "stays without one when a project appears later" pin it. The permanent empty pin is the existing design
  (project fixed before the first append; a late project is not applied to a session that began without one).
- **Project that cannot travel as a raw header (non-Latin-1):** the same value is dropped from the legacy Project header at
  baseline, and the backend's shared-project name rule is `^[a-z0-9][a-z0-9_-]*$`
  (`ProjectService.validate_shared_project_name`, origin/main `9f19b3b3a3`), so such a name is not a valid project
  destination. Funding is not declared on a missing Project header (tested); nothing new is dropped.
- **No served mark:** the daemon did not serve the session through CodeMie, so there is no proof of the route; not funded by
  design. The mark is recreated at the next served request.

## Security

- Security-review skill ran twice (`security-review.md`): no source vulnerability. The guide's security-review sign-off by
  the repository's security reviewers is an external merge gate, not an implementation defect, and is not claimed.
- Backend scope: read-only; no backend change.
