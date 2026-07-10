# Normalize Git Origin URL in Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward `session.repository` (the normalized `owner/repo` git remote identifier) from `DesktopTelemetryRuntime` to `MetricsSender`, and add unit + integration tests validating the normalization logic and the primary repository-field path end-to-end.

**Architecture:** The normalization function (`detectGitRemoteRepo` in `src/utils/processes.ts`), the `Session.repository` field, and `MetricsSender.sendSessionStart/End` are all already implemented and correct. The only production gap is `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, which detects and stores `session.repository` but omits it from the inline session argument passed to `MetricsSender`. The fix is adding one conditional field to each of two inline object literals. Test work is the bulk of this task: `detectGitRemoteRepo` has zero unit tests; `DesktopTelemetryRuntime` has no tests; the integration test for `session.repository` as primary path is absent.

**Tech Stack:** TypeScript 5, Vitest, `vi.hoisted`, `vi.mock`, `vi.fn().mockResolvedValue`

## Global Constraints

- Node.js ≥ 20.0.0; npm is the package manager
- No new dependencies
- All imports use `.js` extension; `@/` alias maps to `src/`
- Shell commands are bash/Linux-compatible
- `npm run typecheck` and `npm run lint` must pass after all changes

---

### Task 1: Unit tests for `detectGitRemoteRepo`

Validates the existing normalization regex against every URL form mentioned in the acceptance criteria. The function already exists and works; these tests are the deliverable.

**Files:**
- Create: `src/utils/__tests__/processes-git.test.ts`

**Interfaces:**
- Consumes: `detectGitRemoteRepo(cwd: string): Promise<string | undefined>` from `@/utils/processes.js`

**Test-first: no — function already exists; tests are the deliverable**

- [ ] **Step 1: Write the test file**

Create `src/utils/__tests__/processes-git.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mockExecAsync is defined before vi.mock factory executes
const { mockExecAsync } = vi.hoisted(() => ({
  mockExecAsync: vi.fn()
}));

// Override node:child_process.exec with a mock that carries the promisify.custom symbol,
// so that `const execAsync = promisify(childProcessExec)` in processes.ts resolves to mockExecAsync.
vi.mock('node:child_process', () => {
  const exec = vi.fn();
  exec[Symbol.for('nodejs.util.promisify.custom')] = mockExecAsync;
  return { exec, spawn: vi.fn() };
});

// Import after mocks are in place so processes.ts picks up the mocked child_process.
import { detectGitRemoteRepo } from '../processes.js';

describe('detectGitRemoteRepo', () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
  });

  it('normalizes SSH URL (GitHub)', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'git@github.com:codemie-ai/codemie-code.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('codemie-ai/codemie-code');
  });

  it('normalizes SSH URL (self-hosted GitLab)', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'git@gitbud.epam.com:epm-cdme/codemie.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('epm-cdme/codemie');
  });

  it('normalizes HTTPS URL', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://github.com/codemie-ai/codemie-code.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('codemie-ai/codemie-code');
  });

  it('strips embedded credentials from HTTPS URL', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://ghp_secrettoken@github.com/org/repo.git\n', stderr: '' });
    const result = await detectGitRemoteRepo('/repo');
    expect(result).toBe('org/repo');
    expect(result).not.toContain('ghp_secrettoken');
  });

  it('normalizes URL without .git suffix', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://github.com/org/repo\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('org/repo');
  });

  it('returns undefined when git command fails (no remote)', async () => {
    mockExecAsync.mockRejectedValue(new Error('fatal: No such remote origin'));
    expect(await detectGitRemoteRepo('/repo')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npm run test -- --project unit --reporter=verbose src/utils/__tests__/processes-git.test.ts
```

Expected: all 6 tests PASS (the function already implements the correct behavior).

- [ ] **Step 3: Commit**

```bash
git add src/utils/__tests__/processes-git.test.ts
git commit -m "test(utils): add unit tests for detectGitRemoteRepo normalization

Covers SSH (GitHub + self-hosted), HTTPS, embedded-credential stripping,
no-.git suffix, and missing-remote fallback per EPMCDME-10897 AC."
```

---

### Task 2: Fix `DesktopTelemetryRuntime` to forward `session.repository`

TDD: write a failing test that verifies `MetricsSender.sendSessionStart` receives `repository`, confirm it fails, apply the two-line fix, confirm it passes.

**Files:**
- Create: `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts`
- Modify: `src/telemetry/runtime/DesktopTelemetryRuntime.ts` lines 259–270 and 288–295

**Interfaces:**
- Consumes:
  - `DesktopTelemetryRuntime` constructor: `new DesktopTelemetryRuntime(adapter: LocalTelemetryAdapter, config: DesktopTelemetryRuntimeConfig)`
  - `LocalTelemetryDiscoveredSession`: `{ externalSessionId, agentSessionId, transcriptPath, metadataPath, workingDirectory, createdAt, updatedAt, model? }`
  - `DesktopTelemetryRuntimeConfig`: `{ clientType, targetApiUrl, provider, version, syncApiUrl?, syncCodeMieUrl?, pollIntervalMs, inactivityTimeoutMs }`
- Produces: verified that `MetricsSender.sendSessionStart` is called with `repository: 'codemie-ai/codemie-code'` in its first argument

**Test-first: yes — write failing test before fixing the production code**

- [ ] **Step 1: Write the failing test**

Create `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock MetricsSender ---
const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('@/providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn().mockImplementation(() => ({
    sendSessionStart: mockSendSessionStart,
    sendSessionEnd: mockSendSessionEnd
  }))
}));

