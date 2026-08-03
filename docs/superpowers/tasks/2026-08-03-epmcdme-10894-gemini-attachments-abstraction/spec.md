# Spec: Gemini Attachments Abstraction Layer
**Ticket**: EPMCDME-10894
**Branch**: EPMCDME-10894_gemini-attachments-abstraction

## Problem

`src/cli/commands/assistants/chat/index.ts` directly imports `detectFileUploadsFromSession`, `readFilesFromPaths`, and `DetectedFile` from `claudeUploadsDetector.ts` — a Claude-specific module. This violates the architecture guide's plugin-independence rule and means Gemini sessions get Claude's session-scan logic applied to them (Gemini session files have a different format and contain no embedded base64 blobs, so the scan silently returns wrong results).

The `--file` flag path (`readFilesFromPaths`) already works for all agents. The gap is session-based auto-detection: when `CODEMIE_SESSION_ID` is set, the wrong detector runs for Gemini.

## Goals

1. `codemie-gemini` users can attach files via `--file` with correct behaviour (no Claude detector running against a Gemini session).
2. Attachments logic lives in a shared abstraction — no per-agent duplication.
3. Constraints are documented in source.
4. No regression for existing Claude attachment flows.

## Out of Scope

- `gemini.conversations-processor.ts` `file_names: []` hardcode (session analytics pipeline, separate concern).
- Adding `--file` to `AgentCLI` / `codemie-gemini` agent runner (follow-up).
- Any changes to `uploadFilesToCodeMie`, `sendMessageWithHistory`, or the SDK call site.

## Architecture

All changes are confined to `src/cli/commands/assistants/chat/`. No plugin layer is touched.

### File Layout

```
chat/
├── types.ts                    ← ADD DetectedFile + UploadsDetector interfaces
├── uploadsUtils.ts             ← NEW: readFilesFromPaths + ATTACHMENT_CONSTRAINTS
├── uploadsDetector.factory.ts  ← NEW: createUploadsDetector(conversationId?)
├── claudeUploadsDetector.ts    ← REFACTOR: ClaudeUploadsDetector class; drop DetectedFile export + readFilesFromPaths
├── geminiUploadsDetector.ts    ← NEW: GeminiUploadsDetector class
├── index.ts                    ← UPDATE: use factory + uploadsUtils
└── __tests__/
    ├── claudeUploadsDetector.test.ts  ← UPDATE: import paths only
    ├── geminiUploadsDetector.test.ts  ← NEW
    └── uploadsDetector.factory.test.ts ← NEW
```

### Data Flow

```
chat/index.ts
  → createUploadsDetector(conversationId)      ← reads session agentName via loadSession()
      → ClaudeUploadsDetector | GeminiUploadsDetector
  → detector.detectFromSession(conversationId) ← Claude: JSONL scan; Gemini: []
  → readFilesFromPaths(options.file)           ← disk read, agent-agnostic
  → uploadFilesToCodeMie(client, allFiles)     ← unchanged
  → client.assistants.chat(... file_names ...) ← unchanged
```

## Components

### `chat/types.ts` — interfaces

```typescript
export interface DetectedFile {
  fileName: string;
  data: string;       // base64-encoded content
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

`DetectedFile` moves here from `claudeUploadsDetector.ts`. All existing usages re-import from `./types.js`.

### `chat/uploadsUtils.ts` — shared disk utility

```typescript
export const ATTACHMENT_CONSTRAINTS = {
  MAX_FILE_SIZE_MB: 100,
  RECENT_MESSAGES_LIMIT: 2,   // Claude session scan only; Gemini returns []
  SUPPORTED_TYPES: ['image', 'document'] as const,
  MULTI_FILE: true,
} as const;

