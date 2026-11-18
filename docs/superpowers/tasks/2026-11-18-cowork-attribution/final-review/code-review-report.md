# Code review report: EPMCDME-17385 + EPMCDME-17410 (Cowork analytics attribution)

- **Verdict:** `approve`, confidence `medium`, 0 blocking, 0 deferred (machine verdict: `code-review-final.json`).
- **Reviewed range:** `252233ba1658a506b6d38fbf6707ea8a8c0926fa...ad955b7ec29704a9da2a9c2f16205b1f2104f6ed` (frozen diff sha256
  `2e4db5a1202e88ba03561b61da8d008cc460ed05f1304851c5c450bb901bab83`, 7 files, +671/-9). Product source is final at
  `eee936ee`; later commits are task documents only. Artifacts committed after this review name this range; they do not
  change the reviewed source.
- **Coverage:** blind, edge-case, verification-gap, acceptance (4/4 lenses) plus the standards/security audit. Profile `full`.
- **Verdict basis:** the verdict was produced by the review agent from the lens outputs and was not edited.

## Acceptance status

- EPMCDME-17385 AC1-AC4: pass (pin before the first append, write-once, restart and folder changes, native unchanged).
- EPMCDME-17410 AC1: `partial`, only through (1) the single user-accepted upgrade edge case below, (2) a session with no served
  mark (no proof of the route), (3) a project that cannot travel as a header, and (4) a fresh session with no project, which
  is not sent at all (discarded locally as `no_project`, as at baseline and for native sessions).
- EPMCDME-17410 AC2: the overview cards (`api_cost_usd`/`subscription_cost_usd`) were verified on a local backend with
  synthetic Cowork input; the Cost view reads `total_cost_usd`; the `/cost` funding buckets still show Cowork as `unknown` and
  no cli-analytics UI component reads them. Not verified on a real macOS Desktop session or on the current backend `origin/main`
  build (the gate/binding/ingestor files are identical to the probed build except two lines of `ports.py`).

## Accepted limitation (explicit user decision, 2026-11-18; this case only)

A still-running Cowork task already collected by the OLD CLI/daemon, its spool bound to project P1, continues under the NEW
CLI with no attribution pin yet, and the current folder/config now resolves a DIFFERENT project P2. The project stays P1, but
the funding classification may stay `unknown` because the old data does not establish the project source. A new Cowork task
started after the update is the supported way to get fresh funding attribution. If the project remains P1 it does not apply.
Not covered: fresh tasks, transient origin-resolution failures, project drift or lost ends, arbitrary unresolved projects,
any blanket old-session exemption. Probe r7 shows sending funding without `Project-Source` cannot close it without a backend
change (a bound spool with no delivered legacy rows is routed by `default_project`); none is made.

## Security

The attribution-header change is CRITICAL in `.ai-run/guides/security/security-practices.md`. The source-backed review
(`security-review.md`, skill run twice) found no vulnerability. **The guide's security-review sign-off by the repository's
security reviewers is an external merge gate and is not claimed here.** It is not an implementation finding.

## Review history (all earlier rounds are superseded, not final)

`superseded-ee54d4da/`, `superseded-ad8ba2f4/` (CR-001 sign-off, CR-002 AC1 partial, CR-003 hard-link failure, CR-004 unreadable
pin overwrite; CR-003/CR-004 fixed in `eee936ee`), `superseded-c02998c5/` (CR-001 fresh-session cases; evidence added to
`review-facts.md`, then judged by this round).

## Verification

Scoped checks on the final source: cowork and forwarder suites 205 passed / 2 skipped, `tsc` clean, eslint clean; real-local-backend
runs r4/r6 (fresh served session, transient failure then recovery) and r7 (adoption seam) in `record.md`. Synthetic input, not a
real macOS Desktop session.
