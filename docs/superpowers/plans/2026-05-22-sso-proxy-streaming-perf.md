# SSO Proxy Streaming Performance Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate per-chunk buffering and microtask overhead in the SSO proxy so Anthropic SSE token streams flow with constant memory and minimal latency.

**Architecture:** Two cooperating fixes in the streaming path. (A) `LoggingPlugin` stops accumulating chunks for streaming (`text/event-stream`) responses; instead it tracks stats + a bounded head/tail preview. (B) The proxy `streamResponse` skips the chunk-hook loop entirely when no interceptor implements `onResponseChunk`, and respects `downstream.write()` backpressure by pausing the upstream when the writable buffer is full.

**Tech Stack:** TypeScript 5.3+, Node.js `http`/`https` streams, plugin architecture in `src/providers/plugins/sso/proxy/`.

**Out of Scope (separate plans):** sanitizer/log-level cleanup, request-body parse coalescing across plugins, MCP DNS caching, HTTP/2 upgrade. These are tracked separately and not required for the primary token-latency fix.

---

## Files Touched

- **Modify:** `src/providers/plugins/sso/proxy/plugins/logging.plugin.ts` — strip per-chunk full-body buffering for SSE; bound head/tail preview; cap non-streaming JSON capture.
- **Modify:** `src/providers/plugins/sso/proxy/sso.proxy.ts` — skip chunk-hook loop when no plugin implements `onResponseChunk`; honor backpressure via `pause()` / `drain`.

No new files. No public API changes. No changes to `ProxyInterceptor` contract.

---

## Task 1 — Add streaming-aware state to the logging plugin

**File:** `src/providers/plugins/sso/proxy/plugins/logging.plugin.ts`

- [ ] **Step 1.1: Replace the interceptor's private state.**

Locate the four state fields at the top of `LoggingInterceptor` (around lines 39-43) and replace them with:

```ts
class LoggingInterceptor implements ProxyInterceptor {
  name = 'logging';
  private chunkCount = 0;
  private totalBytes = 0;
  private responseContentType: string | null = null;
  private isStreaming = false;

  // Bounded preview buffers — never the full body for SSE.
  private headPreview: Buffer[] = [];
  private tailPreview: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;

  // Non-streaming JSON capture, capped to NON_STREAM_MAX.
  private nonStreamingChunks: Buffer[] = [];
  private nonStreamingTruncated = false;

  private static readonly PREVIEW_LIMIT = 4096;       // 4 KB head + 4 KB tail
  private static readonly NON_STREAM_MAX = 64 * 1024; // 64 KB max for buffered JSON bodies
}
```

- [ ] **Step 1.2: Reset all the new fields in `onRequest`.**

Replace the existing reset block at the start of `onRequest` (currently lines 48-51) with:

```ts
this.chunkCount = 0;
this.totalBytes = 0;
this.responseContentType = null;
this.isStreaming = false;
this.headPreview = [];
this.tailPreview = [];
this.headBytes = 0;
this.tailBytes = 0;
this.nonStreamingChunks = [];
this.nonStreamingTruncated = false;
```

- [ ] **Step 1.3: Set `isStreaming` in `onResponseHeaders`.**

After the existing `this.responseContentType = ...` assignment in `onResponseHeaders`, insert:

```ts
const transferEncoding = headers['transfer-encoding'] || headers['Transfer-Encoding'];
const transferEncodingStr = Array.isArray(transferEncoding)
  ? transferEncoding[0]
  : transferEncoding;
this.isStreaming =
  (this.responseContentType?.includes('text/event-stream') ?? false) ||
  (((transferEncodingStr?.includes('chunked')) ?? false) &&
   !(this.responseContentType?.includes('application/json') ?? false));
```

- [ ] **Step 1.4: Build.**

```bash
npm run build
```

