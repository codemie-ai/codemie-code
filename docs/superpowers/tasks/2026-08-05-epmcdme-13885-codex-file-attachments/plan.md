# Codex File Attachments Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend CodeMie assistant file attachment detection to support Codex rollout JSONL, achieving feature parity with the existing Claude session-based detection.

**Architecture:** A new `codexUploadsDetector.ts` discovers the active Codex rollout by scanning `~/.codex/sessions/**/*.jsonl` via `getCodexDiscoverySessionRoots()` + CWD realpath matching, then extracts `input_image`/`input_file` blocks from the user `response_item` record. `chat/index.ts` gains an `CODEMIE_AGENT`-aware dispatch branch. A shared `uploads-types.ts` holds the `DetectedFile` interface to avoid import coupling.

**Tech Stack:** TypeScript (ES modules), Vitest, Node.js `fs/promises`, `readJSONLTolerant`, existing `getCodexDiscoverySessionRoots()`, `isCodexInjectedUserText()`, `chalk`, `mime-types`.

## Global Constraints

- All imports use `.js` extension (ES modules).
- Use `@/` alias for imports crossing the `src/` boundary; relative imports within the same directory are fine.
- No `require()`, no `__dirname`; use `import.meta.url` if a dirname is needed.
- Error handling: `try/catch` with `logger.error` or `logger.debug`; detection functions return `[]` on failure, never throw.
- No `console.log` in library code except for the user-facing chalk output already established in `claudeUploadsDetector.ts` (`📎 Detected N file(s)…`).
- Tests are Vitest; mock with `vi.mock()` + dynamic imports after setup.
- Commit messages: Conventional Commits (`feat(assistants): …`).

---

## File Map

| Path | Action | Purpose |
|---|---|---|
| `src/cli/commands/assistants/chat/uploads-types.ts` | **Create** | Shared `DetectedFile` interface + `readFilesFromPaths` + shared constants |
| `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` | **Modify** | Re-export `DetectedFile`/`readFilesFromPaths` from `uploads-types.ts`; remove local definitions |
| `src/agents/plugins/codex/codex-message-types.ts` | **Modify** | Add `CodexResponseItemMessage`, `CodexContentBlock`, extend `CodexEventMsg` with `images`/`local_images` |
| `src/cli/commands/assistants/chat/codexUploadsDetector.ts` | **Create** | Codex-specific rollout discovery and attachment extraction |
| `src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts` | **Create** | Unit tests for the new detector |
| `src/cli/commands/assistants/chat/index.ts` | **Modify** | Add `CODEMIE_AGENT`-aware dispatch; import from `uploads-types.ts` |
| `src/cli/commands/assistants/setup/generators/codex-skill-generator.ts` | **Modify** | Add note about automatic session-based file detection |

---

### Task 1: Extract shared types to `uploads-types.ts`

**Files:**
- Create: `src/cli/commands/assistants/chat/uploads-types.ts`
- Modify: `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` (lines 9–22, 43–49, 247–348)
- Modify: `src/cli/commands/assistants/chat/index.ts` (line 24)

**Interfaces:**
- Produces: `DetectedFile`, `readFilesFromPaths`, `MAX_FILE_SIZE_BYTES`, `BYTES_PER_KB`, `BYTES_PER_MB`, `DEFAULT_MEDIA_TYPE`, `logDetectedFiles` — all re-exported from `uploads-types.ts`
- Consumes: nothing new — pure refactor

Test-first: **no** — this is a refactor; safety net is the existing `claudeUploadsDetector.test.ts` which tests `detectFileUploadsFromSession` and `readFilesFromPaths`. Run it after the rename to confirm no regression.

- [ ] **Step 1: Create `uploads-types.ts`**

