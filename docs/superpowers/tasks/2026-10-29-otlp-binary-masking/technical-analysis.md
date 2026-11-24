# Technical Research

**Task**: otel otlp masking proxy-spool telemetry
**Generated**: 2026-10-29
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-16383 ([CodeMie CLI][Analytics][Security] Secrets in forwarded hook payloads are sent to CodeMie analytics unmasked) was previously fixed for event hooks only: secrets are now masked once, at hook time, in the shared `OtlpAgentAdapter`, before the event reaches the spool. That path is `claude-code-otlp` hook events -> `OtlpAgentAdapter.limitPayload` -> proxy daemon spool -> `otlp-spool/forwarder.ts` -> analytics API, and `sanitizeLogArgs` covers local logs only.

QA's latest verification comment found the fix is PARTIAL: hook events are correctly masked, but native OTEL telemetry (metrics, logs, traces — emitted via the OpenTelemetry SDK/OTLP exporter, not via the hook pipeline) is NOT masked. Raw secret values (API keys, tokens, passwords, connection strings) end up stored unmasked in the backend's `log_events.attrs` and `spans.attrs` database columns. Example leak: a Bash command's tool_input/tool_result and an Edit's old_string/new_string containing a real secret were found in log_events.attrs and spans.attrs for sessions that exercised Bash with an inline token, and an Edit of a .env file with a new key.