Expected: zero TypeScript errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/providers/plugins/sso/proxy/plugins/logging.plugin.ts
git commit -m "refactor(proxy): add streaming detection state to logging plugin"
```

---

## Task 2 — Replace `onResponseChunk` with bounded streaming capture

**File:** `src/providers/plugins/sso/proxy/plugins/logging.plugin.ts`

- [ ] **Step 2.1: Replace the entire `onResponseChunk` method (lines 128-157) with:**

```ts
async onResponseChunk(
  context: ProxyContext,
  chunk: Buffer
): Promise<Buffer | null> {
  try {
    this.chunkCount++;
    this.totalBytes += chunk.length;

    if (this.isStreaming) {
      // Streaming: only keep bounded head/tail previews, never full body.
      if (this.headBytes < LoggingInterceptor.PREVIEW_LIMIT) {
        const remaining = LoggingInterceptor.PREVIEW_LIMIT - this.headBytes;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        this.headPreview.push(Buffer.from(slice));
        this.headBytes += slice.length;
      }
      // Rolling tail buffer: retain only the last PREVIEW_LIMIT bytes.
      this.tailPreview.push(chunk);
      this.tailBytes += chunk.length;
      while (
        this.tailPreview.length > 1 &&
        this.tailBytes - (this.tailPreview[0]?.length ?? 0) >= LoggingInterceptor.PREVIEW_LIMIT
      ) {
        const dropped = this.tailPreview.shift();
        if (dropped) this.tailBytes -= dropped.length;
      }
    } else if (!this.nonStreamingTruncated) {
      // Non-streaming JSON: bounded buffer up to NON_STREAM_MAX.
      if (this.totalBytes <= LoggingInterceptor.NON_STREAM_MAX) {
        this.nonStreamingChunks.push(Buffer.from(chunk));
      } else {
        this.nonStreamingTruncated = true;
        this.nonStreamingChunks = []; // drop partial buffer; log size only.
      }
    }

    if (this.chunkCount === 1 || this.chunkCount % 1000 === 0) {
      logger.debug(`[proxy-streaming] ${context.url}`, {
        requestId: context.requestId,
        chunkNumber: this.chunkCount,
        chunkSize: chunk.length,
        totalBytes: this.totalBytes,
        streaming: this.isStreaming,
      });
    }
  } catch (error) {
    logger.error(`[${this.name}] Error logging chunk:`, error);
  }
  return chunk;
}
```

- [ ] **Step 2.2: Build.**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 2.3: Commit.**

```bash
git add src/providers/plugins/sso/proxy/plugins/logging.plugin.ts
git commit -m "perf(proxy): stop buffering full SSE body in logging plugin"
```

---

## Task 3 — Update `onResponseComplete` to consume bounded previews

**File:** `src/providers/plugins/sso/proxy/plugins/logging.plugin.ts`

- [ ] **Step 3.1: Replace the entire `onResponseComplete` method (lines 159-263) with:**

```ts
async onResponseComplete(
  context: ProxyContext,
  metadata: ResponseMetadata
): Promise<void> {
  try {
    const isSessionSyncEndpoint = this.isSessionSyncEndpoint(context.url);
    const contentType = this.responseContentType || 'unknown';
    const streaming = this.isStreaming;

    // Snapshot state, then clear immediately so next request starts fresh.
    const headBuf = Buffer.concat(this.headPreview);
    const tailBuf = Buffer.concat(this.tailPreview);
    const nonStreamingBuf = streaming || this.nonStreamingTruncated
      ? null
      : Buffer.concat(this.nonStreamingChunks);
    const truncated = this.nonStreamingTruncated;
    const totalBytes = this.totalBytes;
    const chunkCount = this.chunkCount;

    this.headPreview = [];
    this.tailPreview = [];
    this.headBytes = 0;
    this.tailBytes = 0;
    this.nonStreamingChunks = [];
    this.nonStreamingTruncated = false;
    this.chunkCount = 0;
    this.totalBytes = 0;
    this.responseContentType = null;
    this.isStreaming = false;

    // Defer heavy formatting work off the response hot path.
    setImmediate(() => {
      try {
        let responseBodyParsed: unknown = null;

        if (isSessionSyncEndpoint) {
          responseBodyParsed = '[omitted: session sync payload]';
        } else if (streaming) {
          responseBodyParsed = {
            type: contentType,
            mode: 'streaming-bounded',
            totalBytes,
            chunkCount,
            headPreview: headBuf.toString('utf-8'),
            tailPreview: tailBuf.toString('utf-8'),
          };
        } else if (truncated) {
          responseBodyParsed = `[truncated: body exceeded ${LoggingInterceptor.NON_STREAM_MAX} bytes; total ${totalBytes}]`;
        } else if (nonStreamingBuf && nonStreamingBuf.length > 0) {
          const fullBody = nonStreamingBuf.toString('utf-8');
          if (contentType.includes('application/json')) {
            try {
              responseBodyParsed = JSON.parse(fullBody);
            } catch {
              responseBodyParsed = fullBody;
            }
          } else {
            responseBodyParsed = fullBody.length > 1000
              ? fullBody.substring(0, 1000) + '... (truncated)'
              : fullBody;
          }
        }

        logger.debug(
          `[proxy-response] ${metadata.statusCode} ${context.url} (${metadata.durationMs}ms)`,
          {
            requestId: context.requestId,
            sessionId: context.sessionId,
            agent: context.agentName,
            profile: context.profile,
            provider: context.provider,
            model: context.model,
            statusCode: metadata.statusCode,
            statusMessage: metadata.statusMessage,
            contentType,
            isStreaming: streaming,
            bytesSent: metadata.bytesSent,
            durationMs: metadata.durationMs,
            totalChunks: chunkCount,
            totalBytesStreamed: totalBytes,
            responseBody: responseBodyParsed,
          }
        );
      } catch (error) {
        logger.error(`[${this.name}] Error logging response (deferred):`, error);
      }
    });
  } catch (error) {
    logger.error(`[${this.name}] Error logging response:`, error);
  }
}
```

- [ ] **Step 3.2: Build.**

```bash
npm run build
```

- [ ] **Step 3.3: Commit.**

```bash
git add src/providers/plugins/sso/proxy/plugins/logging.plugin.ts
git commit -m "perf(proxy): use bounded head/tail preview instead of full body for SSE logs"
```

---

## Task 4 — Skip the chunk-hook loop when no plugin needs it

**File:** `src/providers/plugins/sso/proxy/sso.proxy.ts`

- [ ] **Step 4.1: Cache active chunk interceptors at startup.**

In the `CodeMieProxy` class, add a private field next to `interceptors`:

```ts
private chunkInterceptors: ProxyInterceptor[] = [];
```

After the line that assigns `this.interceptors = await registry.initialize(pluginContext);` (around line 121), add:

```ts
this.chunkInterceptors = this.interceptors.filter(i => typeof i.onResponseChunk === 'function');
```

This is recomputed on each `start()` since `interceptors` is rebuilt.

- [ ] **Step 4.2: Build.**

```bash
npm run build
```

- [ ] **Step 4.3: Commit.**

```bash
git add src/providers/plugins/sso/proxy/sso.proxy.ts
git commit -m "refactor(proxy): cache list of chunk-hook interceptors"
```

---

## Task 5 — Replace the streaming loop with a backpressure-aware version

**File:** `src/providers/plugins/sso/proxy/sso.proxy.ts`

- [ ] **Step 5.1: Replace the body of `streamResponse` between the `// Stream with optional chunk hooks` comment and the `Explicitly destroy upstream` comment (currently lines 411-470).**

