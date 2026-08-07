# Fix Claude Upload Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs in `claudeUploadsDetector.ts` so that `codemie assistants chat` without `--file` correctly detects and forwards files uploaded in the current Claude session turn.

**Architecture:** Replace the two-pass parent/child attachment lookup with a single backward-scan over messages that stops at the most recent assistant message (turn boundary). For each `isMeta=true` message within the current turn that has base64 attachment content, extract the filename directly from the `[Image: source:]` text in that same message. This is turn-precise: only attachments the user just dropped are forwarded, never historical ones from earlier turns.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Node.js ≥ 20.0.0
- No new dependencies
- Public exports (`detectFileUploadsFromSession`, `readFilesFromPaths`) and their signatures are unchanged
- ES modules: all imports require `.js` extension
- Test framework: Vitest

---

### Task 1: Update tests to reflect correct behavior (RED)

**Files:**
- Modify: `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts`

**Interfaces:**
- Consumes: `detectFileUploadsFromSession` (unchanged public signature)
- Produces: updated and new tests that fail against the current source and pass after Task 2

**Why tests change before source:** TDD order — write tests encoding the correct behavior first, observe RED, then fix the source.

- [ ] **Step 1: Update test at line 174 — move base64 into the meta message (real JSONL structure)**

Replace the two-message fixture (meta=filename only, non-meta=base64) with a single meta message that holds both. Find the `it('should detect single image file with base64 data'` block and replace its body:

```typescript
it('should detect single image file with base64 data', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  const mockSession: Session = {
    id: mockSessionId,
    correlation: { status: 'matched', agentSessionFile: mockAgentSessionFile }
  } as Session;
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

  const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const messages: ClaudeMessage[] = [
    // Real Claude Code JSONL: meta message holds BOTH base64 and [Image: source:] text
    {
      type: 'user',
      uuid: 'meta-1',
      parentUuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:01Z',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /path/to/screenshot.png]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64Data }
          }
        ]
      }
    } as ClaudeMessage,
    // Parent non-meta message — empty, as in real Claude Code JSONL
    {
      type: 'user',
      uuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: [] }
    } as ClaudeMessage
  ];
  vi.mocked(readJSONL).mockResolvedValue(messages);

  const result = await detectFileUploadsFromSession(mockSessionId);

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    fileName: 'screenshot.png',
    data: base64Data,
    mediaType: 'image/png',
    type: 'image'
  });
  expect(result[0].sizeBytes).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Update test at line 244 — move both attachments into the meta message**

Find the `it('should detect multiple files in same message'` block and replace its body:

```typescript
it('should detect multiple files in same message', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  const mockSession: Session = {
    id: mockSessionId,
    correlation: { status: 'matched', agentSessionFile: mockAgentSessionFile }
  } as Session;
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

  const messages: ClaudeMessage[] = [
    {
      type: 'user',
      uuid: 'meta-1',
      parentUuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:01Z',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Image: source: /path/to/image1.png]\n[Document: source: /path/to/doc.pdf]'
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'base64-image-data' }
          },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'base64-pdf-data' }
          }
        ]
      }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: [] }
    } as ClaudeMessage
  ];
  vi.mocked(readJSONL).mockResolvedValue(messages);

  const result = await detectFileUploadsFromSession(mockSessionId);

  expect(result).toHaveLength(2);
  expect(result[0].fileName).toBe('image1.png');
  expect(result[0].type).toBe('image');
  expect(result[0].sizeBytes).toBeGreaterThan(0);
  expect(result[1].fileName).toBe('doc.pdf');
  expect(result[1].type).toBe('document');
  expect(result[1].sizeBytes).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Rewrite test at line 316 — validate turn-boundary detection**

Find the `it('should only check last 2 user messages'` block and replace the entire test:

