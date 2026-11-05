# OTLP JSON Masking (dual-format proxy pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Claude Code's native OTel exporter default to `http/json` and make the proxy mask secrets in that JSON path before spooling/forwarding, while the existing protobuf `.bin` path stays completely unchanged and permanently unmasked.

**Architecture:** `handleOtlp` branches on request `Content-Type`: `application/json` is parsed, masked with `maskSecretsDeep`, and appended as one NDJSON line to a new, additive per-signal `.ndjson` spool stream; anything else keeps today's byte-blind path into the existing `.bin` stream. A new forwarder function sends each masked NDJSON line as its own `application/json` POST, mirroring `forwardHooks`'s pattern; `forwardOtelStream` (binary) is untouched.

**Tech Stack:** TypeScript, Node `fs/promises`, existing `maskSecretsDeep`/`sanitizeLogArgs` (`src/utils/security.ts`), existing proxy plugin/spool/forwarder modules under `src/providers/plugins/sso/proxy/plugins/`.

## Global Constraints

- Never decode, parse, or mask protobuf/binary OTLP bytes — the `.bin` path, `forwardOtelStream`, and the existing three `OTEL_STREAMS` entries/extensions stay byte-for-byte unchanged.
- No migration, rename, or drain of existing `.bin` spool files.
- No user-facing or config-driven protocol toggle — only the connector's fixed literal changes.
- Do not touch `OtlpAgentAdapter.limitPayload`, any other `OtlpAgentAdapter` subclass, or the CodeMie backend.
- Do not commit anything during implementation — leave all changes in the working tree, staged or unstaged; the user reviews and commits manually.

---

### Task 1: CLI connector defaults to `http/json`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts:107`

**Interfaces:**
- Produces: Claude Code's own OTel SDK now receives `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` in `.claude/settings.json`'s `env` block, so every later task's JSON path has a real traffic source.

- [ ] **Step 1:** In `CODEMIE_ENV_FIXED_VALUES` change `OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'` to `OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json'`. No other key in that object changes.

Test-first: no — repo policy forbids writing/running tests without an explicit request.

- [ ] **Step 2:** Do not commit — leave this change in the working tree for the user to review and commit.

---

### Task 2: Spool paths — additive JSON/NDJSON stream identifiers

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.ts`

**Interfaces:**
- Consumes: existing `OTEL_STREAMS`, `OtelStream`, `SPOOL_STREAMS`, `SpoolStream`, `STREAM_EXT` (all stay as-is for the three binary entries).
- Produces: `OTEL_JSON_STREAMS: readonly ['logsJson','metricsJson','tracesJson']`, `OtelJsonStream` type, `OTEL_JSON_STREAM_BY_SIGNAL: Record<OtelStream, OtelJsonStream>`, `OTEL_SIGNAL_BY_JSON_STREAM: Record<OtelJsonStream, OtelStream>` — later tasks (ingestion, forwarder) import these by exact name.

- [ ] **Step 1:** After the existing `OTEL_STREAMS`/`OtelStream` block (`spool-paths.ts:13-15`), add:

```typescript
/** JSON/NDJSON counterpart of each OTEL signal — masked exports produced by the http/json proxy path. */
export const OTEL_JSON_STREAMS = ['logsJson', 'metricsJson', 'tracesJson'] as const;
export type OtelJsonStream = (typeof OTEL_JSON_STREAMS)[number];

/** Signal -> JSON stream id (ingestion handler picks the spool target from the request's signal). */
export const OTEL_JSON_STREAM_BY_SIGNAL: Record<OtelStream, OtelJsonStream> = {
  logs: 'logsJson',
  metrics: 'metricsJson',
  traces: 'tracesJson',
};

