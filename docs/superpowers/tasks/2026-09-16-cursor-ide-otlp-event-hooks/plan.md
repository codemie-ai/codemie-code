# Cursor-IDE OTLP Event Hooks: Proxy-to-Backend Leg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the proxy -> CodeMie backend leg of cursor-ide OTLP event forwarding: push the raw hook payload to `POST /v1/analytics/cli-analytics/event-hooks` as NDJSON, fire-and-forget, without disturbing the existing local-JSONL debug sink; add scaffolding-only constants/stubs for metrics/logs/traces.

**Architecture:** `OtlpIngestPlugin.createInterceptor` starts threading `PluginContext` credentials/baseUrl into `OtlpIngestInterceptor` (mirroring `SSOSessionSyncPlugin`'s pattern, minus its `ConfigurationError` gating - this plugin must stay registered unconditionally). `handleRequest` keeps its existing local append untouched and adds an un-awaited `pushToBackend` call after it. No backend or other-file changes.

**Tech Stack:** TypeScript, Node `fetch`, `AbortController`. No test framework touched (PoC, no tests requested).

**Requirements source:** requirements arrived inline (no spec.md) - see task-dir `technical-analysis.md` for the full verbatim text and codebase findings.

## Global Constraints

- No retry/backoff/queueing anywhere in `pushToBackend` or the stub methods - single attempt only.
- `OtlpIngestPlugin` must stay registered unconditionally - no `ConfigurationError`/throw on missing credentials or baseUrl, unlike `SSOSessionSyncPlugin`.
- `pushToBackend` must never throw past its own try/catch - it must not turn the existing 202 response into a 500 via `handleRequest`'s outer catch.
- `transformToEventHookRecord` stays a genuine no-op passthrough - no hardcoded/mock business-field mapping.
- `pushMetrics`/`pushLogs`/`pushTraces` are stubs only - never called from `handleRequest` or elsewhere.
- Exactly two files change: `src/providers/plugins/sso/sso.http-client.ts`, `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts`. No tests added.

Commit per task using the repository's existing convention (Conventional Commits, per AGENTS.md).

---

## Acceptance criteria

- [ ] Raw hook-event data POSTed to `/v1/analytics/cli-analytics/event-hooks` is visible in the local ClickHouse `codemie_analytics.coding_agent_hook_events` table via `mv_hook_events` (verified manually against local docker-compose backend - not an automated check in this plan).
- [ ] `/metrics`, `/logs`, `/traces` have endpoint constants and no-op stub push methods only - no functional or observability behavior, not wired into any call site.
- [ ] Existing local `~/.codemie/logs/hook-events.jsonl` debug-append and 202 response behavior are unchanged, including when no backend credentials/baseUrl are configured.

---

### Task 1: Add CLI analytics endpoint constants

**Files:**
- Modify: `src/providers/plugins/sso/sso.http-client.ts:19-26` (the `CODEMIE_ENDPOINTS` const object)

**Interfaces:**
- Produces: `CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS`, `.CLI_ANALYTICS_METRICS`, `.CLI_ANALYTICS_LOGS`, `.CLI_ANALYTICS_TRACES` (all `string`) - consumed by Task 3.

Test-first: no - PoC scope, no tests requested; constants-only change.

- [ ] **Step 1:** Add four keys to `CODEMIE_ENDPOINTS`, following the file's existing convention:

```ts
CLI_ANALYTICS_EVENT_HOOKS: '/v1/analytics/cli-analytics/event-hooks',
CLI_ANALYTICS_METRICS: '/v1/analytics/cli-analytics/metrics',
CLI_ANALYTICS_LOGS: '/v1/analytics/cli-analytics/logs',
CLI_ANALYTICS_TRACES: '/v1/analytics/cli-analytics/traces',
```

- [ ] **Step 2:** Commit: `feat(proxy): add cli-analytics endpoint constants`

---

### Task 2: Thread credentials/baseUrl into OtlpIngestInterceptor

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:23-30` (`OtlpIngestPlugin.createInterceptor`, `OtlpIngestInterceptor` class)

**Interfaces:**
- Consumes: `PluginContext.syncCredentials`/`.credentials` (`SSOCredentials | JWTCredentials | undefined`), `PluginContext.config.syncApiUrl` (`string | undefined`) - shapes per `sso.session-sync.plugin.ts:37-38`.
- Produces: `OtlpIngestInterceptor` private fields `credentials?: SSOCredentials | JWTCredentials`, `baseUrl?: string` - consumed by Task 3's `pushToBackend`.

Test-first: no - PoC scope, no tests requested.

- [ ] **Step 1:** Change `createInterceptor(_context: PluginContext)` to `createInterceptor(context: PluginContext)`, and construct the interceptor with credentials/baseUrl (no `ConfigurationError`, no validation - always construct):

```ts
createInterceptor(context: PluginContext): ProxyInterceptor {
  return new OtlpIngestInterceptor(
    context.syncCredentials || context.credentials,
    context.config.syncApiUrl
  );
}
```

- [ ] **Step 2:** Add a constructor to `OtlpIngestInterceptor` storing both as private readonly fields, and import `SSOCredentials`, `JWTCredentials` from `../../../../core/types.js`:

```ts
constructor(
  private readonly credentials?: SSOCredentials | JWTCredentials,
  private readonly baseUrl?: string
) {}
```

- [ ] **Step 3:** Commit: `feat(proxy): thread credentials and baseUrl into OtlpIngestInterceptor`

---

### Task 3: Transform payload and push to backend

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts` (add two private methods; add one call site inside `handleRequest` between the existing append at lines 109-120 and the 202 response at lines 122-126)

**Interfaces:**
- Consumes: `OtlpEventPayload` (module-scope interface, lines 11-15), `this.credentials`/`this.baseUrl` from Task 2, `CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS` from Task 1, `buildAuthHeaders` from `../../../../core/codemie-auth-helpers.js`, `isSSOCredentials`/`isJWTCredentials` from `../../../../core/types.js`.
- Produces: `transformToEventHookRecord(payload): Record<string, unknown>`, `pushToBackend(record): Promise<void>` - private, not consumed outside this file.

Test-first: no - PoC scope, no tests requested.

- [ ] **Step 1:** Add imports: `CODEMIE_ENDPOINTS` from `../../../sso.http-client.js`, `buildAuthHeaders` from `../../../../core/codemie-auth-helpers.js`, `isSSOCredentials`/`isJWTCredentials` from `../../../../core/types.js` (alongside the Task 2 type imports).

- [ ] **Step 2:** Add `transformToEventHookRecord` - deliberate no-op passthrough, no business-field mapping:

```ts
// Deliberate no-op passthrough pending real Cursor-event -> backend-field mapping.
private transformToEventHookRecord(payload: OtlpEventPayload): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload.raw) as Record<string, unknown>;
  } catch {
    parsed = { raw: payload.raw };
  }
  return { ...parsed, agent_type: payload.agentName };
}
```

- [ ] **Step 3:** Add `pushToBackend`, mirroring `forwardOtlpEvent`'s fire-and-forget shape (`src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts:19-64`). Decision: branch explicitly on both `isSSOCredentials`/`isJWTCredentials` guards (no ternary-plus-cast) so both imported guards are exercised and the "unrecognized shape" case is handled the same way as missing credentials:

```ts
private async pushToBackend(record: Record<string, unknown>): Promise<void> {
  try {
    if (!this.credentials || !this.baseUrl) {
      logger.debug('[otlp-ingest] pushToBackend: no credentials/baseUrl, skipping');
      return;
    }

    let headers: Record<string, string>;
    if (isSSOCredentials(this.credentials)) {
      headers = buildAuthHeaders(this.credentials.cookies);
    } else if (isJWTCredentials(this.credentials)) {
      headers = buildAuthHeaders(this.credentials.token);
    } else {
      logger.debug('[otlp-ingest] pushToBackend: unrecognized credentials shape, skipping');
      return;
    }
    headers['Content-Type'] = 'application/x-ndjson';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`, {
        method: 'POST',
        headers,
        body: `${JSON.stringify(record)}\n`,
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.debug(`[otlp-ingest] pushToBackend: received status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[otlp-ingest] pushToBackend: ${msg}`);
  }
}
```

- [ ] **Step 4:** In `handleRequest`, immediately after the existing `appendFile` + debug-log block (ending ~line 120) and before `res.statusCode = 202` (line 122), add:

```ts
void this.pushToBackend(this.transformToEventHookRecord(payload));
```

- [ ] **Step 5:** Commit: `feat(proxy): forward cursor-ide hook events to cli-analytics backend`

---

### Task 4: Add metrics/logs/traces scaffolding stubs

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts` (add three private stub methods to `OtlpIngestInterceptor`, near `pushToBackend`)