export async function readFilesFromPaths(
  paths: string[],
  options?: { quiet?: boolean }
): Promise<DetectedFile[]>
```

`readFilesFromPaths` moves here from `claudeUploadsDetector.ts` unchanged. `MAX_FILE_SIZE_MB` and `RECENT_MESSAGES_LIMIT` move here and are re-imported by `claudeUploadsDetector.ts`.

### `chat/uploadsDetector.factory.ts` — runtime detector selection

```typescript
export async function createUploadsDetector(
  conversationId?: string
): Promise<UploadsDetector> {
  if (conversationId) {
    const session = await loadSession(conversationId);
    if (session?.agentName === 'gemini') {
      return new GeminiUploadsDetector();
    }
  }
  return new ClaudeUploadsDetector();
}
```

Uses `loadSession` from `src/agents/core/session/SessionStore.ts` (already exported). Falls back to `ClaudeUploadsDetector` when there is no session ID — preserves full backward compatibility for standalone `codemie assistants chat` invocations.

### `chat/claudeUploadsDetector.ts` — refactored

`detectFileUploadsFromSession` and all helper functions remain in this file as module-private. A thin class wrapper is added:

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

`DetectedFile` export removed (now in `types.ts`). `readFilesFromPaths` body moves to `uploadsUtils.ts`.

### `chat/geminiUploadsDetector.ts` — new

```typescript
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

### `chat/index.ts` — updated import and detection block

Import change:
```typescript
// Before
import { detectFileUploadsFromSession, readFilesFromPaths, type DetectedFile } from './claudeUploadsDetector.js';

// After
import { type DetectedFile } from './types.js';
import { readFilesFromPaths } from './uploadsUtils.js';
import { createUploadsDetector } from './uploadsDetector.factory.js';
```

Detection block change:
```typescript
// Before
if (conversationId) {
  detectedFiles = await detectFileUploadsFromSession(conversationId, { quiet: false });
}

// After
if (conversationId) {
  const detector = await createUploadsDetector(conversationId);
  detectedFiles = await detector.detectFromSession(conversationId, { quiet: false });
}
```

No other changes to `chat/index.ts`.

## Error Handling

- `createUploadsDetector`: if `loadSession` throws or returns null, fall back to `ClaudeUploadsDetector` (same as no-session path). No error surfaced to the user.
- `GeminiUploadsDetector.detectFromSession`: returns `[]`, never throws.
- All other error handling in `uploadFilesToCodeMie` and `sendMessageWithHistory` is unchanged.

## Testing

### `claudeUploadsDetector.test.ts` — import-path updates only
All existing test cases pass unchanged. Update `DetectedFile` import to `./types.js` and `readFilesFromPaths` import to `./uploadsUtils.js`.

### `geminiUploadsDetector.test.ts` — new
- `detectFromSession` returns `[]` for any input
- Class is instantiable and assignable to `UploadsDetector`

### `uploadsDetector.factory.test.ts` — new
`loadSession` is mocked via `vi.mock`.
- Returns `GeminiUploadsDetector` when `session.agentName === 'gemini'`
- Returns `ClaudeUploadsDetector` when `session.agentName === 'claude'`
- Returns `ClaudeUploadsDetector` when `conversationId` is `undefined`

## Constraints (Requirement 3)

Documented in `ATTACHMENT_CONSTRAINTS` in `uploadsUtils.ts`:

| Constraint | Value | Notes |
|---|---|---|
| Max file size | 100 MB | Per file; enforced in `readFilesFromPaths` |
| Session scan depth | 2 messages | Claude session auto-detection only |
| Supported types | image, document | MIME detection via `mime-types` |
| Multi-file | Yes | `--file` flag is repeatable |
| Gemini session detection | None | Gemini sessions have no embedded blobs |

## Acceptance Criteria Mapping

| AC | How met |
|---|---|
| `codemie-gemini` sends at least one attached file | `--file` path works; `GeminiUploadsDetector` replaces broken Claude scan for Gemini sessions |
| Reusable abstraction, no copy/paste | `UploadsDetector` interface + factory; `readFilesFromPaths` shared via `uploadsUtils.ts` |
| Constraints documented | `ATTACHMENT_CONSTRAINTS` in `uploadsUtils.ts` |
| No regression without attachments | Factory falls back to `ClaudeUploadsDetector`; `readFilesFromPaths` unchanged |
