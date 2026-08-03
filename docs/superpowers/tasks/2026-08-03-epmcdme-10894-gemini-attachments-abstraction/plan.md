# Gemini Attachments Abstraction Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the direct `claudeUploadsDetector.ts` import in `chat/index.ts` with an agent-aware `UploadsDetector` interface + factory so `codemie-gemini` sessions return `[]` from auto-detection instead of running Claude's JSONL scanner against a Gemini session file.

**Architecture:** Extract `DetectedFile` and `UploadsDetector` interfaces to `chat/types.ts`; move `readFilesFromPaths` and its disk-read helpers to `chat/uploadsUtils.ts`; wrap the existing `detectFileUploadsFromSession` function in a `ClaudeUploadsDetector` class; add `GeminiUploadsDetector` (returns `[]`); a factory reads `session.agentName` via `new SessionStore().loadSession()` to select the right implementation.

**Tech Stack:** TypeScript (ES modules, `.js` extensions), Vitest (`vi.mock`, `vi.mocked`, `vi.clearAllMocks`, class-constructor mocking), Node.js `fs`, `path`, `mime-types`, `chalk`.

## Global Constraints

- All imports use `.js` extension (ES modules).
- `@/` alias resolves to `src/`.
- Conventional Commits; scope must be one of: `cli, agents, providers, assistants, config, proxy, workflows, ci, analytics, utils, deps, tests, skills, kimi`.
- Commit with `CODEMIE_SKIP_SECRETS_SCAN=1` (no Docker engine on this machine).
- `npm run typecheck && npm run lint` must pass after every task.
- Unit tests: `npm run test -- --project unit`.
- All existing `claudeUploadsDetector.test.ts` cases must pass throughout without modification to test logic.

---

### Task 1: Extract shared types and utilities

**Test-first: no** — this task relocates already-tested code. Correctness is verified by running the existing `claudeUploadsDetector.test.ts` suite after the move.

**Files:**
- Modify: `src/cli/commands/assistants/chat/types.ts`
- Create: `src/cli/commands/assistants/chat/uploadsUtils.ts`
- Modify: `src/cli/commands/assistants/chat/claudeUploadsDetector.ts`
- Modify: `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts`

**Interfaces:**
- Produces:
  - `DetectedFile` interface exported from `types.ts`
  - `UploadsDetector` interface exported from `types.ts`
  - `ATTACHMENT_CONSTRAINTS` constant exported from `uploadsUtils.ts`
  - `readFilesFromPaths(filePaths: string[], options?: { quiet?: boolean }): Promise<DetectedFile[]>` exported from `uploadsUtils.ts`
  - `bytesToMB(bytes: number): string` exported from `uploadsUtils.ts`
- `claudeUploadsDetector.ts` still exports `detectFileUploadsFromSession` (used by the class wrapper in Task 2)

---

- [ ] **Step 1: Add interfaces to `types.ts`**

  Open `src/cli/commands/assistants/chat/types.ts`. Append after the existing `MessageSendRequest` interface:

  ```typescript
  export interface DetectedFile {
    fileName: string;
    data: string;
    mediaType: string;
    type: 'image' | 'document';
    sizeBytes: number;
  }

  export interface UploadsDetector {
    detectFromSession(
      conversationId: string,
      options?: { quiet?: boolean }
    ): Promise<DetectedFile[]>;
  }
  ```