// --- mock SessionStore ---
const mockFindSessionByExternalId = vi.fn();
const mockSaveSession = vi.fn().mockResolvedValue(undefined);

vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn().mockImplementation(() => ({
    findSessionByExternalId: mockFindSessionByExternalId,
    saveSession: mockSaveSession,
    loadSession: vi.fn().mockResolvedValue(null)
  }))
}));

// --- mock SessionSyncer ---
vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue({ message: 'ok' })
  }))
}));

// --- mock CodeMieSSO (for getStoredCredentials → supplies cookies) ---
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn().mockImplementation(() => ({
    getStoredCredentials: vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } })
  }))
}));

// --- mock git detection ---
vi.mock('@/utils/processes.js', () => ({
  detectGitRemoteRepo: vi.fn().mockResolvedValue('codemie-ai/codemie-code'),
  detectGitBranch: vi.fn().mockResolvedValue('main')
}));

// --- mock checkpoints (no-op) ---
vi.mock('@/telemetry/runtime/checkpoints.js', () => ({
  setRuntimeCheckpoint: vi.fn()
}));

import { DesktopTelemetryRuntime } from '../DesktopTelemetryRuntime.js';
import type {
  LocalTelemetryAdapter,
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryDiscoveredSession
} from '../types.js';

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: 5000,
  inactivityTimeoutMs: 300000
};

const discovered: LocalTelemetryDiscoveredSession = {
  externalSessionId: 'ext-session-1',
  agentSessionId: 'agent-session-1',
  transcriptPath: '/tmp/transcript.jsonl',
  metadataPath: '/tmp/metadata.json',
  workingDirectory: '/Users/test/codemie-ai/codemie-code',
  createdAt: Date.now() - 1000,
  updatedAt: Date.now(),
  model: 'claude-sonnet-5'
};

describe('DesktopTelemetryRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSessionByExternalId.mockResolvedValue(null); // new session
  });

  it('forwards session.repository to MetricsSender.sendSessionStart', async () => {
    const mockAdapter: LocalTelemetryAdapter = {
      clientType: 'claude',
      discoverSessions: vi.fn().mockResolvedValue([discovered]),
      parseSession: vi.fn().mockResolvedValue({ records: [] }),
      processParsedSession: vi.fn().mockResolvedValue({ totalRecords: 0 })
    };

    const runtime = new DesktopTelemetryRuntime(mockAdapter, config);
    // Call ensureSession directly — it calls sendSessionStartMetric internally
    await (runtime as any).ensureSession(discovered);

    expect(mockSendSessionStart).toHaveBeenCalledOnce();
    const [sessionArg] = mockSendSessionStart.mock.calls[0];
    expect(sessionArg).toMatchObject({ repository: 'codemie-ai/codemie-code' });
  });
});
```

- [ ] **Step 2: Run the test to confirm it FAILS**

```bash
npm run test -- --project unit --reporter=verbose src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts
```

Expected: FAIL — `received: undefined` for `repository` (the current code omits it from the session argument).

- [ ] **Step 3: Apply the fix to `DesktopTelemetryRuntime.ts`**

In `src/telemetry/runtime/DesktopTelemetryRuntime.ts`, inside `sendSessionStartMetric` (lines 259–270), add `repository: session.repository`:

```typescript
    await sender.sendSessionStart(
      {
        sessionId: discovered.agentSessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        repository: session.repository,
        model: discovered.model
      },
      session.workingDirectory,
      { status: 'started', reason: 'desktop-proxy-detected' }
    );
