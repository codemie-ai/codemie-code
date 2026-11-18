# Review facts for the final review of 252233ba...ad8ba2f4 (inputs, not conclusions)

Round history: the round at c38b2fe4 (verdict `request-changes`: CR-001 security sign-off, CR-002 backend evidence mapping,
CR-003 corrupt pin, CR-004 pin write race, CR-005 AC1 gap, CR-006 stale served mark) is superseded by this one. Since then,
commit `ad8ba2f4` makes the pin write-once and race-safe (unique temp file + hard link, first pin wins, unreadable pin
replaced) and adds tests, including that an unreadable pin cannot move a session whose project the spool already holds
(the spool-bound project rule already preserved it; the finding's "moves the session" impact did not hold, its comment did
mislead and was corrected). CR-006 (stale served mark): the mark is session-level proof that the daemon served the session
and is pruned when the session leaves Desktop's list; a freshness age would drop the idle end/summary events of a served
session, so none was added; judge this independently. CR-002: backend persistence evidence is `../record.md` (runs r4 and r6,
synthetic input, real local backend), not in the diff.

Evaluate independently; these are source-backed facts, not a verdict. Do not treat any limitation here as an accepted
requirement reduction: no exclusion from EPMCDME-17410's acceptance criteria was approved. Historical stored-data repair
was the only excluded scope. Report real gaps as findings.

- Spec: Jira snapshot (EPMCDME-17385, EPMCDME-17410) and `record.md`.
- Earlier rounds (`superseded-ee54d4da/`, and the round at 16567370) are superseded, not final coverage.
- Changes since the superseded review at ee54d4da: `b24c1773` (test-only: refusals of a non-header-safe project and of a
  recorded/guarded session, each red when its guard is removed) and `c38b2fe4` (source): a failing project-origin lookup
  (`resolveProfileIdentity`) no longer pins source `none`; it propagates before anything is appended or pinned and the next
  processing retries, for a fresh session and for a session the spool already holds. Tests: transient failure then
  recovery, with the real forwarder's funding headers; bound session with failure then retry. Real-local-backend probe r6
  (synthetic input) repeats the persisted-classification assertions on this source with a one-time injected failure.
- Security review (skill `security-review`, `final-review/security-review.md`): no source vulnerability. The guide's
  security-review sign-off requirement is a process gate; policy rule 4 ("header injection lives in one layer") is raised
  there as a judgment for the security owners.
- Consumer facts: the CLI Analytics overview cards read `kpis.api_cost_usd`/`kpis.subscription_cost_usd` (met on the local
  backend); the Cost view reads `kpis.total_cost_usd`; `/cost` `funding` buckets show Cowork `unknown` and no cli-analytics
  UI component reads them (`codemie-ui` origin/main search only).
- Known active-session gap (stated in `record.md`, not accepted): a session the spool bound before pins existed whose
  current resolution yields a different project is pinned with source `none` and stays unfunded; closing it would need
  backend adoption evidence or a fabricated Project-Source. Sessions that continue across the upgrade and keep their project
  get the real source pinned. A fresh served session with no project sends no Project header (unchanged from baseline).
- Backend scope: read-only; no backend change.