Task: find and document the native OTEL (metrics/logs/traces) export and ingestion path end-to-end, as a parallel/separate pipeline from the OtlpAgentAdapter hook-event pipeline:
1. Where/how the CLI exports native OTel logs and traces (OpenTelemetry SDK setup, exporter configuration, protocol/encoding used — binary protobuf vs text/JSON, e.g. OTLP/HTTP protobuf vs OTLP/HTTP JSON).
2. The proxy-side OTLP spool/forwarder code that receives/relays this native OTel data (likely under the proxy's otlp-spool directory structure, separate from or shared with the hook-event spool/forwarder in src/) — identify the actual file paths in this repository.
3. Where/how masking (sanitizeLogArgs or similar) is currently applied, and confirm it is NOT applied anywhere along this native OTel export/forward path for logs/traces/metrics attributes (tool_input, tool_result, old_string, new_string, command args, etc).
4. Whether the data crossing this path is binary-encoded (e.g. protobuf) at any proxy hop, which would explain why simple text-based masking/regex scanning doesn't currently apply to it.
5. Any existing format/protocol switches, config flags, or exporter options already in the codebase that could switch the OTLP transport from binary (protobuf) to text/JSON (OTLP accepts application/json content-type per spec) — on both the CLI exporter side and the proxy spool/forwarder side.
6. Related: how the previous (hook-event) fix was implemented — locate `OtlpAgentAdapter`, `limitPayload`, `sanitizeLogArgs`, and the hook spool/forwarder files, so the new fix can follow the same masking utility/pattern for the native OTel path, generically (not Claude-Code specific) if the OTel SDK/exporter plumbing is shared across agent plugins.

Also note: this analysis will inform switching native OTLP export from binary to text/JSON content-type to simplify masking at the proxy, so pay close attention to exactly where binary encoding happens and what would need to change (exporter config, proxy parsing/decoding, spool file format on disk) to move to text/JSON.

---

## 2. Codebase Findings

### Existing Implementations

**CLI-side exporter configuration (not an exporter implementation — no OTel SDK in this repo):**
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts` — `writeClaudeCodeOtlpConfig()` writes `.claude/settings.json` `env` block that points **Claude Code's own bundled OpenTelemetry SDK** at the local proxy daemon. Key constants:
  - `CODEMIE_ENV_FIXED_VALUES` (L104-112): `CLAUDE_CODE_ENABLE_TELEMETRY: '1'`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1'`, **`OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'`**, `OTEL_LOGS_EXPORTER: 'otlp'`, `OTEL_METRICS_EXPORTER: 'otlp'`, `OTEL_TRACES_EXPORTER: 'otlp'`, `OTEL_LOG_TOOL_DETAILS: '1'`.
  - `OTEL_EXPORTER_OTLP_ENDPOINT` is set dynamically (L455) to `${state.url}/v1/analytics/otlp` (the live proxy daemon URL); `OTEL_EXPORTER_OTLP_HEADERS` (L456) carries `Authorization=Bearer <gatewayKey>`.
  - `package.json` has **no `@opentelemetry/*` dependency** (grep confirmed zero matches) — this repo never constructs OTLP payloads itself for the native-telemetry path; it only configures Claude Code's bundled exporter via env vars. Claude Code's SDK appends the standard per-signal suffixes (`/v1/logs`, `/v1/metrics`, `/v1/traces`) to the configured base endpoint.
- `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` (separate allowlist env var, `claude-code-otlp.allowlist.ts`) gates which projects' **hooks** get forwarded; OTEL env vars are global per Claude Code install, so OTEL data is always exported regardless of allowlist (see §6.14 of `docs/ARCHITECTURE-PROXY.md`, "OTEL-only invariant").

**Proxy-side ingestion (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts`):**
- `OtlpInterceptor.handleRequest` (L166-193) routes `POST /v1/analytics/otlp/v1/logs|metrics|traces` to `handleOtlp(ctx, res, signal)` (L284-324), separately from `POST /v1/analytics/hooks` -> `handleHooks`.
- `handleOtlp` (L284-324): takes `ctx.requestBody` (a `Buffer`, never parsed), extracts a session id by running a UUID-v4 regex directly over the **latin1-decoded raw bytes** (`Buffer.from(bytes).toString('latin1')`, L303) — this works without protobuf parsing because a UUID string is pure ASCII and protobuf length-prefixed strings carry their bytes literally. It then calls `appendSpool(sessionId, signal, bytes)` with the **unmodified raw bytes**. No field extraction, no decoding, no masking function is called anywhere in this method.
- Contrast: `handleHooks` (L199-282) parses the body as JSON, validates structure, and stores NDJSON records that were already masked at hook time inside `OtlpAgentAdapter.buildEvent`/`limitPayload` (see §6 below) before they ever reached this endpoint.

**Spool storage (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`):**
- `spool-paths.ts` (L13-26): `OTEL_STREAMS = ['logs', 'metrics', 'traces']`, comment: "OTEL binary streams (protobuf payloads produced by the agent runtime)". File extensions: `.otel_logs.bin`, `.otel_metrics.bin`, `.otel_traces.bin` — the `.bin` suffix and the comment both confirm the on-disk spool format is the raw protobuf byte stream, concatenated as-received.
- `spool-io.ts`: `appendSpool` appends raw `Buffer`/string directly with `appendFile`; `snapshotPendingBytes` (L330-343) reads a byte range back as a `Buffer` for forwarding — no transformation at any point for OTEL streams.

**Forwarding (`src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts`):**
- `forwardOtelStream` (L253-276) reads the pending byte range and calls `send(..., 'application/x-protobuf', ...)` (L267) — the Content-Type is **hardcoded** to `application/x-protobuf` regardless of what was actually received, and the bytes are POSTed byte-for-byte to `OTEL_ENDPOINTS[stream]` (`CLI_ANALYTICS_LOGS` / `_METRICS` / `_TRACES` from `sso.http-client.ts` L27-30, i.e. `/v1/analytics/cli-analytics/logs|metrics|traces`).
- `forwardHooks` (L204-251), by contrast, forwards with `'application/x-ndjson'` and calls `unwrapHookRecords` which only unwraps the spool envelope — the hook payload inside was already masked at hook-build time, not here.
- No masking utility (`maskSecretsDeep`, `sanitizeLogArgs`, or any text scan) is imported or called anywhere in `otlp.plugin.ts`'s `handleOtlp`, in `spool-io.ts`'s OTEL-stream code paths, or in `forwarder.ts`'s `forwardOtelStream`. This is the confirmed gap QA found.

### Architecture and Layers Affected

Two parallel, structurally similar but code-distinct pipelines share only the spool directory and the forwarder module:
```
Hook pipeline:  Claude Code hook -> codemie hook --agent claude-code-otlp -> OtlpAgentAdapter.buildEvent/limitPayload (masks + truncates) -> handleHooks -> *.hooks.ndjson -> forwardHooks (application/x-ndjson) -> CLI_ANALYTICS_EVENT_HOOKS
OTEL pipeline:  Claude Code's own OTel SDK -> raw protobuf POST to local proxy -> handleOtlp (no decode, no mask) -> *.otel_{logs,metrics,traces}.bin -> forwardOtelStream (application/x-protobuf) -> CLI_ANALYTICS_{LOGS,METRICS,TRACES}
```
- Layer "CLI connector" (`src/cli/commands/proxy/connectors/claude-code-otlp.ts`) only configures env vars; it does not touch payload content.
- Layer "proxy ingestion" (`otlp.plugin.ts`) is the first point in this repo that sees OTEL bytes, and currently treats them as an opaque blob.
- Layer "spool" (`otlp-spool/spool-io.ts`, `spool-paths.ts`) stores/retrieves the opaque blob unchanged.
- Layer "forwarder" (`otlp-spool/forwarder.ts`) transports the opaque blob unchanged, declaring a fixed `application/x-protobuf` content type.

### Integration Points

- `src/providers/plugins/sso/sso.http-client.ts` defines the four backend endpoints (`CLI_ANALYTICS_EVENT_HOOKS`, `_METRICS`, `_LOGS`, `_TRACES`), all under `/v1/analytics/cli-analytics/...` on the real CodeMie backend — a different repo/service owns the receiving/parsing side and is out of scope here.
- `otlp-spool/session-project.ts` / `session-status.ts` gate sending by project binding; this applies identically to OTEL and hook streams and is unrelated to masking.
- `docs/ARCHITECTURE-PROXY.md` §6.14 documents the allowlist/OTEL-only invariant: OTEL data is exported globally by Claude Code regardless of the hooks allowlist, since OTel env vars carry no per-project scoping.

### Patterns and Conventions

- The hook-event masking fix (already shipped, commit `54e24e7`) lives entirely in `src/agents/core/OtlpAgentAdapter.ts`:
  - `limitPayload` (around L220) truncates `prompt`/`tool_input`/`tool_response`/`error`/`description`, then calls `maskSecretsDeep(unmasked, UNMASKED_FIELD_KEYS)` (L237) — `maskSecretsDeep` and `maskSecretsInText` live in `src/utils/security.ts` and operate on **parsed JS values** (strings/objects), using regex-based pattern matching (`EMBEDDED_SECRET_PATTERNS`, L176-221) plus a sensitive-key skip list. This utility has no awareness of protobuf and cannot be pointed at raw binary bytes without first decoding them into field-level text.
  - `sanitizeLogArgs` (`src/utils/security.ts` L375) is the equivalent used for local debug logs only (`~/.codemie/logs/debug-*.log`), not for anything forwarded to the backend.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` documents the hook pipeline in full detail (pattern-based masking "always on" for every hook field) but does **not** mention the native OTEL logs/metrics/traces path at all — it is out of that document's scope.
- A prior technical-analysis for the same ticket's hook-only fix exists at `docs/superpowers/tasks/2026-10-28-epmcdme-16383-mask-sensitive-data/technical-analysis.md` and corresponding `spec.md`/`plan.md` — useful background on exactly which fields and call sites the shipped fix touched, confirming it never reached `otlp.plugin.ts`'s `handleOtlp`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — full hook-event pipeline contract, masking description (§2), and reference adapter (§6). Confirms masking is "always on" for hooks but is silent on native OTEL metrics/logs/traces, consistent with the code.
- `docs/ARCHITECTURE-PROXY.md` §6.14 ("Claude Code OTLP Per-Project Allowlist") — documents that `otlp.plugin.ts` "receives Claude Code OTel data and hook events into a disk spool", and that "the daemon has no allowlist logic because OTLP carries no cwd" — i.e. the daemon does not parse OTEL payload content at all, consistent with the raw-bytes-through finding above.
- `.ai-run/guides/security/security-practices.md` — "Always sanitize before logging" section covers local logging (`sanitizeLogArgs`) only, not forwarded telemetry.
- No guide in this repository documents the backend's `log_events.attrs` / `spans.attrs` schema the ticket references; that contract (`cli-analytics-events.md`) was previously located under a sibling repository (`codemie/.ai-run/guides/...`) per the prior task's analysis, not inside this repository, and is not re-verified here since this task's own context did not name that path explicitly.

### Architectural Decisions

- `forwarder.ts` comments (L158-160 equivalent / "Forward the raw protobuf bytes after an OTEL stream's cursor") and `spool-paths.ts` ("OTEL binary streams (protobuf payloads produced by the agent runtime)") are explicit, deliberate decisions: the forwarder is transport-only and never interprets OTEL bytes.
- The hook-pipeline fix deliberately placed masking at hook-build time (`OtlpAgentAdapter`), not at the spool or forwarder layer, specifically because the forwarder's contract is "same bytes on every retry" (tested in `otlp-spool/__tests__/forwarder.test.ts`). The equivalent decision for the OTEL path does not yet exist.

### Derived Conventions

- Every other proxy-forwarded stream in this codebase is masked at the point where the payload is still structured (JS objects), before it becomes an opaque byte stream. The OTEL path breaks this convention by becoming opaque (protobuf bytes) at the source (Claude Code's own process), before this codebase ever sees it — the proxy is the earliest point this repository could intervene, and it currently does not.
- Content-Type is asserted by this codebase on the way out (`application/x-protobuf`, hardcoded) rather than being derived from what was actually received on the way in — there is currently no code path here that branches on an incoming `Content-Type` header for the `/v1/analytics/otlp/v1/*` routes at all (`handleOtlp` ignores request headers entirely).

---

## 4. Testing Landscape

### Existing Coverage

- `src/providers/plugins/sso/proxy/plugins/__tests__/otlp.plugin.hooks.test.ts` — covers only the `/v1/analytics/hooks` route (`handleHooks`); confirmed by search that it contains no reference to `handleOtlp`, `/v1/logs`, `/v1/metrics`, or `/v1/traces`.
- `src/providers/plugins/sso/proxy/plugins/__tests__/otlp.plugin.credentials-refresh.test.ts` — credential refresh behavior, not payload content.
- `otlp-spool/__tests__/forwarder.test.ts` — exercises `forwardHooks`/status-code handling; grep shows status-code cases (200/401/403/302/301/500/503) but is scoped to the hooks path per the prior task's analysis.
- `otlp-spool/__tests__/spool-io.test.ts`, `tick-processor.test.ts`, `project-interleave.test.ts` — session/project bookkeeping, not OTEL payload content.
- `src/utils/__tests__/security.test.ts` — thorough coverage of `maskSecretsDeep`/`maskSecretsInText`/`sanitizeLogArgs` against text/object inputs; no case exercises these against binary/protobuf input.

### Testing Framework and Patterns

Vitest, colocated `__tests__/*.test.ts`, dynamic `await import()` after `vi.mock()`, `fetchMock` fakes for forwarder HTTP calls (see `forwarder.test.ts`'s `fetchMock` helper).

### Coverage Gaps

- `handleOtlp` (`otlp.plugin.ts` L284-324) has **no dedicated test file** — no test asserts what happens to logs/metrics/traces bytes end-to-end (session-id extraction via regex on raw bytes, spool write, or lack of masking).
- `forwardOtelStream` has no test separate from the hooks-focused `forwarder.test.ts`.
- No existing test parses a real/fixture protobuf OTLP payload anywhere in the suite — any fix that needs to decode protobuf (or switch to JSON) starts with zero existing fixtures or parsing helpers to build on.

---

## 5. Configuration and Environment

### Environment Variables

- `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_LOG_TOOL_DETAILS` — all fixed literals written by `writeClaudeCodeOtlpConfig()` into `.claude/settings.json`'s `env` block (`src/cli/commands/proxy/connectors/claude-code-otlp.ts`, `CODEMIE_ENV_FIXED_VALUES`).
- `OTEL_EXPORTER_OTLP_PROTOCOL` — fixed to `'http/protobuf'` today (same location, L107). This is the literal, single-line control point for switching Claude Code's own OTel SDK to emit `application/json` instead (OTel spec's `http/json` value) — changing this one string is the CLI-side half of a binary-to-JSON switch. No other code in this repository currently reads or branches on this value.
- `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` — daemon-derived (live proxy URL + gateway-key bearer token), computed at connect time, not static config.
- `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` — separate allowlist env var; governs hooks tracking only, not OTEL export (OTEL is exported unconditionally per the "OTEL-only invariant").

### Configuration Files

- `.claude/settings.json` (user's Claude Code config, written/merged by the connector) — the only file where the OTEL exporter protocol/endpoint is configured; this repository does not ship or control Claude Code's OTel SDK itself.
- No `config.example.json` or profile config in this repo mentions OTLP protocol/encoding — it is entirely inside the Claude-Code-specific connector.

### Feature Flags and Deployment Concerns

- There is no existing feature flag or env var in this repo that toggles the proxy's own handling between "treat as protobuf" and "treat as JSON" for the `/v1/analytics/otlp/v1/*` routes — `handleOtlp` has exactly one code path regardless of what arrives. A masking fix that depends on a protocol switch would need to add that branch (or always assume one format once the CLI side switches).
- `forwardOtelStream`'s hardcoded `'application/x-protobuf'` Content-Type (forwarder.ts L267) would need to become conditional (or simply updated to `'application/json'`) in lockstep with any CLI-side `OTEL_EXPORTER_OTLP_PROTOCOL` change, and the backend's four `cli-analytics-logs|metrics|traces` endpoints would need to accept the new content type — that backend behavior is outside this repository and unverified here.

---

## 6. Risk Indicators

- **Binary encoding is the core blocker for masking.** `handleOtlp` only reads bytes to find a session id via a narrow UUID regex over latin1-decoded bytes; it never decodes field-level content (span/log attribute key-value pairs), because doing so for `http/protobuf` requires a full protobuf schema/parser (`opentelemetry-proto` logs/trace/metrics messages) that does not exist anywhere in this codebase or its dependencies today. Masking string values embedded in protobuf-encoded bytes with simple text regexes (as `maskSecretsDeep` does) is unsafe: length-prefixed fields would desync if a replacement string has a different byte length than the matched secret, corrupting the rest of the message.
- **Switching to `http/json` moves the masking problem from "needs a protobuf decoder" to "needs to parse OTLP's JSON schema" (nested `resourceLogs[].scopeLogs[].logRecords[].attributes[]` / `resourceSpans[].scopeSpans[].spans[].attributes[]` key/value arrays per the OTLP spec) — this is a structured-JSON masking task the existing `maskSecretsDeep` utility could, with effort, be adapted to target (it already walks arbitrary JS object graphs), but it would need a new OTLP-attribute-specific skip/target list rather than the hook-event field names it currently special-cases (`UNMASKED_FIELD_KEYS` is hook-schema-specific).**
- **Changing `OTEL_EXPORTER_OTLP_PROTOCOL` to `'http/json'` is a single-line CLI-side change** (`CODEMIE_ENV_FIXED_VALUES` in `claude-code-otlp.ts`), but three other places must change in lockstep or the pipeline breaks: (1) `handleOtlp` currently never inspects `Content-Type` and would keep spooling bytes unchanged either way (safe but does nothing for masking on its own), (2) the on-disk spool extension/semantics (`*.otel_logs.bin` etc., `spool-paths.ts`) implies binary and would be misleading/incorrect for JSON bytes even though the code itself is encoding-agnostic, (3) `forwardOtelStream`'s hardcoded `application/x-protobuf` Content-Type (forwarder.ts) would mislabel JSON bytes to the backend, which could reject or mis-parse them.
- **Zero test coverage on this path today** (`handleOtlp`, `forwardOtelStream` have no dedicated tests, no protobuf/JSON fixtures exist in the suite) — any fix here is the first code in the repo to need OTLP payload fixtures, raising implementation and review cost.
- **Backend dependency is unverified from this repo.** Whether the CodeMie analytics backend's `/v1/analytics/cli-analytics/logs|metrics|traces` endpoints already accept `application/json` (OTLP/HTTP JSON is part of the OTel spec, but acceptance is backend-specific) cannot be confirmed from this codebase alone.
- **Scope beyond Claude Code is unclear.** The env-var wiring and allowlist live in `claude-code-otlp`-specific files; no other `OtlpAgentAdapter` subclass (`copilot-chat-otlp`, `copilot-cli-otlp`) is wired to native OTel SDK export via env vars in the files reviewed, so a generic "OTel SDK/exporter plumbing shared across agent plugins" (as hinted by the ticket's point 6) was not found — the exporter is Claude Code's own bundled SDK, not a plugin owned by this repo, which narrows (not widens) the blast radius of a CLI-side protocol change to the one connector file.

---

## 7. Summary for Complexity Assessment

This task touches two architectural layers inside one repository: the CLI connector that configures Claude Code's bundled OpenTelemetry SDK via environment variables (`src/cli/commands/proxy/connectors/claude-code-otlp.ts`, one literal value controls protocol), and the local proxy daemon's OTLP ingestion/spool/forward pipeline (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts`, `otlp-spool/spool-io.ts`, `otlp-spool/spool-paths.ts`, `otlp-spool/forwarder.ts`). None of this repository's code constructs or parses OTLP protobuf today — there is no `@opentelemetry/*` dependency; the native telemetry export is entirely Claude Code's own SDK, and this repo only relays opaque bytes end to end (confirmed by `handleOtlp`'s byte-blind session-id regex extraction and `forwardOtelStream`'s hardcoded `application/x-protobuf` content type). This is the structural reason masking does not apply today: the existing masking utility (`maskSecretsDeep`/`maskSecretsInText`, `src/utils/security.ts`) operates on parsed JS values, not binary bytes, and nothing in the OTEL path ever parses the payload.

Technical novelty is high relative to the rest of the codebase: fixing this requires either a protobuf decoder/re-encoder for OTLP logs/traces/metrics messages (risky, since naive text substitution on protobuf bytes corrupts length-prefixed fields), or a coordinated protocol switch to `http/json` across three code locations (CLI env var, proxy forward Content-Type, and implicitly the on-disk spool file semantics) plus a new JSON-structure-aware masking pass targeting OTLP's `attributes[]` arrays — and in either case, a backend-side content-type acceptance change this repository cannot verify. Test coverage on the exact code this task will touch is currently zero (`handleOtlp` and `forwardOtelStream` have no dedicated tests and no protobuf/JSON fixtures exist anywhere in the suite), so any fix starts from scratch on fixtures as well as logic. The already-shipped hook-event masking fix in `OtlpAgentAdapter.limitPayload` is a usable pattern reference (mask structured fields before they leave the process) but is not directly reusable code, since it is keyed to hook-event field names rather than OTLP's generic attribute-array shape.

---

## 8. External References

None named by the task. (The prior, hook-only fix's technical-analysis at `docs/superpowers/tasks/2026-10-28-epmcdme-16383-mask-sensitive-data/technical-analysis.md` references a backend contract guide, `cli-analytics-events.md`, located under a sibling `codemie` repository checkout — that path was not named by this task's own context and was not re-opened here; it is noted above in §3 for awareness only.)

## 9. External Verification (backend format support, checked directly against C:\Repositories\codemie)

Confirmed by reading the backend source directly (not inferred):

- `src/codemie/repository/cli_analytics/postgres/otlp.py`:
  - `JSON_MEDIA_TYPE = "application/json"` (line 76), `PROTOBUF_MEDIA_TYPES = frozenset({"", "application/x-protobuf", "application/protobuf"})` (line 77).
  - `parse_request()` (lines 507-527) branches on the request `content-type`: protobuf bytes go through `message.ParseFromString(body)`; `application/json` goes through `json.loads(body)` + `json_format.ParseDict(document, message, ...)`. Both paths populate the same typed OTLP message, decoded identically downstream.
  - `decode_otlp()` (line 862) calls `parse_request` then the normal per-signal decoders — no divergent handling after parsing, so masking applied to the *source* JSON before this call is preserved.
- `src/codemie/repository/cli_analytics/postgres/ingestor.py` (`_otlp_result`, lines 235-242): the OTLP response is also echoed back in whichever media type the request used (JSON vs protobuf), so a JSON request round-trips cleanly.
- `src/codemie/rest_api/routers/cli_analytics.py` (`_ingest_otlp`, lines 163-171): reads `content-type` from the incoming request header with `application/x-protobuf` only as the *default* when the header is absent — JSON is accepted today without any backend change.

**Conclusion: the backend already accepts OTLP/JSON on `/logs`, `/metrics`, `/traces` with no backend-side change required.** This repository's own proxy forwarder (`otlp-spool/forwarder.ts`, `forwardOtelStream`) is what hardcodes `application/x-protobuf` on the way out — that is a client-side choice, not a backend constraint.

### Local pipeline, byte-blind confirmed end to end

- `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts` (`handleOtlp`, lines 284-324): extracts the session id via a UUID-v4 regex over the raw bytes decoded as latin1 (`UUID_V4_RE.exec(latin1Str)`), then spools the untouched bytes via `appendSpool(sessionId, signal, bytes)`. No parsing, no masking, at any point in this handler.
- `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.ts`: `OTEL_STREAMS = ['logs','metrics','traces']`, each with a `.bin`-style extension (`.otel_logs.bin`, `.otel_metrics.bin`, `.otel_traces.bin`) versus `hooks`' `.hooks.ndjson` — the extension itself documents the binary assumption.
- `src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts` (`forwardOtelStream`, bottom of file): forwards `pending.bytes` raw with hardcoded `'application/x-protobuf'` content type; `forwardHooks` by contrast sends parsed/reassembled NDJSON with `'application/x-ndjson'`.
- The CLI's own OTel SDK protocol is pinned at `src/cli/commands/proxy/connectors/claude-code-otlp.ts` line 107: `OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'` (a default the connector writes into Claude Code's settings env; `http/json` is the OpenTelemetry-spec alternative value for the same env var).

### Shape implication for a JSON-based fix

Switching `OTEL_EXPORTER_OTLP_PROTOCOL` to `http/json` makes each OTel SDK export call emit one self-contained JSON object (an `ExportLogsServiceRequest`/`ExportMetricsServiceRequest`/`ExportTraceServiceRequest`-shaped document) per HTTP POST to the proxy, not an NDJSON stream. Today's binary spool silently supports concatenating multiple export calls' protobuf bytes into one file and forwarding the whole blob in one POST, because protobuf's wire format merges repeated fields on concatenation (the backend's own comment confirms this: "Concatenated requests merge into one: their repeated fields append"). That concatenation trick does not hold for JSON — `JSON.parse` cannot parse two concatenated JSON objects as one. Any JSON-based spool therefore needs a record-per-export-call framing (one JSON document per line, NDJSON-style, mirroring the existing `hooks` stream's own file format) and the forwarder must POST each record as its own backend request, rather than accumulating raw bytes across ticks the way `forwardOtelStream` does today.
