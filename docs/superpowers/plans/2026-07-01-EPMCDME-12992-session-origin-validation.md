# Session Origin Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent CodeMie from ingesting Claude Code sessions that were not created through CodeMie, by adding dual-signal ownership detection (correlation index + transcript marker), labeling external sessions in analytics, and warning users who try to resume non-CodeMie sessions.

**Architecture:** (1) A new `session-origin-audit.ts` utility writes a `codemie_session_start` ownership marker into Claude transcripts at SessionStart and maintains an append-only audit log. (2) `native-loader.ts` checks each discovered transcript against a new `hasOwnershipMarker` dep, setting `provider: 'native-external'` on unowned sessions. (3) `AgentCLI.ts` validates `--resume <id>` ownership before spawning Claude and suppresses conversation sync via `CODEMIE_CONV_SYNC_DISABLED=1` for confirmed external resumes. (4) `syncProcessor.ts` respects that env flag.

**Tech Stack:** Node.js, TypeScript, `node:fs` (appendFileSync/mkdirSync), `node:readline` (y/N prompt), `node:crypto` (randomUUID), Vitest

---

### Task 1: Audit log + transcript marker utility

**Files:**
- Create: `src/agents/core/session/session-origin-audit.ts`
- Create: `src/agents/core/__tests__/session-origin-audit.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/agents/core/__tests__/session-origin-audit.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test by pointing the functions at a temp dir instead of ~/.codemie
// The functions accept optional override paths for testability.
import {
  appendAuditEvent,
  appendTranscriptMarker,
} from '../session/session-origin-audit.js';

const TMP = join(tmpdir(), `codemie-audit-test-${process.pid}`);
const auditFile = join(TMP, 'logs', 'session-origin-audit.jsonl');
const transcriptFile = join(TMP, 'transcript.jsonl');

beforeEach(() => {
  mkdirSync(join(TMP, 'logs'), { recursive: true });
  writeFileSync(transcriptFile, '{"type":"user","uuid":"abc"}\n');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('appendAuditEvent', () => {
  it('creates the file and appends a valid JSON line', () => {
    appendAuditEvent('resume_blocked', { claudeSessionId: 'ses-1' }, join(TMP, 'logs'));
    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe('resume_blocked');
    expect(parsed.data.claudeSessionId).toBe('ses-1');
    expect(typeof parsed.ts).toBe('string');
  });

  it('appends multiple events', () => {
    appendAuditEvent('resume_blocked', { claudeSessionId: 'a' }, join(TMP, 'logs'));
    appendAuditEvent('resume_external_confirmed', { claudeSessionId: 'b' }, join(TMP, 'logs'));
    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('is non-fatal when the directory does not exist', () => {
    expect(() =>
      appendAuditEvent('resume_blocked', {}, '/nonexistent/path/that/does/not/exist/logs')
    ).not.toThrow();
  });
});

describe('appendTranscriptMarker', () => {
  it('appends a codemie_session_start line to the transcript', () => {
    appendTranscriptMarker(transcriptFile, 'codemie-id-1', 'claude');
    const lines = readFileSync(transcriptFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const marker = JSON.parse(lines[1]);
    expect(marker.type).toBe('codemie_session_start');
    expect(marker.codemie_session_id).toBe('codemie-id-1');
    expect(marker.codemie_agent).toBe('claude');
    expect(typeof marker.uuid).toBe('string');
    expect(typeof marker.timestamp).toBe('string');
  });

  it('is non-fatal when the transcript file does not exist', () => {
    expect(() =>
      appendTranscriptMarker('/does/not/exist/session.jsonl', 'id', 'claude')
    ).not.toThrow();
  });

  it('is non-fatal when transcript path is empty string', () => {
    expect(() => appendTranscriptMarker('', 'id', 'claude')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:unit -- src/agents/core/__tests__/session-origin-audit.test.ts
```

Expected: FAIL — `session-origin-audit.js` not found.

