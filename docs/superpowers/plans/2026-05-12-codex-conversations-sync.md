# Codex Conversations Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `SessionSyncer.sync()` into the Codex 30-second incremental sync timer so that conversation (and metrics) payloads are uploaded to CodeMie mid-session using existing SSO credentials.

**Architecture:** Add three optional env-passthrough fields (`ssoUrl`, `syncApiUrl`, `cliVersion`) to `StartCodexIncrementalSyncOptions`. After each successful `processSession` call in `tick()`, load stored SSO credentials via a new `buildUploadContext()` helper and call `new SessionSyncer().sync()` — exactly mirroring the Claude `SSOSessionSyncPlugin` pattern. The call-site in `codex.plugin.ts` passes the three values from the existing `env` object.

**Tech Stack:** TypeScript 5.3+, Node.js 20+, Vitest 4+, dynamic `import()` for `SessionSyncer` and `CodeMieSSO` (same pattern used throughout the codebase)

---

## File Structure

- **Modify:** `src/agents/plugins/codex/codex.incremental-sync.ts`
  - Add `ssoUrl?`, `syncApiUrl?`, `cliVersion?` to `StartCodexIncrementalSyncOptions`
  - Add `buildUploadContext()` private helper
  - Add upload step inside `tick()` after `processSession` succeeds
  - Update stale comment in file-level JSDoc
- **Modify:** `src/agents/plugins/codex/codex.plugin.ts`
  - Pass `ssoUrl`, `syncApiUrl`, `cliVersion` in the `startCodexIncrementalSync` call inside `onSessionStart`
- **Modify:** `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts`
  - Add module-level `vi.mock` for `SessionSyncer` and `CodeMieSSO`
  - Add `mockSync` and `mockGetStoredCredentials` vi.fn() references
  - Add four new test cases covering the upload path

---

### Task 1: Add upload step to `codex.incremental-sync.ts` (TDD)

**Test-first: yes — sync is called when ssoUrl/syncApiUrl set and credentials present; skipped when options absent or credentials missing; tick continues when upload throws**

**Files:**
- Modify: `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts:1-19`
- Modify: `src/agents/plugins/codex/codex.incremental-sync.ts:25-36` (options interface)
- Modify: `src/agents/plugins/codex/codex.incremental-sync.ts:56-102` (tick function)
- Modify: `src/agents/plugins/codex/codex.incremental-sync.ts` (add helper after `stopCodexIncrementalSync`)