/** JSON stream id -> signal (forwarder picks the backend endpoint from the stream it is sending). */
export const OTEL_SIGNAL_BY_JSON_STREAM: Record<OtelJsonStream, OtelStream> = {
  logsJson: 'logs',
  metricsJson: 'metrics',
  tracesJson: 'traces',
};
```

- [ ] **Step 2:** Change `SPOOL_STREAMS` (`spool-paths.ts:18`) from `['hooks', ...OTEL_STREAMS] as const` to `['hooks', ...OTEL_STREAMS, ...OTEL_JSON_STREAMS] as const`. `SpoolStream` (derived from it) now includes the three new ids automatically.

- [ ] **Step 3:** Add three entries to `STREAM_EXT` (`spool-paths.ts:21-26`), alongside the existing four: `logsJson: '.otel_logs.ndjson'`, `metricsJson: '.otel_metrics.ndjson'`, `tracesJson: '.otel_traces.ndjson'`. Do not change any existing entry. `ALL_SUFFIXES` (line 40) derives from `STREAM_EXT` automatically, so `listSessionIds` (and `sweep.ts`, which consumes `listSessionIds`/`SPOOL_STREAMS`) discover and sweep the new files with no further edit to either.

Test-first: no — repo policy forbids writing/running tests without an explicit request.

- [ ] **Step 4:** Do not commit — leave this change in the working tree for the user to review and commit.

---

### Task 3: Spool IO — generic NDJSON snapshot + discard-backlog coverage

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.ts`

**Interfaces:**
- Consumes: `OTEL_STREAMS`, `OTEL_JSON_STREAMS` (`spool-paths.js`, Task 2); existing `gateStreamLocked`, `readStatus`, `readRange`, `withSessionLock`, `NEWLINE` (all already in this file, unchanged).
- Produces: `PendingNdjsonBatch` interface `{ project: string; cursor: number; records: string[]; byteLength: number }` and `snapshotPendingNdjsonRecords(sessionId: string, stream: SpoolStream): Promise<PendingNdjsonBatch | null>` — Task 5 (forwarder) calls this by exact name/signature.

- [ ] **Step 1:** Change the import on line 4 to also bring in `OTEL_JSON_STREAMS`. In `applyProjectPolicyLocked` (`spool-io.ts:182-186`), change `discardBacklogLocked(sessionId, status, OTEL_STREAMS)` to `discardBacklogLocked(sessionId, status, [...OTEL_STREAMS, ...OTEL_JSON_STREAMS])`, so a project-conflict discard clears the new JSON streams' backlog alongside the binary ones (same OTEL policy bucket) instead of leaving masked JSON secrets sendable while their binary sibling is discarded. No other line in this function changes; `gateStreamLocked`'s `stream === 'hooks' ? policy.hooks : policy.otel` branch (`spool-io.ts:212`) already routes any non-hooks stream — including the new ones — to the OTEL policy bucket, so it needs no edit.

- [ ] **Step 2:** After `snapshotPendingHookRecords` (ends `spool-io.ts:413`), add a new, hooks-independent helper for the JSON OTEL streams. Unlike hooks, OTEL streams have no per-record project filter (gating already happens at the whole-stream level via `gateStreamLocked`), so this is simpler than `snapshotPendingHookRecords`: it cuts on the last complete NDJSON line and returns nothing when there is no complete line yet (never consumes a partial trailing record):

```typescript
export interface PendingNdjsonBatch {
  /** Project the session is bound to; sent as `X-CodeMie-Project`. */
  project: string;
  /** Cursor the snapshot was taken from — pass it back when acknowledging. */
  cursor: number;
  /** Complete, newline-terminated NDJSON records that may be sent. */
  records: string[];
  /** Exact number of source bytes consumed, including the trailing newline of the last record. */
  byteLength: number;
}

/**
 * Consistent snapshot of the complete masked-JSON NDJSON records pending for one OTEL JSON stream.
 * Cuts at the last newline byte so an incomplete trailing record stays pending.
 * Must NOT be called while already holding the session lock.
 */
export async function snapshotPendingNdjsonRecords(
  sessionId: string,
  stream: SpoolStream
): Promise<PendingNdjsonBatch | null> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return null;
    const gate = await gateStreamLocked(sessionId, status, stream);
    if (!gate) return null;

    const cursor = status.cursors[stream];
    const pending = await readRange(sessionId, stream, cursor, gate.limit);
    if (!pending) return null;

    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return null;

    const complete = pending.subarray(0, lastNewline + 1);
    const records = complete
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    return { project: gate.project, cursor, records, byteLength: complete.length };
  });
}
```