- [ ] **Step 2: Create `uploadsUtils.ts`**

  Create `src/cli/commands/assistants/chat/uploadsUtils.ts` with the following content. The bodies of `bytesToMB`, `detectMimeType`, `detectFileType`, and `readFilesFromPaths` are moved **verbatim** from `claudeUploadsDetector.ts` (lines 61–63, 272–275, 280–282, 287–388). Update `DetectedFile` to import from `./types.js` and replace `LOG_PREFIX` references inside those functions with `'[uploadsUtils]'`.

  ```typescript
  import { existsSync, readFileSync, statSync } from 'fs';
  import { basename, resolve } from 'path';
  import chalk from 'chalk';
  import mime from 'mime-types';
  import { logger } from '@/utils/logger.js';
  import type { DetectedFile } from './types.js';

  export const ATTACHMENT_CONSTRAINTS = {
    MAX_FILE_SIZE_MB: 100,
    RECENT_MESSAGES_LIMIT: 2,
    SUPPORTED_TYPES: ['image', 'document'] as const,
    MULTI_FILE: true,
  } as const;

  const LOG_PREFIX = '[uploadsUtils]';
  const MAX_FILE_SIZE_BYTES = ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB * 1024 * 1024;
  const BYTES_PER_KB = 1024;
  const BYTES_PER_MB = 1024 * 1024;

  export function bytesToMB(bytes: number): string {
    return (bytes / BYTES_PER_MB).toFixed(2);
  }

  function detectMimeType(filePath: string): string {
    const mimeType = mime.lookup(filePath);
    return mimeType || 'application/octet-stream';
  }

  function detectFileType(mimeType: string): 'image' | 'document' {
    return mimeType.startsWith('image/') ? 'image' : 'document';
  }

  export async function readFilesFromPaths(
    filePaths: string[],
    options: { quiet?: boolean } = {}
  ): Promise<DetectedFile[]> {
    const { quiet = false } = options;
    const detectedFiles: DetectedFile[] = [];

    if (filePaths.length === 0) {
      return [];
    }

    logger.debug(`${LOG_PREFIX} Reading files from paths`, {
      fileCount: filePaths.length,
      paths: filePaths
    });

    for (const filePath of filePaths) {
      try {
        const absolutePath = resolve(filePath);

        if (!existsSync(absolutePath)) {
          logger.warn(`${LOG_PREFIX} File does not exist`, { filePath: absolutePath });
          if (!quiet) {
            console.log(chalk.yellow(`⚠ File not found: ${filePath}`));
          }
          continue;
        }

        const stats = statSync(absolutePath);
        if (!stats.isFile()) {
          logger.warn(`${LOG_PREFIX} Path is not a file`, { filePath: absolutePath });
          if (!quiet) {
            console.log(chalk.yellow(`⚠ Not a file: ${filePath}`));
          }
          continue;
        }

        const fileSize = stats.size;
        if (fileSize > MAX_FILE_SIZE_BYTES) {
          logger.warn(`${LOG_PREFIX} File exceeds size limit`, {
            filePath: absolutePath,
            sizeMB: bytesToMB(fileSize),
            limit: ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB
          });
          if (!quiet) {
            console.log(chalk.yellow(`⚠ File too large (>${ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB}MB): ${filePath}`));
          }
          continue;
        }

        const fileBuffer = readFileSync(absolutePath);
        const base64Data = fileBuffer.toString('base64');
        const fileName = basename(absolutePath);
        const mimeType = detectMimeType(absolutePath);
        const fileType = detectFileType(mimeType);

        const detectedFile: DetectedFile = {
          fileName,
          data: base64Data,
          mediaType: mimeType,
          type: fileType,
          sizeBytes: fileSize
        };

        detectedFiles.push(detectedFile);

        logger.debug(`${LOG_PREFIX} Read file from disk`, {
          fileName,
          mediaType: mimeType,
          type: fileType,
          sizeMB: bytesToMB(fileSize)
        });

      } catch (error) {
        logger.warn(`${LOG_PREFIX} Failed to read file`, { filePath, error });
        if (!quiet) {
          console.log(chalk.yellow(`⚠ Failed to read file: ${filePath}`));
        }
      }
    }

    if (!quiet && detectedFiles.length > 0) {
      console.log(chalk.cyan(`\n📎 Loaded ${detectedFiles.length} file(s) from disk:`));
      detectedFiles.forEach((file, index) => {
        const sizeKB = Math.round(file.sizeBytes / BYTES_PER_KB);
        console.log(chalk.dim(`  ${index + 1}. ${file.fileName} (${file.mediaType}, ${sizeKB} KB)`));
      });
      console.log('');
    }

    logger.debug(`${LOG_PREFIX} Files read from disk`, {
      requestedCount: filePaths.length,
      successCount: detectedFiles.length
    });

    return detectedFiles;
  }
  ```