```typescript
it('should detect attachment at any position within the current turn', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  const mockSession: Session = {
    id: mockSessionId,
    correlation: { status: 'matched', agentSessionFile: mockAgentSessionFile }
  } as Session;
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

  // Session layout (chronological order, as stored in JSONL):
  //   [0] assistant message     ← turn boundary (scan stops here)
  //   [1] msg-parent            ← non-meta empty (current turn)
  //   [2] meta-with-image       ← isMeta, has base64 (current turn) ← MUST be detected
  //   [3] meta-text-only        ← isMeta, no attachment (current turn)
  //   [4] msg-tool-result       ← non-meta tool_result (current turn)
  const messages: ClaudeMessage[] = [
    {
      type: 'assistant',
      uuid: 'asst-1',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'Previous assistant reply' }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:01Z',
      message: { role: 'user', content: [] }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'meta-with-image',
      parentUuid: 'msg-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:02Z',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /path/to/photo.png]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'base64-photo-data' }
          }
        ]
      }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'meta-text-only',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:03Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'some context' }] }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-tool-result',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:04Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'tool output' }]
      }
    } as ClaudeMessage
  ];
  vi.mocked(readJSONL).mockResolvedValue(messages);

  const result = await detectFileUploadsFromSession(mockSessionId);

  expect(result).toHaveLength(1);
  expect(result[0].data).toBe('base64-photo-data');
  expect(result[0].fileName).toBe('photo.png');
  expect(result[0].sizeBytes).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Add new test — turn boundary prevents detecting historical attachments**

Add after the rewritten Step 3 test, inside the `describe('file detection')` block:

```typescript
it('should not detect attachments from a previous turn', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  const mockSession: Session = {
    id: mockSessionId,
    correlation: { status: 'matched', agentSessionFile: mockAgentSessionFile }
  } as Session;
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

  // Turn 1: user uploaded an image, assistant replied
  // Turn 2: user sends a plain message, no new upload
  // detectFileUploadsFromSession must return [] — turn 2 has no attachments
  const messages: ClaudeMessage[] = [
    // Turn 1 — previous turn
    {
      type: 'user',
      uuid: 'meta-old',
      parentUuid: 'msg-old-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:00Z',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /old/image.png]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'old-image-data' }
          }
        ]
      }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-old-parent',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:01Z',
      message: { role: 'user', content: [] }
    } as ClaudeMessage,
    // Assistant reply — turn boundary
    {
      type: 'assistant',
      uuid: 'asst-1',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:02Z',
      message: { role: 'assistant', content: 'I see your image.' }
    } as ClaudeMessage,
    // Turn 2 — current turn, plain text only, no attachment
    {
      type: 'user',
      uuid: 'msg-current',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:03Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Just a text message, no new file' }]
      }
    } as ClaudeMessage
  ];
  vi.mocked(readJSONL).mockResolvedValue(messages);

  const result = await detectFileUploadsFromSession(mockSessionId);

  expect(result).toEqual([]);
});
```

- [ ] **Step 5: Add new test — image at position 3+ with tool-result messages at positions 1–2**

Add after the Step 4 test:

```typescript
it('should detect image at position 3 when tool-result messages are at positions 1 and 2', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  const mockSession: Session = {
    id: mockSessionId,
    correlation: { status: 'matched', agentSessionFile: mockAgentSessionFile }
  } as Session;
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

  // Reproduces the real evidence from EPMCDME-13907:
  //   uuid=c8d31c75  tool_result   ← position 1 (most recent, no attachment)
  //   uuid=a31514f8  isMeta, text  ← position 2 (no attachment)
  //   uuid=00b98ab8  isMeta, image ← position 3 (WAS MISSED by old limit=2)
  //   uuid=3677b4c3  non-meta, []  ← parent, empty
  const messages: ClaudeMessage[] = [
    {
      type: 'user',
      uuid: 'msg-3677b4c3',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: [] }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-00b98ab8',
      parentUuid: 'msg-3677b4c3',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:01Z',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /uploads/diagram.png]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'base64-diagram' }
          }
        ]
      }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-a31514f8',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:02Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'context only' }] }
    } as ClaudeMessage,
    {
      type: 'user',
      uuid: 'msg-c8d31c75',
      sessionId: mockSessionId,
      timestamp: '2024-01-01T00:00:03Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'tool result value' }]
      }
    } as ClaudeMessage
  ];
  vi.mocked(readJSONL).mockResolvedValue(messages);

  const result = await detectFileUploadsFromSession(mockSessionId);

  expect(result).toHaveLength(1);
  expect(result[0].fileName).toBe('diagram.png');
  expect(result[0].data).toBe('base64-diagram');
  expect(result[0].type).toBe('image');
  expect(result[0].sizeBytes).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Run tests — verify failures on the updated and new tests**