```typescript
// src/cli/commands/assistants/chat/uploads-types.ts
import { existsSync, statSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import mime from 'mime-types';
import { logger } from '@/utils/logger.js';

export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = 1024 * 1024;
export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

export interface DetectedFile {
  fileName: string;
  data: string;
  mediaType: string;
  type: 'image' | 'document';
  sizeBytes: number;
}

export function logDetectedFiles(files: DetectedFile[], quiet: boolean): void {
  if (files.length === 0 || quiet) return;
  console.log(chalk.cyan(`\n📎 Detected ${files.length} file(s) with content:`));
  files.forEach((file, index) => {
    const sizeKB = Math.round(file.sizeBytes / BYTES_PER_KB);
    console.log(chalk.dim(`  ${index + 1}. ${file.fileName} (${file.mediaType}, ${sizeKB} KB)`));
  });
  console.log('');
}

function detectMimeType(filePath: string): string {
  return mime.lookup(filePath) || DEFAULT_MEDIA_TYPE;
}

function detectFileType(mimeType: string): 'image' | 'document' {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

/**
 * Read files from disk and convert to DetectedFile format.
 * Agent-agnostic; used by both Claude and Codex detection paths.
 */
export async function readFilesFromPaths(
  filePaths: string[],
  options: { quiet?: boolean } = {}
): Promise<DetectedFile[]> {
  const { quiet = false } = options;
  const detectedFiles: DetectedFile[] = [];
  if (filePaths.length === 0) return [];

  logger.debug('[uploads-types] Reading files from paths', {
    fileCount: filePaths.length,
    paths: filePaths,
  });

  for (const filePath of filePaths) {
    try {
      const absolutePath = resolve(filePath);
      if (!existsSync(absolutePath)) {
        logger.warn('[uploads-types] File does not exist', { filePath: absolutePath });
        if (!quiet) console.log(chalk.yellow(`⚠ File not found: ${filePath}`));
        continue;
      }
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        logger.warn('[uploads-types] Path is not a file', { filePath: absolutePath });
        if (!quiet) console.log(chalk.yellow(`⚠ Not a file: ${filePath}`));
        continue;
      }
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        logger.warn('[uploads-types] File exceeds size limit', {
          filePath: absolutePath,
          sizeMB: (stats.size / BYTES_PER_MB).toFixed(2),
          limit: MAX_FILE_SIZE_MB,
        });
        if (!quiet) console.log(chalk.yellow(`⚠ File too large (>${MAX_FILE_SIZE_MB}MB): ${filePath}`));
        continue;
      }
      const fileBuffer = readFileSync(absolutePath);
      const base64Data = fileBuffer.toString('base64');
      const fileName = basename(absolutePath);
      const mimeType = detectMimeType(absolutePath);
      const fileType = detectFileType(mimeType);
      detectedFiles.push({
        fileName,
        data: base64Data,
        mediaType: mimeType,
        type: fileType,
        sizeBytes: stats.size,
      });
      logger.debug('[uploads-types] Read file from disk', {
        fileName,
        mediaType: mimeType,
        type: fileType,
        sizeMB: (stats.size / BYTES_PER_MB).toFixed(2),
      });
    } catch (error) {
      logger.warn('[uploads-types] Failed to read file', { filePath, error });
      if (!quiet) console.log(chalk.yellow(`⚠ Failed to read file: ${filePath}`));
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

  logger.debug('[uploads-types] Files read from disk', {
    requestedCount: filePaths.length,
    successCount: detectedFiles.length,
  });

  return detectedFiles;
}
```

- [ ] **Step 2: Trim `claudeUploadsDetector.ts` — remove duplicated symbols**

In `claudeUploadsDetector.ts`, delete:
- The `import { statSync }` from `fs` (if only used by `readFilesFromPaths`)
- `import mime from 'mime-types'` (if only used by `readFilesFromPaths`)
- Constants: `MAX_FILE_SIZE_MB`, `MAX_FILE_SIZE_BYTES`, `BYTES_PER_KB`, `BYTES_PER_MB`, `DEFAULT_MEDIA_TYPE`
- The `DetectedFile` interface (lines 43–49)
- Functions `logDetectedFiles`, `readFilesFromPaths`, `detectMimeType`, `detectFileType` (lines 216–348)

Add at the top of `claudeUploadsDetector.ts` (after existing imports):
```typescript
import {
  type DetectedFile,
  readFilesFromPaths,
  logDetectedFiles,
  MAX_FILE_SIZE_BYTES,
  BYTES_PER_MB,
  DEFAULT_MEDIA_TYPE,
} from './uploads-types.js';
```