- [ ] **Step 3: Update `claudeUploadsDetector.ts`**

  Apply these four changes to `src/cli/commands/assistants/chat/claudeUploadsDetector.ts`:

  1. Add imports at the top (after the existing imports block):
     ```typescript
     import type { DetectedFile } from './types.js';
     import { bytesToMB, ATTACHMENT_CONSTRAINTS } from './uploadsUtils.js';
     ```

  2. Remove the `export interface DetectedFile { ... }` block (lines 43–49).

  3. Remove the `readFilesFromPaths` function body entirely (lines 287–388). Keep its export name in the deleted range — no re-export needed (callers will import from `uploadsUtils.js` after Task 5).

  4. Remove `bytesToMB` function (lines 61–63), `detectMimeType` (lines 272–275), `detectFileType` (lines 280–282), and the constants `MAX_FILE_SIZE_MB`, `MAX_FILE_SIZE_BYTES`, `BYTES_PER_KB`, `BYTES_PER_MB` (lines 20–23).

  5. In `processFileItem` (which uses `bytesToMB` and `MAX_FILE_SIZE_BYTES`): these now come from the new imports. Replace `MAX_FILE_SIZE_BYTES` with `ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB * 1024 * 1024` or introduce a local constant at the top of the file:
     ```typescript
     const MAX_FILE_SIZE_BYTES = ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB * 1024 * 1024;
     ```
     Replace the `MAX_FILE_SIZE_MB` reference in the `logger.warn` call inside `processFileItem` with `ATTACHMENT_CONSTRAINTS.MAX_FILE_SIZE_MB`.

  6. Keep `RECENT_MESSAGES_LIMIT` as a local constant — it is used only by `getRecentUserMessages` which stays in this file. No need to import from `ATTACHMENT_CONSTRAINTS`.

  7. Keep `detectFileUploadsFromSession` export unchanged.

  After edits, the file should import `DetectedFile` from `./types.js` and `bytesToMB`, `ATTACHMENT_CONSTRAINTS` from `./uploadsUtils.js`.

- [ ] **Step 4: Update import paths in `claudeUploadsDetector.test.ts`**

  Open `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts` line 6:

  Change:
  ```typescript
  import { detectFileUploadsFromSession, readFilesFromPaths } from '../claudeUploadsDetector.js';
  ```
  To:
  ```typescript
  import { detectFileUploadsFromSession } from '../claudeUploadsDetector.js';
  import { readFilesFromPaths } from '../uploadsUtils.js';
  ```

  Also add a mock for `mime-types` if the existing file does not already mock it (check whether `mime` is used in `uploadsUtils.ts` test coverage — `readFilesFromPaths` tests likely already mock `mime`). The existing `vi.mock('fs', ...)` block covers both modules, so no structural test logic changes are needed.

- [ ] **Step 5: Run existing tests**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(claudeUploads|uploadsUtils|PASS|FAIL|Error)" | head -40
  ```

  Expected: all `claudeUploadsDetector` tests pass.

- [ ] **Step 6: Run typecheck and lint**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run typecheck && npm run lint
  ```

  Expected: zero errors, zero warnings.

