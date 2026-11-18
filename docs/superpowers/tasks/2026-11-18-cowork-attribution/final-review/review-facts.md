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

## Security

- Security-review skill ran twice (`security-review.md`): no source vulnerability. The guide's security-review sign-off by
  the repository's security reviewers is an external merge gate, not an implementation defect, and is not claimed.
- Backend scope: read-only; no backend change.