Keep the `export type { DetectedFile }` and `export { readFilesFromPaths }` at module scope so existing callers (`index.ts`) see no import change yet.

Actually add explicit re-exports at the bottom of the trimmed file:
```typescript
export type { DetectedFile };
export { readFilesFromPaths };
```

- [ ] **Step 3: Run existing Claude detector tests to verify no regression**

```bash
npx vitest run src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/assistants/chat/uploads-types.ts \
        src/cli/commands/assistants/chat/claudeUploadsDetector.ts
git commit -m "refactor(assistants): extract DetectedFile and readFilesFromPaths to uploads-types.ts"
```

---

### Task 2: Add Codex message content types to `codex-message-types.ts`

**Files:**
- Modify: `src/agents/plugins/codex/codex-message-types.ts`

**Interfaces:**
- Produces: `CodexResponseItemMessage`, `CodexContentBlock`, and extended `CodexEventMsg` with `images?: string[]`, `local_images?: string[]`

Test-first: **no** — type-only change; compiler verifies correctness when Task 3 uses these types.

- [ ] **Step 1: Add new interfaces after `CodexResponseItem` (line 60)**

Add after `CodexResponseItem`:
```typescript
/**
 * The `message` sub-type of a `response_item` record — carries user/assistant
 * content including images and documents. Not modelled in the base
 * CodexResponseItem because that interface focuses on function-call shapes.
 */
export interface CodexResponseItemMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: CodexContentBlock[];
}

/** Content block within a CodexResponseItemMessage.content array. */
export interface CodexContentBlock {
  type: 'input_text' | 'input_image' | 'input_file' | string;
  text?: string;
  /** Data URI: "data:<mime>;base64,<b64>" — only on input_image blocks. */
  image_url?: string;
}
```

- [ ] **Step 2: Extend `CodexEventMsg` with user-message attachment fields**

In `CodexEventMsg`, after `message?: string;`, add:
```typescript
  /** Base64 image data URIs — always empty in practice; base64 lives in response_item. */
  images?: string[];
  /** Temp file paths on disk for attached images — basename is the filename fallback. */
  local_images?: string[];
  text_elements?: Array<{
    byte_range?: { start: number; end: number };
    placeholder?: string;
  }>;
```

