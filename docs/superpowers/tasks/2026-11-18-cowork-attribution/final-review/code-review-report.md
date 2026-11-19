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

## Verification

Scoped checks on the final source: cowork and forwarder suites 205 passed / 2 skipped, `tsc` clean, eslint clean; real-local-backend
runs r4/r6 covered a fresh served session and a transient failure followed by recovery; r7 checked legacy adoption.
The actual producer, spool and forwarder sent synthetic Cowork input over HTTP to local backend `cdd8829db3` and PostgreSQL.
Public APIs confirmed P1 retained, `final`, `codemie`, positive API spend and zero subscription spend, token conservation,
and unchanged totals after repeated forwarding. The native legacy control retained its classification.
Run r6 also confirmed no append during the injected lookup failure and successful recovery. These probes passed;
they are not a real macOS Desktop session or runtime acceptance on current backend main.

## Rebase verification

Rebased from main `252233ba` onto `37a2fe476b079226be981a4566c6e771d08cc4eb` without conflicts. Original reviewed delivery
`cb2dac2f` maps to `cf6cba60`; `git range-diff` marked all 15 original task commits identical (`=`).
Reviewed implementation `eee936ee` maps to `803c14cd`, and reviewed range end `ad955b7e` maps to `03aa5f23`.
Historical revision references in the machine verdict and complexity artifact remain intentional; task patches did not change.

The new main commit changes the shared atomic writer used by spool status, so focused checks were run:
`node node_modules/vitest/vitest.mjs run src/telemetry/runtime/cowork/__tests__/CoworkEventProducer.test.ts src/telemetry/runtime/cowork/__tests__/cowork-attribution.test.ts src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/forwarder.test.ts src/utils/__tests__/atomic-write.test.ts`.
Result outside the restricted sandbox: exit 0, 4 files passed, 195 passed / 7 skipped, no unhandled errors.
The initial sandbox run exited 1 with Node child-process `read ENOTCONN`; only the successful rerun is counted.
`git diff --check` passed. Subsequent artifact cleanup changes documentation only and preserves the machine verdict and
actual complexity unchanged. Intermediate review inputs and superseded reports are retained locally outside the repository.

### Rebase onto main `709f0e6d` (2026-11-19)

Rebased delivery `54f5304a` from `37a2fe47` onto main `709f0e6d` without conflicts; equivalent task HEAD `2c8b0f2d`.
`git range-diff 37a2fe47..54f5304a 709f0e6d..2c8b0f2d` marks all 17 task commits identical (`=`).
Original reviewed implementation `eee936ee` maps to `9945aaf0`, and review range end `ad955b7e` maps to `017b613a`.
Reviewed overlap: main's disconnected-Desktop finalization (#840) still uses the pinned project through the common
processing/end paths; conflict-discard reporting (#839) changes loss recording, not project binding or funding.
Focused command: `node node_modules/vitest/vitest.mjs run src/telemetry/runtime/cowork src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/forwarder.test.ts src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/spool-io.test.ts src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/session-project.test.ts`.
Result: exit 0, 7 files passed, 311 tests passed / 2 skipped. `tsc --noEmit` and `git diff --check` passed.
No task source edits or conflict resolutions were needed; the existing source review and actual complexity remain applicable.

## PR reviewer remediation (2026-11-19)

Reviewer comments on `5227cf37` were checked against the actual callers and affected contract. The historical skill verdict
above remains scoped to its recorded revision; this additional delta was independently reviewed and checked as follows:

- An unreadable legacy spool status now stops processing before pinning or appending. A regression covers failure followed
  by recovery of the original binding, including a changed folder project.
- Pin publication uses the daemon's existing session lock and atomic temp-file rename, without hard links. Concurrent
  writes retain the first valid pin; corrupt JSON can be replaced; other read errors preserve the file. The temp write
  is inside cleanup, and an injected partial write/ENOSPC test checks that no temp file survives. Writer tests run with
  hard links mocked unsupported. The daemon is the sole supported writer; no cross-process lock is claimed.
- Cowork routing proof is interpreted only by the producer. A new shared spool boundary publishes validated, optional
  `SessionStatus.producerAttribution` metadata before append. Generic forwarding reads this metadata through the canonical
  header builder; it performs no Cowork file lookup and imports no telemetry runtime. Recorded/evidence guards retain
  precedence. Missing, malformed or mismatched metadata retains legacy behavior.
- Explicit forwarder positive and recorded-session negative tests complement existing producer-through-forwarder coverage.
  Status roundtrip tests cover metadata persistence, malformed evidence and immutable project binding before first append.

### State lifecycles and compatibility

The separate producer pin is retained deliberately. `SessionStatus` tracks delivery and may be swept; the producer cursor
advances only after successful append and may be rebuilt. The immutable project must already exist before either append
or cursor advancement and survive delivery cleanup. The pin contains only that producer decision; spool metadata is its
delivery copy. New producers bootstrap metadata from existing pins, including pending ended sessions while Desktop is
disconnected, without replaying events. Old statuses remain readable without metadata. Downgrading to an older CLI keeps
the existing NDJSON/cursor formats readable, but that older version retains its own legacy attribution behavior and can
drop the unknown metadata field on status writes; the new producer restores it from the pin when collection resumes.
The separately approved old-daemon/P1-to-P2 upgrade limitation above is unchanged.

### Scoped verification

`vitest run src/telemetry/runtime/cowork` plus spool `producer-attribution`, `forwarder`, `forwarder-contract`,
`evidence-lifecycle`, `spool-io` and `session-status-atomic` suites: exit 0, **10 files passed, 326 passed / 2 skipped**.
`tsc --noEmit` and scoped ESLint passed. The new tests use real temp-file producer/spool state and mocked HTTP; the earlier
local-backend runs remain evidence for the previous wire-identical headers, not a newly repeated backend run.