```

In `sendSessionEndMetric` (lines 288–295), add `repository: session.repository`:

```typescript
    await sender.sendSessionEnd(
      {
        sessionId: session.correlation.agentSessionId || session.sessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        repository: session.repository
      },
      session.workingDirectory,
      { status: 'completed', reason: session.reason || 'desktop-session-complete' },
      Math.max(0, (session.endTime || Date.now()) - session.startTime),
      undefined,
      session.activeDurationMs
    );
```

- [ ] **Step 4: Run the test to confirm it PASSES**

```bash
npm run test -- --project unit --reporter=verbose src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full unit suite to check for regressions**

```bash
npm run test -- --project unit
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts \
        src/telemetry/runtime/DesktopTelemetryRuntime.ts
git commit -m "fix(telemetry): forward session.repository to MetricsSender in DesktopTelemetryRuntime

sendSessionStartMetric and sendSessionEndMetric were omitting session.repository
from the inline session object, so MetricsSender always fell back to the
filesystem-derived extractRepository() value. Add the field to both calls so
the git-remote-derived identifier is preferred when available.

Closes EPMCDME-10897"
```

---

### Task 3: Integration test — `session.repository` primary path in tool-usage metrics

Adds a test case to the existing integration suite to verify that when `session.repository` is pre-set (e.g., from a git remote), `aggregateDeltas` uses it directly instead of the filesystem fallback. The `metrics-aggregator` already implements this correctly; the test documents and guards the behavior.

**Files:**
- Modify: `tests/integration/metrics/metrics-post-processing.test.ts`

**Interfaces:**
- Consumes: `aggregateDeltas(deltas: MetricDelta[], session: MetricsSession, version: string, clientType: string): AggregatedMetric[]`
- The `session.repository` field is `?: string` on `Session`

**Test-first: no — existing `aggregateDeltas` already uses `session.repository ?? extractRepository(workingDirectory)`; this test documents it**

- [ ] **Step 1: Add the new test case**

In `tests/integration/metrics/metrics-post-processing.test.ts`, add a new `it` block inside the existing `describe('Metrics Post-Processing Integration')` block, after the last existing test:

```typescript
  it('uses session.repository (git-remote) over filesystem extractRepository fallback', () => {
    const sessionWithGitRemote: MetricsSession = {
      ...mockSession,
      // Override workingDirectory with a path whose last two segments would give a different value
      workingDirectory: '/Users/test/some-other-path',
      repository: 'codemie-ai/codemie-code'
    };

    const deltas: MetricDelta[] = [
      {
        recordId: 'record-git-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: { Read: 1 },
        toolStatus: { Read: { success: 1, failure: 0 } },
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, sessionWithGitRemote, '1.0.0', 'codemie-claude');

    expect(metrics).toHaveLength(1);
    // git-remote value must win over extractRepository('/Users/test/some-other-path') = 'test/some-other-path'
    expect(metrics[0].attributes.repository).toBe('codemie-ai/codemie-code');
  });
```

- [ ] **Step 2: Run the integration tests**

```bash
npm run test -- --project cli --reporter=verbose tests/integration/metrics/metrics-post-processing.test.ts
```

Expected: all tests PASS (the new case passes because `aggregateDeltas` already uses `session.repository` when set).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/metrics/metrics-post-processing.test.ts
git commit -m "test(metrics): verify session.repository primary path in aggregateDeltas

Adds integration test to confirm that a pre-set session.repository value
(from git remote detection) wins over the extractRepository filesystem
fallback in metrics aggregation. Guards against regressions.

Part of EPMCDME-10897."
```

---

## Self-Review

### Spec coverage

| AC item | Task |
|---|---|
| Metrics payload includes `repository` from git remote | Task 2 (fix + test) |
| `git@gitbud.epam.com:epm-cdme/codemie.git` → `epm-cdme/codemie` | Task 1, test 2 |
| `git@github.com:codemie-ai/codemie-code.git` → `codemie-ai/codemie-code` | Task 1, test 1 |
| Embedded credentials stripped | Task 1, test 4 |
| Missing remote → safe empty value, no failure | Task 1, test 6 |
| Unit/integration tests for SSH remotes | Tasks 1 + 3 |

All AC items covered.

### Placeholder scan

None found — all steps contain complete code.

### Type consistency

- `repository: session.repository` — `Session.repository` is `string | undefined`; `sendSessionStart` accepts `Pick<Session, '...' | 'repository'>` which allows `undefined`, and `MetricsSender` does `session.repository ?? extractRepository(workingDirectory)` — type-safe.
- `MetricsSession` in integration test is `Session` from `@/agents/core/session/types.js` — `repository` is `?: string` so the spread `{ ...mockSession, repository: 'codemie-ai/codemie-code' }` is valid.