- [ ] **Step 3: Run typecheck to verify no breakage**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/agents/plugins/codex/codex-message-types.ts
git commit -m "feat(codex): add CodexResponseItemMessage and CodexContentBlock types for attachment extraction"
```

---

### Task 3: Implement `codexUploadsDetector.ts`

**Files:**
- Create: `src/cli/commands/assistants/chat/codexUploadsDetector.ts`
- Create: `src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts`

**Interfaces:**
- Consumes: `DetectedFile` from `./uploads-types.js`; `CodexRolloutRecord`, `CodexSessionMeta`, `CodexEventMsg`, `CodexResponseItemMessage`, `CodexContentBlock` from `@/agents/plugins/codex/codex-message-types.js`; `getCodexDiscoverySessionRoots` from `@/agents/plugins/codex/codex.paths.js`; `readJSONLTolerant` from `@/agents/core/session/utils/jsonl-reader.js`; `isCodexInjectedUserText` from `@/agents/plugins/codex/session/codex-user-prompt.js`
- Produces: `detectCodexFileUploads({ cwd: string, quiet?: boolean }): Promise<DetectedFile[]>`

Test-first: **yes** — write the test with a synthetic rollout containing one `input_image` block; it must fail (function not found) before implementation.

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock BEFORE importing the module under test (dynamic-import pattern required by Vitest)
vi.mock('@/agents/plugins/codex/codex.paths.js', () => ({
  getCodexDiscoverySessionRoots: vi.fn(),
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
    stat: vi.fn(),
  };
});
vi.mock('@/agents/core/session/utils/jsonl-reader.js', () => ({
  readJSONLTolerant: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('detectCodexFileUploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when no session directories found', async () => {
    const { getCodexDiscoverySessionRoots } = await import('@/agents/plugins/codex/codex.paths.js');
    vi.mocked(getCodexDiscoverySessionRoots).mockReturnValue([]);

    const { detectCodexFileUploads } = await import('../codexUploadsDetector.js');
    const result = await detectCodexFileUploads({ cwd: '/project', quiet: true });
    expect(result).toEqual([]);
  });

  it('extracts input_image block from a matching rollout', async () => {
    const { getCodexDiscoverySessionRoots } = await import('@/agents/plugins/codex/codex.paths.js');
    const { readdir, stat } = await import('fs/promises');
    const { readJSONLTolerant } = await import('@/agents/core/session/utils/jsonl-reader.js');

    vi.mocked(getCodexDiscoverySessionRoots).mockReturnValue([
      { sessionsPath: '/fake/.codex/sessions', agentName: 'codex' },
    ]);

    // Fake directory scan: one day dir, one rollout file
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      const path = p as string;
      if (path === '/fake/.codex/sessions') return ['2026'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/2026')) return ['08'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/08')) return ['05'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/05')) return ['rollout-2026-08-05T10:00:00.000Z-abc123.jsonl'] as unknown as import('fs').Dirent[];
      return [] as unknown as import('fs').Dirent[];
    });
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => path.endsWith('/2026') || path.endsWith('/08') || path.endsWith('/05'), mtime: new Date(2026, 7, 5, 10, 0, 0) } as import('fs').Stats);

    // Rollout content: session_meta with matching CWD + user response_item with input_image + event_msg
    const fakeBase64 = Buffer.from('PNG_FAKE_DATA').toString('base64');
    vi.mocked(readJSONLTolerant).mockResolvedValue([
      {
        type: 'session_meta',
        payload: { id: 'abc123', timestamp: '2026-08-05T10:00:00Z', cwd: '/project' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '$codemie-jira-assistant [Image #1]',
          images: [],
          local_images: ['/var/tmp/codex-clipboard-abc.png'],
          turn_id: 'turn-1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/var/tmp/codex-clipboard-abc.png">' },
            { type: 'input_image', image_url: `data:image/png;base64,${fakeBase64}` },
            { type: 'input_text', text: '</image>' },
            { type: 'input_text', text: '$codemie-jira-assistant [Image #1]' },
          ],
        },
      },
    ]);

    const { detectCodexFileUploads } = await import('../codexUploadsDetector.js');
    const result = await detectCodexFileUploads({ cwd: '/project', quiet: true });

    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe('codex-clipboard-abc.png');
    expect(result[0].mediaType).toBe('image/png');
    expect(result[0].type).toBe('image');
    expect(result[0].data).toBe(fakeBase64);
  });

  it('returns [] when rollout CWD does not match', async () => {
    const { getCodexDiscoverySessionRoots } = await import('@/agents/plugins/codex/codex.paths.js');
    const { readdir, stat } = await import('fs/promises');
    const { readJSONLTolerant } = await import('@/agents/core/session/utils/jsonl-reader.js');

    vi.mocked(getCodexDiscoverySessionRoots).mockReturnValue([
      { sessionsPath: '/fake/.codex/sessions', agentName: 'codex' },
    ]);
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      const path = p as string;
      if (path === '/fake/.codex/sessions') return ['2026'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/2026')) return ['08'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/08')) return ['05'] as unknown as import('fs').Dirent[];
      if (path.endsWith('/05')) return ['rollout-2026-08-05T10:00:00.000Z-abc123.jsonl'] as unknown as import('fs').Dirent[];
      return [] as unknown as import('fs').Dirent[];
    });
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => false, mtime: new Date() } as import('fs').Stats);

    vi.mocked(readJSONLTolerant).mockResolvedValue([
      {
        type: 'session_meta',
        payload: { id: 'abc123', timestamp: '2026-08-05T10:00:00Z', cwd: '/other/project' },
      },
    ]);

    const { detectCodexFileUploads } = await import('../codexUploadsDetector.js');
    const result = await detectCodexFileUploads({ cwd: '/project', quiet: true });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

```bash
npx vitest run src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts
```

Expected: `Cannot find module '../codexUploadsDetector.js'` or similar import error.

- [ ] **Step 3: Implement `codexUploadsDetector.ts`**

Create `src/cli/commands/assistants/chat/codexUploadsDetector.ts`:

```typescript
/**
 * Codex-specific file attachment detector.
 *
 * Discovers the active Codex rollout file by scanning the Codex sessions
 * directories for a rollout whose session_meta.cwd matches process.cwd(),
 * then extracts input_image / input_file blocks from the most recent user
 * response_item record.
 *
 * Does NOT use CodexSessionAdapter (which requires AgentMetadata) — rollout
 * discovery is implemented directly via getCodexDiscoverySessionRoots() +
 * readJSONLTolerant to keep the CLI command layer dependency-light.
 */