```bash
cd /Users/sergeynikitin/projects/codemie-dev/codemie-code
npm test -- --reporter=verbose src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts 2>&1 | tail -30
```

Expected: tests at lines 174, 244, 316 (rewritten), and the two new tests FAIL. All other tests PASS.

- [ ] **Step 7: Commit test changes**

```bash
git add src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts
git commit -m "test(assistants): update claudeUploadsDetector tests for real JSONL structure

- Update 'single image' fixture: meta message holds both base64 and filename
- Update 'multiple files' fixture: both attachments co-located in meta message
- Rewrite 'last 2 messages' test to 'detects at any position within current turn'
- Add turn-boundary test: attachments from previous turns are NOT detected
- Add position-3 test: image found when tool-results at positions 1-2

EPMCDME-13907"
```

Test-first: yes — 5 tests fail against the current source after this commit.

---

### Task 2: Fix claudeUploadsDetector.ts (GREEN)

**Files:**
- Modify: `src/cli/commands/assistants/chat/claudeUploadsDetector.ts`

**Interfaces:**
- Consumes: `ClaudeMessage` (unchanged), `ContentItem` (unchanged)
- Produces: `detectFileUploadsFromSession(sessionId, options?)` — same signature, correctly detects current-turn attachments only

- [ ] **Step 1: Add `ASSISTANT` to `MESSAGE_TYPE` constant (line 25)**

```typescript
const MESSAGE_TYPE = {
  USER: 'user',
  ASSISTANT: 'assistant',
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document'
} as const;
```

- [ ] **Step 2: Remove `RECENT_MESSAGES_LIMIT` constant (line 19)**

Delete:
```typescript
const RECENT_MESSAGES_LIMIT = 2;
```

- [ ] **Step 3: Remove `extractFileNamesFromMetaMessage` function (lines 73–89)**

Delete the entire function:
```typescript
function extractFileNamesFromMetaMessage(message: ClaudeMessage): string[] {
  if (!message.isMeta || !message.parentUuid || !Array.isArray(message.message?.content)) {
    return [];
  }

  const fileNames: string[] = [];
  for (const item of message.message.content) {
    if (item.type === MESSAGE_TYPE.TEXT && item.text) {
      const matches = item.text.matchAll(ATTACHMENT_PATH_PATTERN);
      for (const match of matches) {
        fileNames.push(extractFileName(match[2]));
      }
    }
  }

  return fileNames;
}
```

- [ ] **Step 4: Remove `buildAttachmentMap` function (lines 91–113)**

Delete the entire function:
```typescript
function buildAttachmentMap(messages: ClaudeMessage[]): Map<string, string[]> {
  const attachmentMap = new Map<string, string[]>();
  const messagesWithAttachments = new Set<string>();

  for (const msg of messages) {
    if (msg.type === MESSAGE_TYPE.USER && msg.uuid && Array.isArray(msg.message?.content)) {
      const hasAttachment = msg.message.content.some(item => isAttachmentType(item.type));
      if (hasAttachment) {
        messagesWithAttachments.add(msg.uuid);
      }
    }
  }

  for (const msg of messages) {
    const fileNames = extractFileNamesFromMetaMessage(msg);
    if (fileNames.length > 0 && msg.parentUuid && messagesWithAttachments.has(msg.parentUuid)) {
      const existing = attachmentMap.get(msg.parentUuid) || [];
      attachmentMap.set(msg.parentUuid, [...existing, ...fileNames]);
    }
  }

  return attachmentMap;
}
```