- [ ] **Step 7: Commit**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && \
  git add src/cli/commands/assistants/chat/types.ts \
          src/cli/commands/assistants/chat/uploadsUtils.ts \
          src/cli/commands/assistants/chat/claudeUploadsDetector.ts \
          src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts
  CODEMIE_SKIP_SECRETS_SCAN=1 git commit -m "$(cat <<'EOF'
  refactor(assistants): extract DetectedFile, UploadsDetector and shared upload utils (EPMCDME-10894)
  EOF
  )"
  ```

---

### Task 2: Add ClaudeUploadsDetector class

**Test-first: no** — the class is a thin wrapper over the already-tested `detectFileUploadsFromSession`. No new logic. Existing test suite confirms the class compiles and the underlying function still works.

**Files:**
- Modify: `src/cli/commands/assistants/chat/claudeUploadsDetector.ts`

**Interfaces:**
- Consumes: `UploadsDetector` from `./types.js`, `DetectedFile` from `./types.js`
- Produces: `ClaudeUploadsDetector` class exported from `claudeUploadsDetector.ts`

---

- [ ] **Step 1: Add `UploadsDetector` import to `claudeUploadsDetector.ts`**

  In the Task 1 import block you added, extend it:
  ```typescript
  import type { DetectedFile, UploadsDetector } from './types.js';
  ```

- [ ] **Step 2: Add class at the bottom of `claudeUploadsDetector.ts`**

  Append after the `detectFileUploadsFromSession` function:

  ```typescript
  export class ClaudeUploadsDetector implements UploadsDetector {
    async detectFromSession(
      conversationId: string,
      options?: { quiet?: boolean }
    ): Promise<DetectedFile[]> {
      return detectFileUploadsFromSession(conversationId, options);
    }
  }
  ```

- [ ] **Step 3: Run existing tests**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(claudeUploads|PASS|FAIL|Error)" | head -30
  ```

  Expected: all tests pass.

