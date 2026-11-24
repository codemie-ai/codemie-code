---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: 3f689766d4dcdb3908a58a419ad148782aa57ab3
---

# Code review — 2026-10-29-otlp-binary-masking

**Decision:** request-changes (check round, confidence final medium · check medium)  
**Reviewed head:** `3f68976` · **Rounds:** final → check

**Closed:** 7 fixed · 0 moot · 0 decided

7 of 8 prior blocking findings verified resolved by source-reading the fix-up diff: CR-002 (stale protocol fixture), CR-003 (historical-value migration for reconnect/disconnect), CR-004 (per-record cursor acknowledgement in forwardOtelJsonStream), CR-005 (otelGroupPresent now covers OTEL_JSON_STREAMS), CR-006 (skip branch drains JSON OTEL cursors), CR-007 (mask failure now logged and never falls through to the byte-blind path) and CR-008 (new otlp.plugin.otel-json.test.ts covers the masked-JSON path), each backed by added tests. CR-001 (unrelated .codemie/codemie-cli.config.json profile edit) remains unresolved — the edit is still present on disk — left unfixed by explicit user direction that it is out of scope for this fix-up round. The round stays request-changes on that one unresolved item, with confidence capped at medium per the derivation rule for any unresolved status.

## Open — 1

### CR-001 · code · major — Unrelated profile-switch mixed into feature changeset

`.codemie/codemie-cli.config.json` · unresolved after check

**Problem:** The changeset bundles an edit to .codemie/codemie-cli.config.json switching activeProfile/profile name/workspace.codeMieProject from 'epm-cdme' to 'epm-cdme-cp', unrelated to the OTLP binary-masking feature.

**Impact:** Mixes an unrelated local/environment profile switch into this feature's history, breaking commit atomicity and complicating review and future revert of the masking change.

**Recommendation:** Revert this file to its previously committed value, or stage/commit it separately with its own rationale, before finalizing this change.

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| claude-code-otlp.ts writes OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' | pass | claude-code-otlp.ts:107, CODEMIE_ENV_FIXED_VALUES literal changed from 'http/protobuf' to 'http/json' |
| handleOtlp parses, masks (maskSecretsDeep, no skip-list), and NDJSON-spools any application/json OTLP POST | pass | otlp.plugin.ts:300-322 branches on content-type, calls maskSecretsDeep with no skip-keys, appends via appendSpool |
| Any non-JSON OTLP POST is spooled via the existing byte-blind path, unchanged | pass | otlp.plugin.ts:325-348 untouched latin1/UUID extraction + appendSpool path |
| Both .bin and .ndjson spool extensions coexist per OTEL stream, both discoverable by listing/cleanup | pass | spool-paths.ts:39-48 STREAM_EXT adds *.ndjson; ALL_SUFFIXES derives from it so listSessionIds/sweep pick up both |
| .ndjson streams forward one POST per record; .bin streams keep forwarding one accumulated POST | pass | forwarder.ts forwardOtelJsonStream (new) loops per record; forwardOtelStream (bin) untouched |
| JSON OTEL telemetry masked before leaving the spool; protobuf spooled/forwarded exactly as before | pass | maskSecretsDeep applied before appendSpool in the JSON branch; protobuf branch byte-for-byte unchanged |
| OtlpAgentAdapter.limitPayload and the backend are untouched | pass | no reference to limitPayload or OtlpAgentAdapter.ts anywhere in the diff |
| Non-goal: no user-facing or config-driven protocol toggle, only the connector's fixed default changes | pass | only the CODEMIE_ENV_FIXED_VALUES literal changed; no new flag/override/config surface |
| Non-goal: decoding/parsing/masking protobuf payloads is out of scope | pass | protobuf/no-content-type branch performs no parsing or masking, consistent with the non-goal |

Standards: commit-format na · code-quality partial (final round) · security na