Replace with:

```ts
let bytesSent = 0;
let chunkCount = 0;
const chunkHooks = this.chunkInterceptors;
const hasChunkHooks = chunkHooks.length > 0;

logger.debug(`[proxy-stream] Starting chunk iteration for ${context.requestId} (chunkHooks: ${hasChunkHooks})`);

// Track upstream stream lifecycle
upstream.on('end', () => {
  logger.debug(`[proxy-stream] Upstream 'end' event fired for ${context.requestId}`);
});
upstream.on('close', () => {
  logger.debug(`[proxy-stream] Upstream 'close' event fired for ${context.requestId}`);
});

// Track downstream connection state
let downstreamClosed = false;
downstream.on('close', () => {
  logger.debug(`[proxy-stream] Downstream connection closed during streaming for ${context.requestId}`);
  downstreamClosed = true;
  if (!upstream.destroyed) upstream.destroy();
});
downstream.on('finish', () => {
  logger.debug(`[proxy-stream] Downstream finished event for ${context.requestId}`);
});
downstream.on('error', (error) => {
  logger.debug(`[proxy-stream] Downstream error for ${context.requestId}:`, error);
});

const writeWithBackpressure = (buf: Buffer): Promise<void> => {
  if (downstream.write(buf)) return Promise.resolve();
  return new Promise<void>(resolve => downstream.once('drain', () => resolve()));
};

if (!hasChunkHooks) {
  // Fast path: no plugin needs to inspect/transform chunks.
  // Forward chunks as-is without microtask hops or Buffer copies.
  for await (const chunk of upstream) {
    if (downstreamClosed) break;
    chunkCount++;
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesSent += buf.length;
    await writeWithBackpressure(buf);
  }
} else {
  // Slow path: at least one plugin declared onResponseChunk.
  for await (const chunk of upstream) {
    if (downstreamClosed) break;
    chunkCount++;
    let processedChunk: Buffer | null = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    for (const interceptor of chunkHooks) {
      if (!processedChunk) break;
      try {
        processedChunk = await interceptor.onResponseChunk!(context, processedChunk);
      } catch (error) {
        logger.error(`[CodeMieProxy] Chunk hook error in ${interceptor.name}:`, error);
      }
    }

    if (processedChunk) {
      bytesSent += processedChunk.length;
      await writeWithBackpressure(processedChunk);
    }
  }
}

logger.debug(`[proxy-stream] Finished chunk iteration for ${context.requestId}. Total chunks: ${chunkCount}, bytes: ${bytesSent}`);
```