- [ ] **Step 4: Run typecheck and lint**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run typecheck && npm run lint
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && \
  git add src/cli/commands/assistants/chat/claudeUploadsDetector.ts
  CODEMIE_SKIP_SECRETS_SCAN=1 git commit -m "$(cat <<'EOF'
  refactor(assistants): add ClaudeUploadsDetector class wrapper (EPMCDME-10894)
  EOF
  )"
  ```

---

### Task 3: Add GeminiUploadsDetector + tests

**Test-first: yes** — write the test file first, confirm it fails, then implement the class.

**Files:**
- Create: `src/cli/commands/assistants/chat/geminiUploadsDetector.ts`
- Create: `src/cli/commands/assistants/chat/__tests__/geminiUploadsDetector.test.ts`

**Interfaces:**
- Consumes: `UploadsDetector`, `DetectedFile` from `./types.js`
- Produces: `GeminiUploadsDetector` class exported from `geminiUploadsDetector.ts`

---

- [ ] **Step 1: Write the failing test**

  Create `src/cli/commands/assistants/chat/__tests__/geminiUploadsDetector.test.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { GeminiUploadsDetector } from '../geminiUploadsDetector.js';
  import type { UploadsDetector } from '../types.js';

  describe('GeminiUploadsDetector', () => {
    it('returns empty array from detectFromSession', async () => {
      const detector = new GeminiUploadsDetector();
      const result = await detector.detectFromSession('session-abc');
      expect(result).toEqual([]);
    });

    it('returns empty array when quiet option is set', async () => {
      const detector = new GeminiUploadsDetector();
      const result = await detector.detectFromSession('session-abc', { quiet: true });
      expect(result).toEqual([]);
    });

    it('satisfies the UploadsDetector interface', () => {
      const detector: UploadsDetector = new GeminiUploadsDetector();
      expect(typeof detector.detectFromSession).toBe('function');
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(geminiUploads|Cannot find|FAIL|Error)" | head -20
  ```

  Expected: FAIL — `Cannot find module '../geminiUploadsDetector.js'`.

- [ ] **Step 3: Create `geminiUploadsDetector.ts`**

  Create `src/cli/commands/assistants/chat/geminiUploadsDetector.ts`:

  ```typescript
  import type { DetectedFile, UploadsDetector } from './types.js';

  export class GeminiUploadsDetector implements UploadsDetector {
    async detectFromSession(
      _conversationId: string,
      _options?: { quiet?: boolean }
    ): Promise<DetectedFile[]> {
      // Gemini session files contain plain-string message content with no embedded
      // base64 file blobs. Attachments reach the assistant exclusively via --file.
      return [];
    }
  }
  ```

- [ ] **Step 4: Run to confirm PASS**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(geminiUploads|PASS|FAIL|Error)" | head -20
  ```

  Expected: all 3 tests PASS.

- [ ] **Step 5: Run typecheck and lint**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run typecheck && npm run lint
  ```

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && \
  git add src/cli/commands/assistants/chat/geminiUploadsDetector.ts \
          src/cli/commands/assistants/chat/__tests__/geminiUploadsDetector.test.ts
  CODEMIE_SKIP_SECRETS_SCAN=1 git commit -m "$(cat <<'EOF'
  feat(assistants): add GeminiUploadsDetector (EPMCDME-10894)
  EOF
  )"
  ```

---

### Task 4: Add factory + factory tests

**Test-first: yes** — write factory tests first, run to fail, then implement.

**Important:** `loadSession` is an **instance method** on the `SessionStore` class, not a free function. The factory instantiates `new SessionStore()` and calls `.loadSession(conversationId)`. The test mocks the `SessionStore` constructor.

**Files:**
- Create: `src/cli/commands/assistants/chat/uploadsDetector.factory.ts`
- Create: `src/cli/commands/assistants/chat/__tests__/uploadsDetector.factory.test.ts`

**Interfaces:**
- Consumes: `ClaudeUploadsDetector` from `./claudeUploadsDetector.js`, `GeminiUploadsDetector` from `./geminiUploadsDetector.js`, `SessionStore` from `@/agents/core/session/SessionStore.js`
- Produces: `createUploadsDetector(conversationId?: string): Promise<UploadsDetector>` exported from `uploadsDetector.factory.ts`

---

- [ ] **Step 1: Write the failing factory test**

  Create `src/cli/commands/assistants/chat/__tests__/uploadsDetector.factory.test.ts`:

  ```typescript
  import { vi, describe, it, expect, beforeEach } from 'vitest';

  const mockLoadSession = vi.fn();

  vi.mock('@/agents/core/session/SessionStore.js', () => ({
    SessionStore: vi.fn().mockImplementation(() => ({
      loadSession: mockLoadSession
    }))
  }));

  import { createUploadsDetector } from '../uploadsDetector.factory.js';
  import { ClaudeUploadsDetector } from '../claudeUploadsDetector.js';
  import { GeminiUploadsDetector } from '../geminiUploadsDetector.js';

  describe('createUploadsDetector', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns GeminiUploadsDetector when session agentName is gemini', async () => {
      mockLoadSession.mockResolvedValue({ agentName: 'gemini' });
      const detector = await createUploadsDetector('session-123');
      expect(detector).toBeInstanceOf(GeminiUploadsDetector);
    });

    it('returns ClaudeUploadsDetector when session agentName is claude', async () => {
      mockLoadSession.mockResolvedValue({ agentName: 'claude' });
      const detector = await createUploadsDetector('session-123');
      expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
    });

    it('returns ClaudeUploadsDetector when conversationId is undefined', async () => {
      const detector = await createUploadsDetector(undefined);
      expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
      expect(mockLoadSession).not.toHaveBeenCalled();
    });

    it('returns ClaudeUploadsDetector when loadSession throws', async () => {
      mockLoadSession.mockRejectedValue(new Error('session not found'));
      const detector = await createUploadsDetector('session-404');
      expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
    });

    it('returns ClaudeUploadsDetector when loadSession returns null', async () => {
      mockLoadSession.mockResolvedValue(null);
      const detector = await createUploadsDetector('session-no-file');
      expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(uploadsDetector.factory|Cannot find|FAIL|Error)" | head -20
  ```

  Expected: FAIL — `Cannot find module '../uploadsDetector.factory.js'`.

- [ ] **Step 3: Create `uploadsDetector.factory.ts`**

  Create `src/cli/commands/assistants/chat/uploadsDetector.factory.ts`:

  ```typescript
  import { logger } from '@/utils/logger.js';
  import { SessionStore } from '@/agents/core/session/SessionStore.js';
  import { ClaudeUploadsDetector } from './claudeUploadsDetector.js';
  import { GeminiUploadsDetector } from './geminiUploadsDetector.js';
  import type { UploadsDetector } from './types.js';

  export async function createUploadsDetector(
    conversationId?: string
  ): Promise<UploadsDetector> {
    if (!conversationId) {
      return new ClaudeUploadsDetector();
    }

    try {
      const store = new SessionStore();
      const session = await store.loadSession(conversationId);
      if (session?.agentName === 'gemini') {
        logger.debug('[uploadsDetector.factory] Selecting GeminiUploadsDetector', { conversationId });
        return new GeminiUploadsDetector();
      }
    } catch {
      logger.debug('[uploadsDetector.factory] Session load failed, falling back to ClaudeUploadsDetector', { conversationId });
    }

    return new ClaudeUploadsDetector();
  }
  ```

- [ ] **Step 4: Run to confirm PASS**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit --reporter verbose 2>&1 | grep -E "(uploadsDetector.factory|PASS|FAIL|Error)" | head -20
  ```

  Expected: all 5 factory tests PASS.

- [ ] **Step 5: Run all unit tests for regressions**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 6: Run typecheck and lint**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run typecheck && npm run lint
  ```

- [ ] **Step 7: Commit**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && \
  git add src/cli/commands/assistants/chat/uploadsDetector.factory.ts \
          src/cli/commands/assistants/chat/__tests__/uploadsDetector.factory.test.ts
  CODEMIE_SKIP_SECRETS_SCAN=1 git commit -m "$(cat <<'EOF'
  feat(assistants): add UploadsDetector factory with session-based agent dispatch (EPMCDME-10894)
  EOF
  )"
  ```

---

### Task 5: Wire `chat/index.ts`

**Test-first: no** — `chat/index.ts` is the integration point. Existing index tests cover CLI flag registration; no new test cases are required for the wiring itself — factory dispatch is already covered by Task 4 tests.

**Files:**
- Modify: `src/cli/commands/assistants/chat/index.ts`

**Interfaces:**
- Consumes: `createUploadsDetector` from `./uploadsDetector.factory.js`, `readFilesFromPaths` from `./uploadsUtils.js`, `DetectedFile` from `./types.js`

---

- [ ] **Step 1: Update imports in `chat/index.ts`**

  Find line 24 (current content):
  ```typescript
  import { detectFileUploadsFromSession, readFilesFromPaths, type DetectedFile } from './claudeUploadsDetector.js';
  ```

  Replace with:
  ```typescript
  import type { DetectedFile } from './types.js';
  import { readFilesFromPaths } from './uploadsUtils.js';
  import { createUploadsDetector } from './uploadsDetector.factory.js';
  ```

- [ ] **Step 2: Update the detection block**

  Find (around lines 99–101 in the original; search for `detectFileUploadsFromSession` in the file):
  ```typescript
  if (conversationId) {
    detectedFiles = await detectFileUploadsFromSession(conversationId, { quiet: false });
  }
  ```

  Replace with:
  ```typescript
  if (conversationId) {
    const detector = await createUploadsDetector(conversationId);
    detectedFiles = await detector.detectFromSession(conversationId, { quiet: false });
  }
  ```

- [ ] **Step 3: Run all unit tests**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run test -- --project unit 2>&1 | tail -20
  ```

  Expected: all tests pass (claudeUploadsDetector, geminiUploadsDetector, uploadsDetector.factory, and any chat/index tests).

- [ ] **Step 4: Run typecheck and lint**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && npm run typecheck && npm run lint
  ```

  Expected: zero errors, zero warnings.

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/sergeynikitin/projects/codemie-dev/codemie-code && \
  git add src/cli/commands/assistants/chat/index.ts
  CODEMIE_SKIP_SECRETS_SCAN=1 git commit -m "$(cat <<'EOF'
  feat(assistants): wire UploadsDetector factory in chat command (EPMCDME-10894)
  EOF
  )"
  ```