import { realpath as fsRealpath, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import chalk from 'chalk';
import { logger } from '@/utils/logger.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { getCodexDiscoverySessionRoots } from '@/agents/plugins/codex/codex.paths.js';
import { isCodexInjectedUserText } from '@/agents/plugins/codex/session/codex-user-prompt.js';
import type {
  CodexRolloutRecord,
  CodexSessionMeta,
  CodexEventMsg,
  CodexResponseItemMessage,
  CodexContentBlock,
} from '@/agents/plugins/codex/codex-message-types.js';
import {
  type DetectedFile,
  logDetectedFiles,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  BYTES_PER_MB,
  DEFAULT_MEDIA_TYPE,
} from './uploads-types.js';

const LOG_PREFIX = '[codexUploadsDetector]';
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/;
const IMAGE_WRAPPER_PATTERN = /<image name=\[.*?\] path="([^"]+)">/;
const MAX_ROLLOUT_AGE_DAYS = 1;
const MS_PER_DAY = 86_400_000;

export interface DetectCodexFileUploadsOptions {
  cwd: string;
  quiet?: boolean;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}

/**
 * Scan Codex session day-directory for rollout files, returning descriptors
 * sorted newest-first.
 */
async function discoverRolloutFiles(
  sessionsPath: string,
  cutoffMs: number
): Promise<Array<{ filePath: string; mtime: number }>> {
  const results: Array<{ filePath: string; mtime: number }> = [];

  let yearDirs: string[];
  try {
    yearDirs = await readdir(sessionsPath);
  } catch {
    return results;
  }

  for (const yearDir of yearDirs) {
    const yearPath = join(sessionsPath, yearDir);
    let monthDirs: string[];
    try {
      monthDirs = await readdir(yearPath);
    } catch { continue; }

    for (const monthDir of monthDirs) {
      const monthPath = join(yearPath, monthDir);
      let dayDirs: string[];
      try {
        dayDirs = await readdir(monthPath);
      } catch { continue; }

      for (const dayDir of dayDirs) {
        const dayPath = join(monthPath, dayDir);
        let files: string[];
        try {
          files = await readdir(dayPath);
        } catch { continue; }

        for (const file of files) {
          if (!ROLLOUT_FILE_PATTERN.test(file)) continue;
          const filePath = join(dayPath, file);
          try {
            const s = await stat(filePath);
            if (s.mtime.getTime() >= cutoffMs) {
              results.push({ filePath, mtime: s.mtime.getTime() });
            }
          } catch { /* skip unreadable */ }
        }
      }
    }
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

/**
 * Find the rollout file whose session_meta.cwd resolves to cwdReal.
 * Returns the file path of the newest matching rollout, or null.
 */
async function findMatchingRollout(cwdReal: string): Promise<string | null> {
  const roots = getCodexDiscoverySessionRoots();
  if (!roots.length) {
    logger.debug(`${LOG_PREFIX} No Codex session directories found`);
    return null;
  }

  const cutoffMs = Date.now() - MAX_ROLLOUT_AGE_DAYS * MS_PER_DAY;
  const allCandidates: Array<{ filePath: string; mtime: number }> = [];

  for (const root of roots) {
    const candidates = await discoverRolloutFiles(root.sessionsPath, cutoffMs);
    allCandidates.push(...candidates);
  }

  allCandidates.sort((a, b) => b.mtime - a.mtime);

  for (const { filePath } of allCandidates) {
    const records = await readJSONLTolerant<CodexRolloutRecord>(filePath, LOG_PREFIX);
    const metaRecord = records.find((r) => r.type === 'session_meta');
    if (!metaRecord) continue;

    const sessionMeta = metaRecord.payload as CodexSessionMeta;
    const metaReal = await safeRealpath(sessionMeta.cwd);

    if (metaReal === cwdReal) {
      logger.debug(`${LOG_PREFIX} Matched rollout`, { filePath, cwd: sessionMeta.cwd });
      return filePath;
    }
  }

  return null;
}

/**
 * Process a single input_image content block into a DetectedFile.
 * Returns null when the block is invalid or too large.
 */
function processImageBlock(
  block: CodexContentBlock,
  fileName: string
): DetectedFile | null {
  if (!block.image_url) {
    logger.warn(`${LOG_PREFIX} input_image block missing image_url`, { fileName });
    return null;
  }

  const commaIdx = block.image_url.indexOf(',');
  if (commaIdx === -1) {
    logger.warn(`${LOG_PREFIX} Malformed data URI in input_image block`, { fileName });
    return null;
  }

  const prefix = block.image_url.slice(0, commaIdx);
  const base64Data = block.image_url.slice(commaIdx + 1);
  const mimeMatch = /data:([^;]+);base64/.exec(prefix);
  const mediaType = mimeMatch?.[1] ?? DEFAULT_MEDIA_TYPE;

  try {
    const fileSize = Buffer.from(base64Data, 'base64').length;
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      logger.warn(`${LOG_PREFIX} File exceeds size limit, skipping`, {
        fileName,
        sizeMB: (fileSize / BYTES_PER_MB).toFixed(2),
        limit: MAX_FILE_SIZE_MB,
      });
      return null;
    }

    return {
      fileName,
      data: base64Data,
      mediaType,
      type: 'image',
      sizeBytes: fileSize,
    };
  } catch (error) {
    logger.warn(`${LOG_PREFIX} Invalid base64 data`, { fileName, error });
    return null;
  }
}

/**
 * Extract attached files from a Codex rollout record array.
 *
 * Algorithm:
 * 1. Scan backward for the last event_msg with type user_message that is
 *    not injected context — captures local_images for filename fallback.
 * 2. Scan backward for the last response_item with role user that has
 *    input_image/input_file blocks and is not purely injected text.
 * 3. Walk the content array; for each input_image block, extract filename
 *    from the preceding <image name=... path="..."> text wrapper (or
 *    local_images[i] as fallback) and parse the data URI.
 */
function extractAttachmentsFromRecords(records: CodexRolloutRecord[]): DetectedFile[] {
  let targetResponseItem: CodexResponseItemMessage | null = null;
  let targetEventMsg: (CodexEventMsg & { local_images?: string[] }) | null = null;

  // Single backward pass: find both anchor records
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];

    if (!targetResponseItem && record.type === 'response_item') {
      const payload = record.payload as unknown as CodexResponseItemMessage;
      if (
        payload.type === 'message' &&
        payload.role === 'user' &&
        Array.isArray(payload.content) &&
        payload.content.some((b) => b.type === 'input_image' || b.type === 'input_file')
      ) {
        // Confirm the user text is not entirely injected
        const userText = payload.content
          .filter((b): b is CodexContentBlock & { text: string } =>
            b.type === 'input_text' && typeof b.text === 'string'
          )
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (!userText || !isCodexInjectedUserText(userText)) {
          targetResponseItem = payload;
        }
      }
    }

    if (!targetEventMsg && record.type === 'event_msg') {
      const payload = record.payload as CodexEventMsg & { local_images?: string[] };
      if (
        payload.type === 'user_message' &&
        typeof payload.message === 'string' &&
        !isCodexInjectedUserText(payload.message)
      ) {
        targetEventMsg = payload;
      }
    }

    if (targetResponseItem && targetEventMsg) break;
  }

  if (!targetResponseItem) {
    logger.debug(`${LOG_PREFIX} No user response_item with attachments found`);
    return [];
  }

  const detectedFiles: DetectedFile[] = [];
  const content = targetResponseItem.content;
  let localImageIndex = 0;

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type !== 'input_image' && block.type !== 'input_file') continue;

    // Filename: check preceding <image name=...> wrapper
    let fileName: string | undefined;
    if (i > 0) {
      const prev = content[i - 1];
      if (prev.type === 'input_text' && typeof prev.text === 'string') {
        const match = IMAGE_WRAPPER_PATTERN.exec(prev.text);
        if (match) fileName = basename(match[1]);
      }
    }
    // Fallback to local_images basename
    if (!fileName) {
      const localPath = targetEventMsg?.local_images?.[localImageIndex];
      if (localPath) fileName = basename(localPath);
    }
    fileName = fileName || `attachment_${localImageIndex}`;
    localImageIndex++;

    if (block.type === 'input_image') {
      const detectedFile = processImageBlock(block, fileName);
      if (detectedFile) detectedFiles.push(detectedFile);
    }
    // input_file handling can be added here in future iterations
  }

  logger.debug(`${LOG_PREFIX} Extracted attachments`, {
    count: detectedFiles.length,
  });

  return detectedFiles;
}