**Interfaces:**
- Produces: `pushMetrics(data: unknown): Promise<void>`, `pushLogs(data: unknown): Promise<void>`, `pushTraces(data: unknown): Promise<void>` - not consumed anywhere in this change; left for a future colleague.

Test-first: no - PoC scope, no tests requested; these are unused stubs by design.

- [ ] **Step 1:** Add the three stubs below verbatim. Each carries a source comment marking the deferred forwarding work and returns immediately - this comment text is required shipped code content per the requirements, not an open planning decision (see Open Items):

```ts
// TODO(colleague): implement OTLP metrics forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS
private async pushMetrics(_data: unknown): Promise<void> {
  return;
}

// TODO(colleague): implement OTLP logs forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS
private async pushLogs(_data: unknown): Promise<void> {
  return;
}

// TODO(colleague): implement OTLP traces forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES
private async pushTraces(_data: unknown): Promise<void> {
  return;
}
```

- [ ] **Step 2:** Commit: `feat(proxy): scaffold metrics/logs/traces push stubs for cli-analytics`

---

## Open Items

- The `// TODO(colleague): ...` comments inside `pushMetrics`/`pushLogs`/`pushTraces` (Task 4, Step 1) are intentional literal source code mandated by the requirements ("each just a `// TODO(<colleague>): ...` comment"), not an unresolved plan decision - no further action needed before or during implementation.

