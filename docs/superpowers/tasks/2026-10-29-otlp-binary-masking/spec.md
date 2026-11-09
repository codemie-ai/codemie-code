# Spec: Mask native OTLP telemetry (dual-format proxy pipeline)

## Context

EPMCDME-16383's prior fix masked secrets only in the hook-event pipeline
(`OtlpAgentAdapter.limitPayload`, `src/agents/core/OtlpAgentAdapter.ts`). QA found
native OTEL telemetry (logs/metrics/traces, emitted by Claude Code's bundled
OpenTelemetry SDK as `http/protobuf`) still reaches the CodeMie analytics backend
unmasked: `otlp.plugin.ts`'s `handleOtlp` (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts:284-324`)
only extracts a session id via a UUID regex over raw bytes and spools/forwards
everything else untouched; `forwardOtelStream`
(`otlp-spool/forwarder.ts:253-276`) forwards those bytes with a hardcoded
`application/x-protobuf` content type. The backend already accepts OTLP/JSON on
`/logs`, `/metrics`, `/traces` with no backend change (verified directly against
`C:\Repositories\codemie`'s `otlp.py`/`cli_analytics.py`).

An initial design pass proposed renaming the OTEL spool extensions as part of a
protobuf→JSON cutover. Review found this would orphan any pre-upgrade session
still holding undrained `.otel_*.bin` files at the moment the proxy restarts,
since `listSessionIds`/`sweep.ts` discover and delete files purely by extension
match (`spool-paths.ts:40-62`, `sweep.ts:72-82`). The chosen resolution, directed
by the stakeholder: **support both formats permanently, side by side** — not a
one-time migration. Nothing is renamed or retired, so the orphaning risk does not
arise.

## Design

**CLI connector** — `claude-code-otlp.ts`'s `CODEMIE_ENV_FIXED_VALUES`
(`~L104-112`) changes `OTEL_EXPORTER_OTLP_PROTOCOL` from `'http/protobuf'` to
`'http/json'`. This is the new default Claude Code writes into its own settings;
it is not a user-facing toggle.

**Proxy ingestion** — `handleOtlp` branches on the request's `Content-Type`
header (currently ignored entirely):
- `application/json` (or any JSON-ish type) → extract the session id via the
  same UUID v4 regex used today, run against the body decoded as `utf8` (real
  text, so the latin1 trick is unnecessary) rather than a schema-specific
  attribute lookup, keeping extraction generic across signals and future
  agents. Parse the body, run `maskSecretsDeep(parsed)`
  (`src/utils/security.ts:240`) over the whole parsed OTLP export document with
  no custom skip-list — every `EMBEDDED_SECRET_PATTERNS` entry is anchored to a
  named-secret shape or known token prefix, never a generic hex/high-entropy
  scan, so this is safe to apply blanket across OTLP's
  `resourceLogs[].scopeLogs[].logRecords[].attributes[]` /
  `resourceSpans[]...attributes[]` shape without a schema-aware extractor.
  Before that scan, a shape-based pass (`maskOtlpJson`,
  `plugins/otlp-json-masking.ts`) redacts the `AnyValue` of every OTLP
  `{key, value}` attribute whose `key` is a secret name (`isSensitiveKey`:
  `api_key`, `auth_token`, `password`, ...): in OTLP the attribute name is data,
  not a property name, so `maskSecretsDeep` alone cannot see it and would pass a
  secret in an unrecognised format. It is not a skip-list — it only ever redacts.
  Strings are scanned in full via `maskSecretsInLongText`
  (`src/utils/long-text-masking.ts`), not cut at the 64 KB bound `maskSecretsInText`
  keeps for the hook pipeline: the text is split into 64 KB chunks at boundaries no
  secret pattern crosses (checked over an 8 KB window each side), and a PEM block
  left open at a chunk edge is redacted through its END line. It fails closed — if
  no safe interior boundary exists the remainder is redacted. Text beyond 8 MB per
  string is replaced by a `[TRUNCATED: N chars omitted]` marker; that cut is placed
  like any other boundary, and when none near it is safe the last chunk is omitted
  — so unscanned text is never forwarded. Residual limit: a multi-line match other
  than a PEM block that is longer than the 8 KB window can slip past the boundary
  check.
  Append the masked JSON as one NDJSON line to a new per-stream JSON spool
  file. A parse, masking or spool-write failure **drops the record** (logged at
  `warn`, session id and error message only — never the payload) and still
  answers 200; it never falls through to the branch below. The `.bin` fallback
  originally specified here was rejected: the bytes that failed masking would be
  forwarded unmasked, defeating this fix, and `forwardOtelStream` posts every
  `.bin` record as `application/x-protobuf`, so JSON bytes would also go out
  under the wrong content type. The cost is that a dropped record is lost — the
  client sees 200 and does not retry — which matches how the byte-blind branch
  already treats a spool write error.
- anything else (protobuf, or no header) → unchanged: extract the session id via
  today's latin1/UUID regex, append the raw bytes unmodified to today's existing
  `.bin` spool file. No parsing, no masking is attempted on this path.

**Spool** — `spool-paths.ts`'s `OTEL_STREAMS`/`STREAM_EXT` gain a second,
additive extension per signal, alongside the existing one:

```
logs:    .otel_logs.bin     (unchanged, protobuf)      .otel_logs.ndjson     (new, masked JSON)
metrics: .otel_metrics.bin  (unchanged, protobuf)       .otel_metrics.ndjson (new, masked JSON)
traces:  .otel_traces.bin   (unchanged, protobuf)       .otel_traces.ndjson  (new, masked JSON)
```

Each becomes its own independently-tracked spool stream (own file, cursor,
status bookkeeping) — the same composition `SPOOL_STREAMS` already uses for
`hooks` alongside the three OTEL streams, just six OTEL entries instead of
three. `listSessionIds`/`sweep.ts` pick up both extensions automatically once
both are listed, so every file stays discoverable and sweepable; no file can
become orphaned, because no extension is removed.

**Forwarder** — the existing `forwardOtelStream` (`forwarder.ts:253-276`) is
untouched and continues to apply only to `.bin` streams: accumulated raw bytes,
one `application/x-protobuf` POST, byte-for-byte, exactly as today. A new
forwarding path for the `.ndjson` OTEL streams follows `forwardHooks`'s existing
pattern (`forwarder.ts:204-251`): read pending NDJSON lines, send each as its
own complete `application/json` POST to the same per-signal endpoint
(`OTEL_ENDPOINTS[stream]`, `sso.http-client.ts`) used today. A record the backend
refuses for good — 400, 413 (the backend caps an OTLP body at
`ANALYTICS_INGEST_MAX_BODY_BYTES`, 5 MiB) or 422 — is dropped with a `warn` log
(session, stream and size only, never the payload) and the cursor advances past it,
so one bad record cannot stall the stream behind it. Other statuses, including every
other 4xx, keep the cursor and are retried. Hooks and `.bin` batches carry many
records per request and keep retrying on every non-OK status.

**Mid-session proxy upgrade** — `handleOtlp`'s branch is decided per inbound
request from that request's own `Content-Type` header, never pinned once for
the life of a session. If the proxy is updated/restarted partway through a
long-running CLI session, records already spooled to `.otel_*.bin` keep
forwarding unmasked exactly as today, and records arriving after the restart
are routed by their own `Content-Type` on each request. A single session can
therefore legitimately produce both `.bin` and `.ndjson` files for the same
stream — expected, not an error, since each extension is its own independently
tracked/forwarded stream and neither blocks on or orphans the other.

## Acceptance Criteria

- `claude-code-otlp.ts` writes `OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json'`.
- `handleOtlp` parses, masks (`maskSecretsDeep`, no custom skip-list), and
  NDJSON-spools any `application/json` OTLP POST.
- An OTLP attribute whose name is a secret name has its value replaced by
  `{"stringValue":"[REDACTED]"}` whatever the value looks like; attribute order
  and all other attributes are unchanged.
- An OTLP string attribute longer than 64 KB is masked in full (a secret past
  64 KB is redacted, the tail is kept); only text beyond 8 MB per string is
  replaced by a truncation marker.
- A masked JSON record the backend answers with 400, 413 or 422 is dropped (logged
  at `warn`) and the records behind it are still sent; any other non-OK response
  is retried without advancing.
- A secret named with a space (`api key: …`, `secret key = …`, `access key: …`) is
  masked like its `api_key` / `API-KEY` forms.
- A JSON OTLP POST that fails to parse, mask or spool is dropped with a `warn`
  log and a 200 response; its original bytes are never written to any spool
  stream.
- Any non-JSON OTLP POST is spooled via the existing byte-blind path, unchanged.
- Both `.bin` and `.ndjson` spool extensions coexist per OTEL stream and are
  both discoverable by session listing/cleanup; neither is renamed or retired.
- `.ndjson` streams forward one complete `application/json` POST per record;
  `.bin` streams keep forwarding as a single accumulated `application/x-protobuf`
  POST, exactly as today.
- A session emitting JSON OTEL telemetry has secrets (e.g. a token in a Bash
  command or an Edit's `old_string`/`new_string`) masked before leaving the
  spool; a session emitting protobuf is spooled/forwarded exactly as before the
  fix.
- `OtlpAgentAdapter.limitPayload` and the backend are untouched.

## Non-Goals

- Decoding, parsing, or masking protobuf/binary OTLP payloads.
- Any migration, rename, or one-time drain of pre-existing `.bin` spool files —
  moot, since the binary extension and behavior are kept permanently.
- A user-facing or config-driven protocol toggle — only the connector's fixed
  default literal changes.
- Extending this fix to other `OtlpAgentAdapter` subclasses (`copilot-chat-otlp`,
  `copilot-cli-otlp`, …) — none wire `OTEL_EXPORTER_OTLP_PROTOCOL` today; the
  proxy/spool/forwarder changes stay generic (keyed by content-type and stream
  name, not by agent).
- Changes to the hook-event masking pipeline or to the CodeMie backend.
- Writing or running automated tests, per repo policy (only on explicit request).

## Residual Risk (explicit, user-directed — not an oversight)

The protobuf path remains **permanently and intentionally unmasked**. Any OTLP
telemetry emitted over `http/protobuf` — a pre-upgrade session still running
with its old env var, a manually reconfigured client, or any future agent
plugin that chooses protobuf — still carries the original unmasked-secrets
exposure this ticket exists to close. This fix closes the gap only for the JSON
path, which becomes the CLI's own default going forward. Flagged here as a
conscious, stakeholder-approved scope boundary for later reviewers.

Pattern-based masking of the JSON path is also **best effort**, as it is for hook
events: a secret is caught when it has a known token format or follows a secret
name (`api_key=…`, `api key: …`, `password: …`). A secret written in running prose
with no such name or format — "here you go: q1w2e3r4t5y6i8!4", "the password is
hunter2" — is not detected and reaches the backend unmasked. This is accepted for
this ticket; record it on the Jira ticket as well.