- [ ] **Step 1: Add mocks for SessionSyncer and CodeMieSSO at the top of the test file**

  Replace the existing mock block (lines 1–19) with the version below — it adds two new `vi.fn()` references and two new `vi.mock` calls. The rest of the file is unchanged.

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

  vi.mock('../../../../utils/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  }));

  const discoverSessions = vi.fn();
  const parseSessionFile = vi.fn();
  const processSession = vi.fn();

  class FakeCodexSessionAdapter {
    discoverSessions = discoverSessions;
    parseSessionFile = parseSessionFile;
    processSession = processSession;
  }

  vi.mock('../codex.session.js', () => ({
    CodexSessionAdapter: FakeCodexSessionAdapter,
  }));

  const mockSync = vi.fn();
  const mockGetStoredCredentials = vi.fn();

  vi.mock('../../../../providers/plugins/sso/session/SessionSyncer.js', () => ({
    SessionSyncer: class {
      sync = mockSync;
    },
  }));

  vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
    CodeMieSSO: class {
      getStoredCredentials = mockGetStoredCredentials;
    },
  }));
  ```

- [ ] **Step 2: Reset the two new mocks inside `beforeEach`**

  In the existing `beforeEach` block (after `processSession.mockReset()`), add:

  ```typescript
  mockSync.mockReset();
  mockGetStoredCredentials.mockReset();
  ```

- [ ] **Step 3: Add four failing test cases to the `describe` block**

  Add after the last existing `it(...)` block (after the `stopCodexIncrementalSync clears the timer` test):

  ```typescript
  it('calls SessionSyncer.sync() on tick when ssoUrl/syncApiUrl set and credentials available', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc123' } });
    mockSync.mockResolvedValue({ success: true, message: 'ok' });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
      cliVersion: '1.2.3',
    });

    await waitFor(() => mockSync.mock.calls.length >= 1);
    expect(mockGetStoredCredentials).toHaveBeenCalledWith('https://codemie.example.com');
    expect(mockSync).toHaveBeenCalledWith(
      currentSessionId,
      expect.objectContaining({
        apiBaseUrl: 'https://sync.example.com',
        cookies: 'session=abc123',
        clientType: 'codemie-codex',
        version: '1.2.3',
        dryRun: false,
        sessionId: currentSessionId,
      })
    );
  });

  it('skips upload when ssoUrl or syncApiUrl is not set', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    // No ssoUrl / syncApiUrl passed — matches current codex.plugin.ts call
    startCodexIncrementalSync(commonOptions());

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
  });

  it('skips upload when SSO credentials are not available', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue(null); // no credentials stored

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
    });

    await waitFor(() => processSession.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('continues the tick even if the upload throws', async () => {
    process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS = '50';
    discoverSessions.mockResolvedValue([
      { sessionId: 'codex-uuid', filePath: '/tmp/rollout.jsonl', createdAt: Date.now(), agentName: 'codex' },
    ]);
    parseSessionFile.mockResolvedValue({ metadata: { projectPath: process.cwd() } });
    processSession.mockResolvedValue({ success: true, processors: {}, totalRecords: 1, failedProcessors: [] });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
    mockSync.mockRejectedValue(new Error('network failure'));

    const { startCodexIncrementalSync } = await import('../codex.incremental-sync.js');
    startCodexIncrementalSync({
      ...commonOptions(),
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://sync.example.com',
    });

    // Timer should keep firing even after the first upload failure
    await waitFor(() => processSession.mock.calls.length >= 2);
    // No unhandled rejection — test passes if we get here
  });
  ```

- [ ] **Step 4: Run tests to confirm the four new cases FAIL**

  Run: `cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code && npx vitest run src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts 2>&1 | tail -30`

  Expected: 4 new tests FAIL (mocks exist but `codex.incremental-sync.ts` has no upload logic yet), existing 6 tests PASS.

- [ ] **Step 5: Add `ssoUrl?`, `syncApiUrl?`, `cliVersion?` to `StartCodexIncrementalSyncOptions` in `codex.incremental-sync.ts`**

  Replace the interface (lines 25–36):

  ```typescript
  export interface StartCodexIncrementalSyncOptions {
    /** CodeMie session id (file naming key). */
    sessionId: string;
    /** ms-since-epoch lower bound used to ignore stale rollouts. */
    startedAt: number;
    /** Working directory to match the rollout's projectPath against. */
    cwd: string;
    /** Codex agent metadata (passed straight to CodexSessionAdapter). */
    metadata: AgentMetadata;
    /** Builds a fresh ProcessingContext on each tick (cookies/version may rotate). */
    buildContext: () => ProcessingContext;
    /** CodeMie SSO URL used to load stored credentials (e.g. env.CODEMIE_URL). */
    ssoUrl?: string;
    /** Sync API base URL for the upload context (env.CODEMIE_SYNC_API_URL ?? env.CODEMIE_BASE_URL). */
    syncApiUrl?: string;
    /** CLI version string forwarded to the upload context. */
    cliVersion?: string;
  }
  ```

- [ ] **Step 6: Add the upload step inside `tick()` after `processSession` succeeds**

  Replace the inner try/catch block that calls `processSession` (lines 83–94) with:

  ```typescript
        try {
          const result = await adapter.processSession(
            descriptor.filePath,
            options.sessionId,
            options.buildContext()
          );
          logger.debug(
            `[codex-incremental-sync] tick ok session=${options.sessionId} records=${result.totalRecords}`
          );
        } catch (error) {
          logger.error('[codex-incremental-sync] processSession failed:', error);
        }

        if (options.ssoUrl && options.syncApiUrl) {
          try {
            const uploadContext = await buildUploadContext(
              options.sessionId,
              options.ssoUrl,
              options.syncApiUrl,
              options.cliVersion
            );
            if (uploadContext) {
              const { SessionSyncer } = await import('../../../providers/plugins/sso/session/SessionSyncer.js');
              const syncer = new SessionSyncer();
              const syncResult = await syncer.sync(options.sessionId, uploadContext);
              logger.debug(
                `[codex-incremental-sync] upload ${syncResult.success ? 'ok' : 'partial'}: ${syncResult.message}`
              );
            }
          } catch (error) {
            logger.error('[codex-incremental-sync] upload failed:', error);
          }
        }
  ```

- [ ] **Step 7: Add `buildUploadContext()` helper after `stopCodexIncrementalSync`**

  Add the following function after the closing brace of `stopCodexIncrementalSync` (after line 127) and before `safeRealpath`:

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

- [ ] **Step 8: Update the stale JSDoc comment in `codex.incremental-sync.ts`**

  Replace lines 14–16 (the stale "SSO proxy already runs" note):

  ```typescript
   * The incremental sync timer writes per-call_id metric deltas + new
   * conversation slices to JSONL on every tick, then uploads PENDING payloads
   * to the CodeMie API via SessionSyncer when SSO credentials are available.
  ```

- [ ] **Step 9: Run tests to confirm all ten cases PASS**

  Run: `cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code && npx vitest run src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts 2>&1 | tail -20`

  Expected: 10 tests PASS, 0 failures.

- [ ] **Step 10: Run TypeScript build to confirm no type errors**

  Run: `cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code && npm run build 2>&1 | tail -20`

  Expected: Build succeeds with no errors.

- [ ] **Step 11: Commit**

  ```bash
  cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/.worktrees/EPMCDME-12128
  git add src/agents/plugins/codex/codex.incremental-sync.ts \
          src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts
  git commit -m "feat(codex): add mid-session conversation upload to incremental sync timer

  Wire SessionSyncer.sync() into the 30-second tick so PENDING conversation
  payloads are uploaded to the CodeMie API using stored SSO credentials,
  mirroring the SSOSessionSyncPlugin pattern used by the Claude agent.
  "
  ```

---

### Task 2: Wire `ssoUrl`, `syncApiUrl`, `cliVersion` in `codex.plugin.ts`

**Test-first: no — this task only passes existing env vars to a function already tested in Task 1; TypeScript compile verification is the guard**

**Files:**
- Modify: `src/agents/plugins/codex/codex.plugin.ts:200-213`

- [ ] **Step 1: Extend the `startCodexIncrementalSync` call in `onSessionStart`**

  Replace lines 200–213 (the `startCodexIncrementalSync({...})` call) with:

  ```typescript
      startCodexIncrementalSync({
        sessionId,
        startedAt,
        cwd: process.cwd(),
        metadata: CodexPluginMetadata,
        ssoUrl: env.CODEMIE_URL,
        syncApiUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL,
        cliVersion: env.CODEMIE_CLI_VERSION,
        buildContext: () => ({
          sessionId,
          apiBaseUrl: env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: 'codemie-codex',
          version: env.CODEMIE_CLI_VERSION || '0.0.0',
          dryRun: false,
        }),
      });
  ```

- [ ] **Step 2: Run TypeScript build to confirm no type errors**

  Run: `cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code && npm run build 2>&1 | tail -20`

  Expected: Build succeeds with no errors.

- [ ] **Step 3: Run the full unit test suite to confirm no regressions**

  Run: `cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code && npm run test:unit 2>&1 | tail -30`

  Expected: All tests pass.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/.worktrees/EPMCDME-12128
  git add src/agents/plugins/codex/codex.plugin.ts
  git commit -m "feat(codex): pass SSO env vars to incremental sync timer

  Forward CODEMIE_URL, CODEMIE_SYNC_API_URL, and CODEMIE_CLI_VERSION from
  the session env into startCodexIncrementalSync so the timer can load
  stored SSO credentials and upload PENDING payloads mid-session.
  "
  ```
