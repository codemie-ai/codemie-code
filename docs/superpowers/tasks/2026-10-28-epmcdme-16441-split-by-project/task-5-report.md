DONE
commit: e040a3ec
paths:
src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/project-interleave.test.ts
test_command: npx vitest run --project unit src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/project-interleave.test.ts
notes:
- Added section F (6 tests) against the real spool and cursors: A+B produce two requests, and the cursor is still 0 at both hooks requests and at EOF afterwards; B fails then succeeds with A resent byte-identical, endedAt unset until the whole batch is acknowledged (session end sits in B's group); 401 in the second group leaves cursor and endedAt; unnamed and case-variant events ride in A's request unmodified in file order; sealed prefix (A, B, then an unsendable name) is one filtered request under A; OTLP header and bytes unchanged for a multi-project session.
- Reused hookLine, seedBoundA, cursorsAtEof; added local helpers (event, lineOf, bodyOf, appendEvents, hooksRequests, hooksCursor) inside section F only.
- Teeth check: moved advanceCursor inside the per-group loop in forwarder.ts; 4 of the new tests failed (exit 1). forwarder.ts restored with git checkout; git status shows it unmodified; only the test file is in the commit.
- No stale pin/rewrite tests in project-interleave.test.ts: all 9 existing tests pass unchanged against current production code.
- Whole otlp-spool dir: 9 files, 202 tests passed. First commit attempt was rejected by commitlint (header 102 chars > 100); resubmitted with a shorter subject, hooks otherwise passed.