- [ ] **Step 5: Remove `getRecentUserMessages` function (lines 153–167)**

Delete the entire function:
```typescript
function getRecentUserMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const recentMessages: ClaudeMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === MESSAGE_TYPE.USER && msg.uuid) {
      recentMessages.push(msg);
      if (recentMessages.length >= RECENT_MESSAGES_LIMIT) {
        break;
      }
    }
  }

  return recentMessages;
}
```

- [ ] **Step 6: Replace `extractFileContentFromMessages` with turn-boundary backward scan**

Replace the entire function (current lines 214–254) with:

```typescript
function extractFileContentFromMessages(messages: ClaudeMessage[]): DetectedFile[] {
  const detectedFiles: DetectedFile[] = [];

  // Scan backward from the most recent message, stopping at the last assistant message.
  // This bounds detection to the current turn only — attachments from earlier turns
  // sit before an assistant reply and must not be forwarded again.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === MESSAGE_TYPE.ASSISTANT) {
      break;
    }

    if (!msg.isMeta || !Array.isArray(msg.message?.content)) {
      continue;
    }

    const content = msg.message.content;
    const attachmentItems = content.filter(item => isAttachmentType(item.type));

    if (attachmentItems.length === 0) {
      continue;
    }

    // Real Claude Code JSONL: meta messages hold both the base64 content and
    // the [Image: source: /path] filename text in the same message object.
    const fileNames: string[] = [];
    for (const item of content) {
      if (item.type === MESSAGE_TYPE.TEXT && item.text) {
        const matches = item.text.matchAll(ATTACHMENT_PATH_PATTERN);
        for (const match of matches) {
          fileNames.push(extractFileName(match[2]));
        }
      }
    }

    for (let j = 0; j < attachmentItems.length; j++) {
      const fileName = fileNames[j] ?? generateFallbackFileName(detectedFiles.length, j);
      const detectedFile = processFileItem(attachmentItems[j], fileName, msg.uuid);
      if (detectedFile) {
        detectedFiles.push(detectedFile);
      }
    }
  }

  logger.debug(`${LOG_PREFIX} Checked session messages`, {
    totalMessages: messages.length,
    filesFound: detectedFiles.length
  });

  return detectedFiles;
}
```

- [ ] **Step 7: Update the call site in `detectFileUploadsFromSession` (lines 415–416)**

Replace:
```typescript
const attachmentMap = buildAttachmentMap(messages);
const detectedFiles = extractFileContentFromMessages(messages, attachmentMap);
```

With:
```typescript
const detectedFiles = extractFileContentFromMessages(messages);
```

- [ ] **Step 8: Run the full test suite for the detector**

```bash
cd /Users/sergeynikitin/projects/codemie-dev/codemie-code
npm test -- --reporter=verbose src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts 2>&1
```

Expected: all tests PASS. Zero failures.

- [ ] **Step 9: Run typecheck**

```bash
cd /Users/sergeynikitin/projects/codemie-dev/codemie-code
npm run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 10: Commit the fix**

```bash
git add src/cli/commands/assistants/chat/claudeUploadsDetector.ts
git commit -m "fix(assistants): correct session attachment detection in claudeUploadsDetector

Replace two-pass parent/child buildAttachmentMap lookup with a backward scan
that stops at the most recent assistant message (turn boundary). Real Claude
Code JSONL stores base64 content and [Image: source:] filename text in the
same isMeta=true message; the non-meta parent is empty. The turn-boundary
stop ensures only attachments from the current turn are forwarded — not
historical uploads from earlier turns.

Fixes: EPMCDME-13907"
```

Test-first: yes — all 5 failing tests from Task 1 turn GREEN after this commit.