/**
 * Detect file uploads from the active Codex rollout.
 *
 * Finds the most recent rollout matching the given CWD, then extracts any
 * files attached in the most recent user turn.
 *
 * @param options.cwd   Project directory (typically process.cwd())
 * @param options.quiet Suppress console output when true
 */
export async function detectCodexFileUploads(
  options: DetectCodexFileUploadsOptions
): Promise<DetectedFile[]> {
  const { cwd, quiet = false } = options;

  logger.debug(`${LOG_PREFIX} Detecting file uploads from Codex rollout`, { cwd });

  try {
    const cwdReal = await safeRealpath(cwd);
    const rolloutPath = await findMatchingRollout(cwdReal);

    if (!rolloutPath) {
      logger.debug(`${LOG_PREFIX} No matching rollout found for cwd`, { cwdReal });
      return [];
    }

    const records = await readJSONLTolerant<CodexRolloutRecord>(rolloutPath, LOG_PREFIX);
    const detectedFiles = extractAttachmentsFromRecords(records);

    logDetectedFiles(detectedFiles, quiet);

    logger.debug(`${LOG_PREFIX} Detection complete`, {
      filesDetected: detectedFiles.length,
    });

    return detectedFiles;
  } catch (error) {
    logger.debug(`${LOG_PREFIX} Failed to detect file uploads`, { error });
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass (GREEN)**

```bash
npx vitest run src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/assistants/chat/codexUploadsDetector.ts \
        src/cli/commands/assistants/chat/__tests__/codexUploadsDetector.test.ts
git commit -m "feat(assistants): implement codexUploadsDetector for Codex rollout attachment extraction"
```

---

### Task 4: Wire agent-aware dispatch in `chat/index.ts`

**Files:**
- Modify: `src/cli/commands/assistants/chat/index.ts`

**Interfaces:**
- Consumes: `detectCodexFileUploads` from `./codexUploadsDetector.js`; `DetectedFile`, `readFilesFromPaths` from `./uploads-types.js`
- No change to `detectFileUploadsFromSession` import from `./claudeUploadsDetector.js`

Test-first: **no** — simple conditional branch; verified by typecheck and the integration path visible in existing architecture.

- [ ] **Step 1: Update the import on line 24**

Replace:
```typescript
import { detectFileUploadsFromSession, readFilesFromPaths, type DetectedFile } from './claudeUploadsDetector.js';
```
With:
```typescript
import { detectFileUploadsFromSession } from './claudeUploadsDetector.js';
import { detectCodexFileUploads } from './codexUploadsDetector.js';
import { readFilesFromPaths, type DetectedFile } from './uploads-types.js';
```

- [ ] **Step 2: Replace the file detection block (lines 98–104)**

Replace:
```typescript
  // 1. Detect files from the Claude session (always use CODEMIE_SESSION_ID, not --conversation-id).
  // --conversation-id identifies the assistant chat thread; CODEMIE_SESSION_ID identifies the
  // Claude session whose JSONL contains the uploaded file blobs.
  const claudeSessionId = process.env.CODEMIE_SESSION_ID;
  if (claudeSessionId) {
    detectedFiles = await detectFileUploadsFromSession(claudeSessionId, { quiet: false });
  }
```
With:
```typescript
  // 1. Detect files from the agent session.
  // CODEMIE_AGENT selects the detection strategy:
  //   - 'codex': scan Codex rollout JSONL via CWD match (hooks non-functional in Codex)
  //   - default: read Claude session JSONL via CODEMIE_SESSION_ID → correlation → agentSessionFile
  const agentName = process.env.CODEMIE_AGENT;
  if (agentName === 'codex') {
    detectedFiles = await detectCodexFileUploads({ cwd: process.cwd(), quiet: false });
  } else {
    const claudeSessionId = process.env.CODEMIE_SESSION_ID;
    if (claudeSessionId) {
      detectedFiles = await detectFileUploadsFromSession(claudeSessionId, { quiet: false });
    }
  }
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/assistants/chat/index.ts
git commit -m "feat(assistants): add CODEMIE_AGENT-aware file detection dispatch for Codex"
```

---

### Task 5: Update `codex-skill-generator.ts` — add file attachment note

**Files:**
- Modify: `src/cli/commands/assistants/setup/generators/codex-skill-generator.ts`

**Interfaces:**
- No interface changes — template update only

Test-first: **no** — string template; no logic.

- [ ] **Step 1: Update the skill template in `createSkillContent` to mention automatic detection**

In `createSkillContent` (line 30), update the instructions section. After the existing step 4 (`After any write, re-fetch…`), add a step 5 about file attachments:

Locate the current text at the end of `dedent\`` block (after step 4):
```typescript
    Run CodeMie assistant chat with the user's message:
```

Before that line add step 5:
```typescript
    5. **File attachments are automatically detected** — if the user attaches an image or document when invoking this skill, CodeMie will detect it from the Codex session rollout automatically. You do not need to pass \`CODEMIE_SESSION_ID\` or any attachment flag explicitly; the \`codemie assistants chat\` command handles it. Use \`--file\` only when you want to attach a file from the filesystem that was NOT dragged into the Codex session.

```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/assistants/setup/generators/codex-skill-generator.ts
git commit -m "docs(assistants): note automatic file detection in Codex skill template"
```

---

## Self-Review Checklist

**Spec coverage:**

| AC | Task |
|---|---|
| Investigation completed on how Codex stores file attachments | Research pre-completed (format analysis doc); documented in `codexUploadsDetector.ts` header |
| Extend file attachments to support Codex | Task 3 + Task 4 |
| User can invoke via `/slug` or `@slug` with a file attached | Task 4 dispatch wires up; skill template updated in Task 5 |
| Message and file attachment sent to CodeMie correctly | `uploadFilesToCodeMie` and `sendMessageWithHistory` unchanged; `DetectedFile` contract preserved |
| Attachment support works for Codex assistants from `codemie setup assistants` | Task 5 skill generator update |
| No regression for Claude | Task 1 preserves Claude path via `else` branch; existing tests remain |
| No regression for invocations without attachments | `detectCodexFileUploads` returns `[]` when no rollout found |
| Codex-specific constraints documented | `codexUploadsDetector.ts` module docstring; type extensions in `codex-message-types.ts` |

**Placeholder scan:** No TBDs, no "similar to" references, all code blocks complete.

**Type consistency:**
- `DetectedFile` defined in `uploads-types.ts`, re-exported from `claudeUploadsDetector.ts`, imported in `index.ts` from `uploads-types.ts` directly.
- `detectCodexFileUploads` signature: `(options: DetectCodexFileUploadsOptions): Promise<DetectedFile[]>` — matches the call site in `index.ts`.
- `CodexResponseItemMessage.content: CodexContentBlock[]` — used in detector; consistent with type definitions in Task 2.