- [ ] **Step 5.2: Build.**

```bash
npm run build
```

Expected: zero TypeScript errors. The `interceptor.onResponseChunk!` non-null assertion is safe because `chunkHooks` is filtered to only entries where this method exists.

- [ ] **Step 5.3: Lint.**

```bash
npm run lint
```

Expected: zero warnings.

- [ ] **Step 5.4: Manual smoke test.**

Run the CLI against a real SSO endpoint and observe a streaming Claude response:

```bash
npm link
# In another shell, with an SSO profile already logged in:
codemie claude  # or whatever entrypoint exercises the proxy
```

Send a prompt that produces a long response. Confirm:
- Tokens stream visibly (not all-at-once).
- Process RSS stays roughly constant during streaming (no growth proportional to response size).
- `~/.codemie/logs/debug-YYYY-MM-DD.log` contains a `[proxy-response]` entry with `mode: 'streaming-bounded'`, `headPreview`, `tailPreview`.

- [ ] **Step 5.5: Commit.**

```bash
git add src/providers/plugins/sso/proxy/sso.proxy.ts
git commit -m "perf(proxy): skip chunk hooks when unused and honor downstream backpressure"
```

---

## Task 6 — Verification

- [ ] **Step 6.1: Confirm no functional regressions in non-streaming paths.**

Trigger a non-streaming JSON response (e.g. a small `/v1/models` call through the proxy) and confirm the logging entry still includes the parsed JSON body up to 64 KB, or `[truncated: ...]` for larger bodies.

- [ ] **Step 6.2: Confirm chunk-hook plugins still work.**

If any agent profile registers a plugin that implements `onResponseChunk` (none ship today, but the contract is preserved), confirm the slow path still runs by temporarily wrapping `LoggingPlugin`'s no-op return into a logged transform and observing the log line.

- [ ] **Step 6.3: Re-run lint and build before merging.**

```bash
npm run lint
npm run build
```

Expected: all clean.

---

## Self-Review Notes

- **Spec coverage:** the plan only addresses the top-ranked bottleneck from the investigation (full-body buffering + per-chunk microtask + missing backpressure). Other items (sanitizer cost, JSON parse coalescing, MCP DNS, HTTP/2) are intentionally out of scope and tracked separately.
- **Placeholder scan:** every step shows actual code or actual commands.
- **Type consistency:** `chunkInterceptors` field name and type match between Tasks 4 and 5; `onResponseChunk` signature matches `ProxyInterceptor` in `plugins/types.ts`.
- **Behavior preservation:** chunk transform contract is preserved (slow path still calls each `onResponseChunk` in registered order). Only behavior change for non-streaming endpoints is a 64 KB cap on logged JSON, which only affects log output, not the response forwarded to the client.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-22-sso-proxy-streaming-perf.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two-stage review.
2. **Inline Execution** — execute the tasks in this session via `superpowers:executing-plans`.

Which approach?