Test-first: no — repo policy forbids writing/running tests without an explicit request.

- [ ] **Step 3:** Do not commit — leave this change in the working tree for the user to review and commit.

---

### Task 4: Proxy ingestion — mask-and-NDJSON-spool the JSON OTLP path

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts`

**Interfaces:**
- Consumes: `OTEL_JSON_STREAM_BY_SIGNAL` (`spool-paths.js`, Task 2), `maskSecretsDeep` (`src/utils/security.ts:240`, already exported, unchanged), existing `appendSpool`, `UUID_V4_RE`, `ctx.headers: Record<string,string>` (`proxy-types.ts:61`, already on `ProxyContext`).
- Produces: no new exports — `handleOtlp`'s observable behavior for `application/json` requests (masked NDJSON into the new stream) and for everything else (unchanged byte-blind path).

- [ ] **Step 1:** Add `OTEL_JSON_STREAM_BY_SIGNAL` to the `spool-paths.js` import (line 9) and `maskSecretsDeep` to the `security.js` import (line 8, alongside `sanitizeLogArgs`).

- [ ] **Step 2:** In `handleOtlp` (`otlp.plugin.ts:284-324`), after the existing early-return guards (gateway key, empty body — lines 289-298) and before the current `const bytes = ctx.requestBody;` line, insert a Content-Type branch. Read the header case-insensitively: `const contentType = (ctx.headers['content-type'] ?? '').toLowerCase();` then `if (contentType.startsWith('application/json')) { ... return ...; }` wrapping a `try`. Inside the `try`: decode `ctx.requestBody.toString('utf8')`, run the existing `UUID_V4_RE.exec(...)` against that utf8 text (not latin1) to get `sessionId`, `JSON.parse` the text, call `maskSecretsDeep(parsed)` with no second argument, `JSON.stringify` the result as one line, and `await appendSpool(sessionId, OTEL_JSON_STREAM_BY_SIGNAL[signal], line + '\n')`. If no `sessionId` was found, fall through to the existing byte-blind branch exactly like the current no-session-id case (log via `sanitizeLogArgs` and `res.end()` with 200) rather than writing an empty-session JSON record. On success, `res.statusCode = 200; res.end(); return true;` same as the existing branch's ending. Wrap the whole JSON attempt (parse, mask, stringify, append) in `try/catch`: on any thrown error, do not return or error the request — fall through into the existing byte-blind code below unchanged, so the original bytes still land in the `.bin` stream. This keeps the non-JSON branch (the rest of the existing method, lines ~300-323) completely unmodified and reachable both as the normal "not JSON" path and as the JSON path's failure fallback.

Test-first: no — repo policy forbids writing/running tests without an explicit request.

- [ ] **Step 3:** Do not commit — leave this change in the working tree for the user to review and commit.

---

### Task 5: Forwarder — per-line JSON POST for the new OTEL streams

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts`

**Interfaces:**
- Consumes: `OTEL_JSON_STREAMS`, `OtelJsonStream`, `OTEL_SIGNAL_BY_JSON_STREAM` (`spool-paths.js`, Task 2), `snapshotPendingNdjsonRecords`, `PendingNdjsonBatch` (`spool-io.js`, Task 3), existing `send`, `advanceCursor`, `OTEL_ENDPOINTS`, `markCredentialsStale`.
- Produces: no new exports — extends `forwardSession`'s observable behavior to also forward the three new streams; `forwardOtelStream` and its `OTEL_STREAMS` loop are untouched.

- [ ] **Step 1:** Add `OTEL_JSON_STREAMS`, `type OtelJsonStream`, `OTEL_SIGNAL_BY_JSON_STREAM` to the `spool-paths.js` import (line 8) and `snapshotPendingNdjsonRecords` to the `spool-io.js` import (lines 14-18).

- [ ] **Step 2:** After `forwardOtelStream` (ends `forwarder.ts:276`), add a new function that sends one complete `application/json` POST per NDJSON line, mirroring `forwardHooks`'s shape but without reassembling into a single batch body:

```typescript
/** Forward masked-JSON OTEL records: one complete application/json POST per NDJSON line. */
async function forwardOtelJsonStream(
  sessionId: string,
  stream: OtelJsonStream,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<SendResult | 'idle'> {
  const batch = await snapshotPendingNdjsonRecords(sessionId, stream);
  if (!batch) {
    return 'idle';
  }

  if (batch.records.length === 0) {
    // Nothing sendable, but the bytes were consumed — keep the cursor aligned.
    await advanceCursor(sessionId, stream, batch.cursor + batch.byteLength);
    return 'idle';
  }

  const url = `${baseUrl}${OTEL_ENDPOINTS[OTEL_SIGNAL_BY_JSON_STREAM[stream]]}`;
  const range = { cursor: batch.cursor, end: batch.cursor + batch.byteLength, filtered: false };
  for (const record of batch.records) {
    const result = await send(sessionId, stream, url, record, 'application/json', credentials, batch.project, range);
    if (result !== 'ok') {
      return result;
    }
  }

  await advanceCursor(sessionId, stream, batch.cursor + batch.byteLength);
  return 'ok';
}
```

- [ ] **Step 3:** In `forwardSession` (`forwarder.ts:289-313`), after the existing `for (const stream of OTEL_STREAMS) { ... }` loop (lines 306-312) and before the function's closing brace, add a second loop with the same auth-expired short-circuit:

```typescript
  for (const stream of OTEL_JSON_STREAMS) {
    const result = await forwardOtelJsonStream(sessionId, stream, baseUrl, credentials);
    if (result === 'auth-expired') {
      markCredentialsStale();
      return;
    }
  }
```

Test-first: no — repo policy forbids writing/running tests without an explicit request.

- [ ] **Step 4:** Do not commit — leave this change in the working tree for the user to review and commit.

---

## Self-Review

**Spec coverage:**
- CLI default `http/json` → Task 1.
- `handleOtlp` Content-Type branch, UUID regex on utf8 text, `maskSecretsDeep` with no skip-list, NDJSON-spool, fallback-on-failure → Task 4.
- Non-JSON path unchanged → Task 4, Step 2 (explicitly leaves it untouched).
- Second permanent `.ndjson` extension per OTEL stream, additive to `.bin`, discoverable by `listSessionIds`/`sweep.ts` → Task 2.
- New forwarder path for `.ndjson` streams, one POST per NDJSON line, `forwardOtelStream`/`.bin` untouched → Task 5.

**Negative constraints (spec Non-Goals + scattered "untouched"/"must not" language):**
- "Decoding, parsing, or masking protobuf/binary OTLP payloads" — never attempted; Task 4's non-JSON branch and Task 5's `forwardOtelStream` are explicitly left byte-for-byte unmodified.
- "Any migration, rename, or one-time drain of pre-existing `.bin` spool files" — Task 2 only adds entries to `STREAM_EXT`/`SPOOL_STREAMS`; no existing entry is renamed or removed.
- "A user-facing or config-driven protocol toggle" — Task 1 changes only the fixed `CODEMIE_ENV_FIXED_VALUES` literal; no new config surface is introduced anywhere.
- "Extending this fix to other `OtlpAgentAdapter` subclasses" — no file outside the six touched in Tasks 1-6 is modified; the proxy/spool/forwarder changes are generic (keyed by content-type and stream name), per spec.
- "Changes to the hook-event masking pipeline or to the CodeMie backend" — `OtlpAgentAdapter.limitPayload`, `handleHooks`, `forwardHooks`, and the backend are not touched by any task; Task 3/5 only add new sibling code paths alongside the existing hook functions.

**Type consistency:** `OtelJsonStream`, `OTEL_JSON_STREAMS`, `OTEL_JSON_STREAM_BY_SIGNAL`, `OTEL_SIGNAL_BY_JSON_STREAM` (Task 2) are the exact names Task 4 and Task 5 import. `PendingNdjsonBatch`/`snapshotPendingNdjsonRecords` (Task 3) are the exact names Task 5 imports and calls with signature `(sessionId: string, stream: SpoolStream)`.

negative-constraints: covered above (not "none stated" — the spec's Non-Goals section and inline "untouched" language were enumerated and checked against the task list).