- [ ] **Step 3: Implement `session-origin-audit.ts`**

```typescript
// src/agents/core/session/session-origin-audit.ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

const LOG_FILENAME = 'session-origin-audit.jsonl';

export type AuditEventName =
  | 'transcript_marker_written'
  | 'resume_blocked'
  | 'resume_external_confirmed';

export function appendAuditEvent(
  event: AuditEventName,
  data: Record<string, unknown>,
  logsDir?: string,
): void {
  try {
    const dir = logsDir ?? getCodemiePath('logs');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, data }) + '\n';
    appendFileSync(join(dir, LOG_FILENAME), line);
  } catch {
    // non-fatal — audit log write failure must never break a user session
  }
}

export function appendTranscriptMarker(
  transcriptPath: string,
  codemieSessionId: string,
  codemieAgent: string,
): void {
  if (!transcriptPath) return;
  try {
    const marker = JSON.stringify({
      type: 'codemie_session_start',
      uuid: randomUUID(),
      codemie_session_id: codemieSessionId,
      codemie_agent: codemieAgent,
      timestamp: new Date().toISOString(),
    }) + '\n';
    appendFileSync(transcriptPath, marker);
    logger.debug(`[session-origin] Marker written to transcript: ${transcriptPath}`);
  } catch (err) {
    logger.warn(`[session-origin] Failed to write transcript marker (non-fatal): ${err}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/session-origin-audit.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/session/session-origin-audit.ts src/agents/core/__tests__/session-origin-audit.test.ts
git commit -m "feat(security): add session-origin-audit utility for transcript marker and audit log"
```

---

### Task 2: Write ownership marker at SessionStart

**Files:**
- Modify: `src/cli/commands/hook.ts` — `createSessionRecord()`, lines 733–744

Test-first: no — `createSessionRecord` uses dynamic imports and real `SessionStore`; the utility functions being called are fully tested in Task 1.

- [ ] **Step 1: Locate the save call in `createSessionRecord`**

Open `src/cli/commands/hook.ts`. Find line 734: `await sessionStore.saveSession(session);`

- [ ] **Step 2: Import and call `appendTranscriptMarker` + `appendAuditEvent` after the save**

```typescript
// After line 734 (await sessionStore.saveSession(session);), BEFORE the logger.info call:

const { appendTranscriptMarker, appendAuditEvent } = await import(
  '../agents/core/session/session-origin-audit.js'
);

if (session.correlation.agentSessionFile) {
  appendTranscriptMarker(
    session.correlation.agentSessionFile,
    sessionId,
    agentName,
  );
  appendAuditEvent('transcript_marker_written', {
    codemieSessionId: sessionId,
    claudeSessionId: event.session_id,
    transcriptPath: session.correlation.agentSessionFile,
  });
}
```

- [ ] **Step 3: Also add the marker on re-entered sessions (compact flow)**

In the same function, the re-entry block at line 695 also calls `sessionStore.saveSession(existing)` and then `return`. Add the same marker call there:

```typescript
// After line 705 (await sessionStore.saveSession(existing);), before the logger.info:

const { appendTranscriptMarker: writeMarker, appendAuditEvent: writeAudit } = await import(
  '../agents/core/session/session-origin-audit.js'
);
if (event.transcript_path) {
  writeMarker(event.transcript_path, sessionId, agentName);
  writeAudit('transcript_marker_written', {
    codemieSessionId: sessionId,
    claudeSessionId: event.session_id,
    transcriptPath: event.transcript_path,
  });
}
return;
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors in `hook.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/hook.ts
git commit -m "feat(security): write codemie_session_start marker to Claude transcript at SessionStart"
```

---

### Task 3: Session ownership helper (extracted + testable)

**Files:**
- Create: `src/agents/core/session/session-ownership.ts`
- Create: `src/agents/core/__tests__/session-ownership.test.ts`

