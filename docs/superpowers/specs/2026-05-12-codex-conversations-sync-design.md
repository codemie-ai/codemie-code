# Design: Codex Conversations Sync — EPMCDME-12128

**Date**: 2026-05-12
**Story**: [EPMCDME-12128](https://jiraeu.epam.com/browse/EPMCDME-12128)
**Status**: Approved

---

## Goal

Wire `SessionSyncer.sync()` into the Codex incremental sync timer so that both conversations **and metrics** are uploaded to CodeMie mid-session and at session end, using the same SSO credentials already in use for Codex metrics. `SessionSyncer` already serves as the unified upload layer — it orchestrates `MetricsSyncProcessor` and `createConversationSyncProcessor` in one call. The implementation mirrors the Claude/SSO-proxy pattern exactly: `SessionSyncer.sync()` is called with SSO credentials loaded from `CodeMieSSO.getStoredCredentials()`.

---

## Context: What already works

| Component | Status | Notes |
|---|---|---|
| `CodexConversationsProcessor` | ✅ Complete | Normalises rollout records; writes `PENDING` payloads to `_conversation.jsonl` |
| `createSyncProcessor` (SSO) | ✅ Complete | Reads `PENDING` from JSONL, calls `PUT /v1/conversations/{id}/history`, marks SUCCESS/FAILED |
| `SessionSyncer` | ✅ Complete | Orchestrates `MetricsSyncProcessor` + `createConversationSyncProcessor`; requires `correlation.status === 'matched'` |
| Session correlation at `SessionStart` | ✅ Complete | Hook sets `correlation.status = 'matched'` immediately; `SessionSyncer` guard passes |
| `SessionEnd` upload path | ✅ Complete | `onSessionEnd` → `adapter.processSession()` writes PENDING → `processEvent(SessionEnd)` → `syncPendingDataToAPI()` → `SessionSyncer.sync()` uploads |
| SSO proxy timer (Claude) | ✅ For Claude only | `SSOSessionSyncPlugin` calls `SessionSyncer.sync()` every 2 min — Codex does not run the proxy |

**The single gap**: the Codex 30-second incremental sync timer (`codex.incremental-sync.ts`) calls `adapter.processSession()` which writes `PENDING` payloads, but never calls `SessionSyncer.sync()` to upload them. Upload only happens at `SessionEnd` today.

---

## Approach

Mirror the Claude/SSO-proxy pattern exactly:

1. On each 30-second tick, after `adapter.processSession()` writes `PENDING` payloads, load stored SSO credentials via `CodeMieSSO.getStoredCredentials(ssoUrl)` and call `new SessionSyncer().sync(sessionId, uploadContext)`.
2. Pass `ssoUrl`, `syncApiUrl`, and `cliVersion` from `env` into `startCodexIncrementalSync()` — the same env vars already available at `onSessionStart` call-site.

---

## Files changed

Only two files require changes. No new files.

### 1. `src/agents/plugins/codex/codex.incremental-sync.ts`

**`StartCodexIncrementalSyncOptions`** — add three optional fields:

```typescript
/** CodeMie SSO URL used to load stored credentials (e.g. env.CODEMIE_URL). */
ssoUrl?: string;
/** Sync API base URL for the upload context (env.CODEMIE_SYNC_API_URL ?? env.CODEMIE_BASE_URL). */
syncApiUrl?: string;
/** CLI version string forwarded to the upload context. */
cliVersion?: string;
```

**`tick()` function** — after the successful `adapter.processSession()` call, add:

```typescript
// Upload PENDING conversation payloads — same pattern as SSO proxy timer for Claude.
if (options.ssoUrl && options.syncApiUrl) {
  const uploadContext = await buildUploadContext(
    options.sessionId, options.ssoUrl, options.syncApiUrl, options.cliVersion
  );
  if (uploadContext) {
    const { SessionSyncer } = await import('../../../providers/plugins/sso/session/SessionSyncer.js');
    const syncer = new SessionSyncer();
    const syncResult = await syncer.sync(options.sessionId, uploadContext);
    logger.debug(`[codex-incremental-sync] upload ${syncResult.success ? 'ok' : 'partial'}: ${syncResult.message}`);
  }
}
```

Wrapped in try/catch; upload failure is **non-blocking** (logged, tick continues).

**New private helper** `buildUploadContext`:

```typescript
async function buildUploadContext(
  sessionId: string,
  ssoUrl: string,
  syncApiUrl: string,
  version = '0.0.0'
): Promise<ProcessingContext | null> {
  try {
    const { CodeMieSSO } = await import('../../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);
    if (!credentials?.cookies) {
      logger.debug('[codex-incremental-sync] No SSO credentials available, skipping upload');
      return null;
    }
    const cookies = Object.entries(credentials.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return {
      apiBaseUrl: syncApiUrl,
      cookies,
      clientType: 'codemie-codex',
      version,
      dryRun: false,
      sessionId,
    };
  } catch (error) {
    logger.debug('[codex-incremental-sync] Failed to build upload context:', error);
    return null;
  }
}
```

Credentials are loaded fresh on **every tick** — same as `buildProcessingContext` in `hook.ts` — so SSO cookie rotation mid-session is handled automatically.

### 2. `src/agents/plugins/codex/codex.plugin.ts`

In `onSessionStart`, extend the `startCodexIncrementalSync` call to pass the three new options:

```typescript
startCodexIncrementalSync({
  sessionId,
  startedAt,
  cwd: process.cwd(),
  metadata: CodexPluginMetadata,
  ssoUrl: env.CODEMIE_URL,                                        // NEW
  syncApiUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL,  // NEW
  cliVersion: env.CODEMIE_CLI_VERSION,                           // NEW
  buildContext: () => ({ ... }),  // unchanged
});
```

---

## Data flow (per 30-second tick)

`SessionSyncer.sync()` is the **unified upload layer** — it runs both processors in one call, providing metrics + conversations parity with the Claude/SSO-proxy path.

```
tick()
  ├── adapter.processSession()                 ← unchanged; writes to JSONL
  │     ├── CodexMetricsProcessor
  │     │     └── writes MetricDelta → _metrics.jsonl
  │     └── CodexConversationsProcessor
  │           └── writes PENDING → _conversation.jsonl
  └── buildUploadContext()                     ← NEW
        └── CodeMieSSO.getStoredCredentials(ssoUrl)
              └── SessionSyncer.sync(sessionId, uploadContext)   ← unified upload
                    ├── MetricsSyncProcessor
                    │     └── POST /v1/metrics → marks deltas synced
                    └── createConversationSyncProcessor()
                          └── PUT /v1/conversations/{id}/history
                                └── marks PENDING → SUCCESS (or FAILED + retry next tick)
```

---

## Data flow (session end — no change)

```
onSessionEnd()
  ├── stopCodexIncrementalSync()
  ├── adapter.processSession()          → writes any remaining PENDING
  └── processEvent(SessionEnd)
        └── syncPendingDataToAPI()
              └── buildProcessingContext()   → loads SSO credentials
                    └── SessionSyncer.sync() → uploads all remaining PENDING
```

---

## Error handling and idempotency

| Scenario | Behaviour |
|---|---|
| Upload fails (network / auth expiry) | Payloads remain `PENDING`; `syncAttempts` incremented; retried on next tick (AC4) |
| Upload partially succeeds | Successful payloads marked `SUCCESS`; failed payloads retried independently |
| Concurrent tick overlap | `createSyncProcessor`'s `isSyncing` guard prevents double-upload within one session |
| No SSO credentials stored | `buildUploadContext` returns `null`; tick continues without upload; no error |
| No PENDING payloads | `createSyncProcessor` returns early; no API call made (AC5) |
| Session not yet correlated | `SessionSyncer.sync()` returns early with non-success; logged at debug; no crash |
| Max retry exceeded (3 attempts) | Payload stays `FAILED`; not re-sent (idempotency preserved) |

Batching and size limits are enforced inside `createSyncProcessor`/`apiClient.upsertConversation` — same code path as Claude, so parity is automatic (AC7).

---

## Out of scope

- Changes to Claude, Gemini, or OpenCode agents
- UI/dashboard changes in the CodeMie platform
- Retroactive backfill of past sessions
- Changes to the Codex rollout JSONL format
- New authentication flows or credential storage

---

## Acceptance criteria mapping

| AC | Covered by |
|---|---|
| AC1 — PENDING payloads uploaded on timer tick | `tick()` → `SessionSyncer.sync()` (new upload step) |
| AC2 — remaining PENDING flushed at `SessionEnd` | Existing `onSessionEnd` path (no change) |
| AC3 — uses existing SSO credentials, no new login | `CodeMieSSO.getStoredCredentials(ssoUrl)` |
| AC4 — failed uploads retried, no re-send of successes | `createSyncProcessor` FAILED retry logic + `SUCCESS` guard |
| AC5 — no upload when no turns occurred | `createSyncProcessor` exits early if no PENDING payloads |
| AC6 — no minimum turn count | No turn-count gate in `CodexConversationsProcessor` or `createSyncProcessor` |
| AC7 — same batching/size limits as Claude | Shared `apiClient.upsertConversation` code path |
| AC8 — end-to-end extraction test | Covered by `codex.conversations-processor.test.ts` (existing + to be extended) |
