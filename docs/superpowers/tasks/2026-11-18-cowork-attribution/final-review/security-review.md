# Source-backed security review: Cowork attribution path

Reviewed range `252233ba1658a506b6d38fbf6707ea8a8c0926fa...c38b2fe4c117f55161bdf6d944955a939c9c19b1` (source files:
`cowork-attribution.ts`, `CoworkEventProducer.ts`, `otlp-spool/evidence-send.ts`, `otlp-spool/forwarder.ts`; tests for context),
run with the `security-review` skill (identification sub-task, read-only) against `.ai-run/guides/security/security-practices.md`
"CRITICAL: Project & User Attribution Headers". The skill's false-positive filter step had nothing to filter.

## Source findings

None at the skill's threshold (> 80% confidence, newly introduced, exploitable). Reviewer confidence in that conclusion: 8/10.
Points examined and why they are not findings:

- **File names from the session id** (`<id>.cowork-attribution.json`, served mark): the producer gates the id with
  `isSafeSessionId` before any read or write. Not traced: every caller of the served-mark writer (the daemon plugin also
  checks `isSafeSessionId` before calling it); no traversal path found.
- **Header injection:** Project and Project-Source are built by the canonical `buildAttributionHeaders` (destination
  `analytics`); `rawProjectHeader` drops values that cannot travel as a header, and `coworkFundingHeaders` then returns
  nothing, so funding is never declared without a Project header; the pinned source is checked against the enum when the
  pin is read and `none` is refused. Both refusals have regression tests.
- **Funding claimed by native, recorded or guarded sessions:** the Cowork path runs only for `!req.evidence && !req.guard`,
  and needs a daemon-written served mark and a pin for the same project; no consent or contract header is sent.
- **Forged Project / Project-Source from a user folder or config:** the project and origin come from the existing
  `ConfigLoader` / `resolveProfileIdentity` resolution (no new derivation source); a user can only name a project their own
  credentials may use, and the backend authorizes membership. A local actor who can write `CODEMIE_HOME` can forge a mark
  and a pin, but that actor already holds the credentials (same trust domain; excluded class).
- **Fabricated provenance:** a project-origin lookup failure now propagates before anything is appended or pinned and is
  retried; no source is guessed.
- **Logging:** the diff adds no logging of header values.

## Checklist (security-practices.md)

Satisfied by source: derivation from the existing resolution only; no silent normalization (raw value sent, case-insensitive
compare only inside the gate); single canonical builder; header-safe values; no fabricated provenance; session-id file-name
validation; recorded and native sessions not auto-funded; no new logging.

## Policy items that are not code defects

- **Security-review sign-off recorded on the PR.** Policy (`security-practices.md` rule 1 and the review checklist) requires
  an explicit security-review sign-off for any attribution-header change. This document is the source-backed review result;
  a human sign-off by the repository's security reviewers, if policy requires one, is a **merge gate** and is NOT claimed
  here. It is process metadata, not a source vulnerability.
- **Rule 4, "header injection lives in exactly one layer".** The new funding headers are built by the shared builder in
  `header-injection.plugin.ts` but selected at the call site in `evidence-send.ts` / `forwarder.ts`, the same layer that
  already builds analytics evidence headers with that builder. The reviewer treated this as a policy judgment for the
  security owners, not a vulnerability; it is raised here so it is decided explicitly.
- **Backend contract:** the server must continue to honour `Project-Source` and accept a funding declaration without a
  contract header (verified for the probed backend revision in `../record.md`; not re-verified for current `origin/main`).

## Second security review run, on the attribution delta (`c38b2fe4..eee936ee`, source files `252233ba..eee936ee`)

Run with the `security-review` skill (identification sub-task, read-only; no verifier sub-task was needed because it reported
nothing). Result: **no findings** at the skill's threshold. Examined and not findings: pin file name from the session id
(`isSafeSessionId` gate in the producer; the forwarder's call is read-only), unique-temp + hard-link publish (no read or
overwrite primitive), replacing only a corrupt pin while a valid one always wins and any other I/O error throws without
touching the file, pin shape validation (rebuilt field by field, no prototype pollution), funding headers through the
canonical builder (constants plus the closed `linked_folder|profile` set, `none` refused, header-unsafe project falls back to
the legacy Project header), the served-mark + pin + non-`none` source gate applying only to unrecorded, unguarded sessions,
and no new logging of project names or pin contents. The sign-off item below is unchanged: it is an external process gate
and this document does not record it.