This small module holds the filesystem-level ownership lookup so it can be tested without instantiating `AgentCLI`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/agents/core/__tests__/session-ownership.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSessionsForClaudeId } from '../session/session-ownership.js';

const TMP = join(tmpdir(), `codemie-ownership-test-${process.pid}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeSession(id: string, claudeSessionId: string): void {
  writeFileSync(
    join(TMP, `${id}.json`),
    JSON.stringify({ correlation: { agentSessionId: claudeSessionId } }),
  );
}

describe('scanSessionsForClaudeId', () => {
  it('returns true when a session file has a matching agentSessionId', () => {
    writeSession('codemie-1', 'claude-abc-123');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(true);
  });

  it('returns false when no session matches', () => {
    writeSession('codemie-1', 'claude-other');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });

  it('returns false when sessions dir is empty', () => {
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });

  it('returns false when sessions dir does not exist', () => {
    expect(scanSessionsForClaudeId('id', '/nonexistent/path')).toBe(false);
  });

  it('skips malformed JSON files without throwing', () => {
    writeFileSync(join(TMP, 'bad.json'), 'not json{{{');
    writeSession('codemie-1', 'claude-abc-123');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(true);
  });

  it('skips _metrics.json files', () => {
    writeFileSync(join(TMP, 'session1_metrics.json'), JSON.stringify({ correlation: { agentSessionId: 'claude-abc-123' } }));
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:unit -- src/agents/core/__tests__/session-ownership.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `session-ownership.ts`**

```typescript
// src/agents/core/session/session-ownership.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

/**
 * Scan ~/.codemie/sessions/ for a record whose correlation.agentSessionId
 * matches the given Claude session ID. Returns true when found (CodeMie-owned).
 */
export function scanSessionsForClaudeId(
  claudeSessionId: string,
  sessionsDir?: string,
): boolean {
  const dir = sessionsDir ?? getCodemiePath('sessions');
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith('.json') && !f.includes('_metrics'),
    );
  } catch {
    return false;
  }
  for (const f of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        correlation?: { agentSessionId?: string };
      };
      if (record.correlation?.agentSessionId === claudeSessionId) {
        return true;
      }
    } catch {
      logger.debug(`[session-ownership] Skipping unreadable session file: ${f}`);
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/session-ownership.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/session/session-ownership.ts src/agents/core/__tests__/session-ownership.test.ts
git commit -m "feat(security): add scanSessionsForClaudeId ownership lookup helper"
```

---

### Task 4: Native loader — label external sessions

**Files:**
- Modify: `src/cli/commands/analytics/native-loader.ts`
- Modify: `src/cli/commands/analytics/__tests__/native-loader.test.ts`

- [ ] **Step 1: Write the failing tests — add `hasOwnershipMarker` to `NativeLoaderDeps` and test external labeling**

Add this block at the end of `src/cli/commands/analytics/__tests__/native-loader.test.ts`:

```typescript
describe('loadNativeSessions — external session labeling', () => {
  const baseDescriptor = {
    sessionId: 'ext-1',
    filePath: '/logs/ext-1.jsonl',
    createdAt: 1000,
    updatedAt: 2000,
    agentName: 'claude',
  };
  const parsedSession = {
    sessionId: 'ext-1',
    agentName: 'claude',
    metadata: {},
    messages: [
      { type: 'assistant', timestamp: '2026-06-08T10:00:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
    ],
    metrics: { tools: {} },
  } as never;

  function makeDeps(hasMarker: boolean): NativeLoaderDeps {
    return {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [{ agentName: 'claude', descriptor: baseDescriptor }],
      parse: async () => parsedSession,
      realPath: (p) => p,
      hasOwnershipMarker: () => hasMarker,
    };
  }

  it('sets provider native-external when marker absent', async () => {
    const results = await loadNativeSessions(undefined, makeDeps(false));
    expect(results).toHaveLength(1);
    expect(results[0].startEvent!.data.provider).toBe('native-external');
  });

  it('keeps provider native when marker present', async () => {
    const results = await loadNativeSessions(undefined, makeDeps(true));
    expect(results).toHaveLength(1);
    expect(results[0].startEvent!.data.provider).toBe('native');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:unit -- src/cli/commands/analytics/__tests__/native-loader.test.ts
```

Expected: FAIL — `NativeLoaderDeps` missing `hasOwnershipMarker`, `makeDeps` type error.

- [ ] **Step 3: Extend `NativeLoaderDeps` interface and `realNativeDeps`**

In `native-loader.ts`, add `hasOwnershipMarker` to the `NativeLoaderDeps` interface:

```typescript
export interface NativeLoaderDeps {
  trackedLogPaths(): Set<string>;
  discover(maxAgeDays: number): Promise<DiscoveredNative[]>;
  parse(agentName: string, filePath: string, sessionId: string): Promise<ParsedSession | null>;
  realPath(p: string): string;
  /** Returns true when the transcript at filePath contains a codemie_session_start marker. */
  hasOwnershipMarker(filePath: string): boolean;
}
```

Add the implementation to `realNativeDeps`:

```typescript
export const realNativeDeps: NativeLoaderDeps = {
  trackedLogPaths: readTrackedLogPaths,
  // ... (existing discover, parse, realPath unchanged)
  hasOwnershipMarker(filePath: string): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .slice(0, 10)
        .some((line) => {
          try {
            return (JSON.parse(line) as { type?: string }).type === 'codemie_session_start';
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    }
  },
};
```

- [ ] **Step 4: Use `hasOwnershipMarker` in `loadNativeSessions` to label external sessions**

In `loadNativeSessions`, replace the synthesis call at the end of the loop:

```typescript
// Replace:
out.push(synthesizeRawSession(agentName, descriptor, parsed));

// With:
const raw = synthesizeRawSession(agentName, descriptor, parsed);
if (!deps.hasOwnershipMarker(descriptor.filePath) && raw.startEvent) {
  raw.startEvent.data.provider = 'native-external';
}
out.push(raw);
```

- [ ] **Step 5: Run tests**

```bash
npm run test:unit -- src/cli/commands/analytics/__tests__/native-loader.test.ts
```

Expected: all tests PASS (existing tests pass because the default `realNativeDeps` hasOwnershipMarker returns false for non-existent paths, but the existing tests use injected deps without `hasOwnershipMarker` — those need to be updated to include the field).

Update the two existing `loadNativeSessions` test `deps` objects to include `hasOwnershipMarker: () => false` (they test tracking/dedup, not origin, so `false` is fine there):

```typescript
// In both existing loadNativeSessions describe blocks, add to the deps object:
hasOwnershipMarker: () => false,
```

- [ ] **Step 6: Run tests again to confirm all pass**

```bash
npm run test:unit -- src/cli/commands/analytics/__tests__/native-loader.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/native-loader.ts src/cli/commands/analytics/__tests__/native-loader.test.ts
git commit -m "feat(security): label external (non-CodeMie) native sessions with provider native-external"
```

---

### Task 5: Terminal formatter — highlight external sessions

**Files:**
- Modify: `src/cli/commands/analytics/formatter.ts` (line 162)

No separate unit test — the formatter outputs chalk-colored console output; visual rendering is verified by running `codemie analytics`.

- [ ] **Step 1: Open `formatter.ts` and locate the provider line**

Line 162:
```typescript
console.log(chalk.gray(`      Provider:  ${session.provider}`));
```

- [ ] **Step 2: Replace with external-aware rendering**

```typescript
const providerLabel =
  session.provider === 'native-external'
    ? chalk.yellow('native [external ⚠ not CodeMie-managed]')
    : session.provider;
console.log(chalk.gray(`      Provider:  `) + providerLabel);
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/analytics/formatter.ts
git commit -m "feat(security): highlight external sessions in analytics terminal output"
```

---

### Task 6: AgentCLI — resume ownership check and sync suppression

**Files:**
- Modify: `src/agents/core/AgentCLI.ts`

Test-first: yes — `scanSessionsForClaudeId` (from Task 3) is already tested. This task tests the env-var injection path via a focused unit test on the new `buildResumeEnvOverride` helper.

- [ ] **Step 1: Write the failing test for the env override helper**

```typescript
// src/agents/core/__tests__/AgentCLI-resume.test.ts
import { describe, it, expect } from 'vitest';
import { buildResumeEnvOverride } from '../AgentCLI.js';

describe('buildResumeEnvOverride', () => {
  it('returns CODEMIE_CONV_SYNC_DISABLED=1 for an external confirmed resume', () => {
    const env = buildResumeEnvOverride(true);
    expect(env).toEqual({ CODEMIE_CONV_SYNC_DISABLED: '1' });
  });

  it('returns empty object for a CodeMie-owned session', () => {
    const env = buildResumeEnvOverride(false);
    expect(env).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:unit -- src/agents/core/__tests__/AgentCLI-resume.test.ts
```

Expected: FAIL — `buildResumeEnvOverride` not exported from `AgentCLI.js`.

- [ ] **Step 3: Export `buildResumeEnvOverride` from `AgentCLI.ts`**

Add near the top of the class (or as a module-level export below the class):

```typescript
/** Pure helper — exported for unit testing. */
export function buildResumeEnvOverride(isExternal: boolean): Record<string, string> {
  return isExternal ? { CODEMIE_CONV_SYNC_DISABLED: '1' } : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/AgentCLI-resume.test.ts
```

Expected: both tests PASS.

- [ ] **Step 5: Add the resume validation flow to `handleRun`**

Add a new private method `promptExternalResume` to `AgentCLI`:

```typescript
private async promptExternalResume(sessionId: string): Promise<boolean> {
  if (!process.stdin.isTTY || process.env.CODEMIE_NO_PROMPTS === '1') {
    console.error(
      chalk.red(`\n✗ Session ${sessionId} was not created through CodeMie.\n`) +
      chalk.white(`Non-interactive mode: resume blocked. Use 'claude --resume ${sessionId}'.\n`)
    );
    return false;
  }

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.yellow(`\n⚠  Warning: Session ${sessionId} was not created through CodeMie.`));
  console.log(chalk.white('If you continue:'));
  console.log(chalk.white('  • Token usage and API metrics WILL be tracked via the CodeMie proxy.'));
  console.log(chalk.white('  • Conversation transcript will NOT be synced to your CodeMie account history.\n'));
  console.log(chalk.dim(`To resume without any CodeMie tracking, use: claude --resume ${sessionId}\n`));

  return new Promise<boolean>((resolve) => {
    rl.question(chalk.yellow('Continue with CodeMie? (y/N): '), (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
```

- [ ] **Step 6: Add ownership check in `handleRun` after `providerEnv` is built**

In `handleRun`, locate line 307 (`providerEnv.CODEMIE_PROFILE_CONFIG = JSON.stringify(config);`). Add immediately after it:

```typescript
// Resume ownership check — after providerEnv is built so we can extend it
if (options.resume) {
  const resumeId = options.resume as string;
  const { scanSessionsForClaudeId } = await import('./session/session-ownership.js');
  const isOwned = scanSessionsForClaudeId(resumeId);

  if (!isOwned) {
    const confirmed = await this.promptExternalResume(resumeId);
    const { appendAuditEvent } = await import('./session/session-origin-audit.js');

    if (!confirmed) {
      appendAuditEvent('resume_blocked', { claudeSessionId: resumeId });
      console.log(chalk.white(`\nUse 'claude --resume ${resumeId}' to resume without CodeMie tracking.\n`));
      process.exit(1);
    }

    // User confirmed — suppress conversation transcript sync only
    Object.assign(providerEnv, buildResumeEnvOverride(true));
    appendAuditEvent('resume_external_confirmed', { claudeSessionId: resumeId });
    logger.info(`[AgentCLI] External resume confirmed for session ${resumeId}; conversation sync suppressed`);
  }
}
```

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/agents/core/AgentCLI.ts src/agents/core/__tests__/AgentCLI-resume.test.ts
git commit -m "feat(security): validate resume session ownership in AgentCLI and suppress conv sync for external sessions"
```

---

### Task 7: ConversationSyncProcessor — respect CODEMIE_CONV_SYNC_DISABLED

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts`
- Create: `src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-guard.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('createSyncProcessor — CODEMIE_CONV_SYNC_DISABLED guard', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CODEMIE_CONV_SYNC_DISABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CODEMIE_CONV_SYNC_DISABLED;
    } else {
      process.env.CODEMIE_CONV_SYNC_DISABLED = originalEnv;
    }
  });

  it('returns early with a skipped message when CODEMIE_CONV_SYNC_DISABLED=1', async () => {
    process.env.CODEMIE_CONV_SYNC_DISABLED = '1';

    // We import dynamically so the env var is read at call time
    const { createSyncProcessor } = await import('../syncProcessor.js');
    const processor = createSyncProcessor();

    // Provide a minimal mock session + context — the processor must not reach
    // readJSONL or any API call when the guard fires
    const mockReadJSONL = vi.fn();
    vi.doMock('../../../utils/jsonl-reader.js', () => ({ readJSONL: mockReadJSONL }));

    const result = await processor.process(
      { sessionId: 'test-session' } as never,
      {} as never,
    );

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/disabled/i);
    expect(mockReadJSONL).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:unit -- src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-guard.test.ts
```

Expected: FAIL — processor has no CODEMIE_CONV_SYNC_DISABLED guard; either skips the guard or calls readJSONL.

- [ ] **Step 3: Add the guard at the top of `processConversations`**

In `syncProcessor.ts`, inside `processConversations`, add before the `isSyncing` check:

```typescript
async function processConversations(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
  if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') {
    logger.debug('[conv-sync] Conversation sync disabled for this session (CODEMIE_CONV_SYNC_DISABLED=1)');
    return { success: true, message: 'Conversation sync disabled for external session resume' };
  }

  if (isSyncing) {
    return { success: true, message: 'Sync in progress' };
  }
  // ... rest unchanged
```

- [ ] **Step 4: Run tests**

```bash
npm run test:unit -- src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-guard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-guard.test.ts
git commit -m "feat(security): skip conversation sync when CODEMIE_CONV_SYNC_DISABLED=1"
```

---

### Task 8: Full test pass + lint

**Files:** none (validation only)

- [ ] **Step 1: Run all unit tests**

```bash
npm run test:unit
```

Expected: all tests pass.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: zero errors, zero warnings.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Final commit if any lint auto-fixes were applied**

```bash
git add -p
git commit -m "chore: lint fixes from session origin validation"
```

---

## Self-Review

**Spec coverage:**
| Spec section | Task |
|---|---|
| Section 1 — Transcript marker at SessionStart | Tasks 1 + 2 |
| Section 2 — Analytics external label | Tasks 3 + 4 |
| Section 3 — Resume validation + sync suppression | Tasks 3 (ownership helper) + 6 (AgentCLI) + 7 (syncProcessor) |
| Section 4 — Audit logging | Task 1 (utility) + called in Tasks 2 + 6 |
| Acceptance criteria — no placeholder TODOs | Verified |

**Type consistency:**
- `appendTranscriptMarker` / `appendAuditEvent` — same names in Tasks 1, 2, 6 ✓
- `scanSessionsForClaudeId` — same name in Tasks 3, 6 ✓
- `buildResumeEnvOverride` — defined and used in Task 6 only ✓
- `CODEMIE_CONV_SYNC_DISABLED` — set in Task 6, checked in Task 7 ✓
- `provider: 'native-external'` — set in Task 4, rendered in Task 5 ✓

**Placeholder scan:** None found.