---

## Self-Review

**Coverage:** Task 1 covers the endpoint constants; Task 2 covers context/constructor wiring; Task 3 covers the no-op transform, fire-and-forget push, and call-site wiring (the acceptance criterion re: ClickHouse visibility depends on this task's correctness plus manual backend verification, out of scope for automated checks here); Task 4 covers metrics/logs/traces scaffolding.

**Negative constraints:**
- No retry/backoff/queueing: satisfied by Task 3 Step 3 (single fetch attempt, no loop) and Task 4 (stubs do nothing).
- No `ConfigurationError`/unconditional registration: satisfied by Task 2 Step 1 - `createInterceptor` always constructs and returns an interceptor, no throw/guard.
- `pushToBackend` never throws past its own boundary: satisfied by Task 3 Step 3's outer try/catch, debug-only logging, no re-throw.
- `transformToEventHookRecord` stays a no-op: satisfied by Task 3 Step 2 - only spreads parsed JSON plus one structural field, no field-mapping logic.
- Stubs never wired: satisfied by Task 4 - not referenced from `handleRequest` or Task 3's code.
- Exactly two files, no tests: satisfied - only `sso.http-client.ts` (Task 1) and `otlp-ingest.plugin.ts` (Tasks 2-4) are touched; no test files created.

**Placeholder scan:** the only remaining `TODO` strings are the literal shipped-code comments in Task 4, Step 1, which are required content per the requirements and are called out explicitly in Open Items above - no other TBD/placeholder text remains in the plan.

**Type consistency:** `credentials`/`baseUrl` fields (Task 2) match the parameter names used in Task 3's `pushToBackend`; `CODEMIE_ENDPOINTS.CLI_ANALYTICS_*` keys (Task 1) match the references in Tasks 3-4's TODOs and fetch call.
