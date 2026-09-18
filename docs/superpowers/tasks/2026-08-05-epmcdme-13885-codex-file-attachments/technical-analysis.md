# Technical Research

**Task**: codex uploads detector assistants chat session correlation
**Generated**: 2026-08-05T00:00:00Z
**Research path**: codegraph + filesystem

---

## 1. Original Context

**Ticket:** EPMCDME-13885 — CodeMie CLI (Codex): implement file attachments support for CodeMie assistants

**Description:**
Extend the current file attachments implementation used for CodeMie assistant invocation so that it also supports Codex. Users can register assistants for Codex via `codemie setup assistants` and invoke them via `/slug` or `@slug`. This task ensures that when a user invokes a configured CodeMie assistant from Codex with a file, the attachment is correctly collected, transferred to CodeMie, and handled by the assistant. This improves feature parity across supported CLI agents.

**Acceptance criteria:**
- Investigation is completed to determine how Codex stores and exposes file attachments for assistant invocation flows.
- The current file attachments implementation (currently works for Claude) is extended to support Codex as well.
- A user can invoke a configured CodeMie assistant from Codex via `/slug` or `@slug` with a file attached.
- The message and file attachment are sent to CodeMie and handled correctly by the assistant.
- Attachment support works for Codex assistant flows created via `codemie setup assistants`.
- No regression is introduced for existing attachment support in Claude.
- No regression is introduced for assistant invocation without attachments.

---

## 2. Codebase Findings

### Existing Implementations

**Claude upload detector (reference implementation):**
- `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` — Claude-exclusive. Entry point: `detectFileUploadsFromSession(sessionId, options)`. Internal flow:
  1. `readSessionMetadata(sessionId)` → reads `~/.codemie/sessions/{id}.json` → `Session`
  2. `extractAgentSessionFile(session)` → reads `session.correlation.agentSessionFile` (requires `status === 'matched'`)
  3. `readJSONL<ClaudeMessage>(agentSessionFile)` → parses the Claude JSONL transcript
  4. `extractFileContentFromMessages(messages)` → finds most recent non-meta user message, captures its `promptId`, collects `isMeta` messages with the same `promptId`, extracts `image`/`document` content items where `source.type === 'base64'` and `source.data` holds the raw base64 string
  5. Returns `DetectedFile[]`

- `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` also exports:
  - `readFilesFromPaths(filePaths, options)` → reads files from `--file` CLI paths; shared by both Claude and Codex code paths
  - `DetectedFile` interface: `{ fileName, data, mediaType, type: 'image' | 'document', sizeBytes }`

**Chat orchestration (integration point):**
- `src/cli/commands/assistants/chat/index.ts` — key section (lines 100–110):
  ```typescript
  const claudeSessionId = process.env.CODEMIE_SESSION_ID;
  if (claudeSessionId) {
    detectedFiles = await detectFileUploadsFromSession(claudeSessionId, { quiet: false });
  }
  if (options.file && options.file.length > 0) {
    const filesFromPaths = await readFilesFromPaths(options.file, { quiet: false });
    detectedFiles = [...detectedFiles, ...filesFromPaths];
  }
  ```
  - This code does NOT branch on agent type. For Codex the same `CODEMIE_SESSION_ID` env var is checked, but `detectFileUploadsFromSession` will silently return `[]` because `session.correlation.agentSessionFile` is never populated for Codex (hooks are non-functional).
  - `uploadFilesToCodeMie(client, files)` → calls `client.files.bulkUpload(FileToUpload[])` → returns `string[]` (file URLs)
  - `sendMessageWithHistory` passes `file_names: fileUrls` to `client.assistants.chat()`

**Codex plugin:**
- `src/agents/plugins/codex/codex.plugin.ts` — `onSessionStart(sessionId, env)`:
  - Calls `processEvent(SessionStart)` → creates `~/.codemie/sessions/{id}.json` with `correlation: { status: 'pending', retryCount: 0 }`
  - Calls `startCodexIncrementalSync({ sessionId, startedAt, cwd, ... })`
  - Does NOT populate `session.correlation.agentSessionFile` — this is never set for Codex sessions
  - The comment block at lines 27–35 explicitly documents that Codex hooks are non-functional

- `src/agents/plugins/codex/codex.incremental-sync.ts` — timer tick pattern for rollout discovery:
  ```typescript
  const adapter = new CodexSessionAdapter(options.metadata);
  const sessions = await adapter.discoverSessions({ maxAgeDays: 1, limit: 10 });
  for (const descriptor of sessions) {
    if (descriptor.createdAt < options.startedAt - STARTED_AT_GRACE_MS) continue;
    const parsed = await adapter.parseSessionFile(descriptor.filePath, options.sessionId);
    const projectPath = parsed.metadata?.projectPath;
    const projectReal = await safeRealpath(projectPath);
    if (projectReal !== cwdReal) continue;
    // process this rollout
  }
  ```
  This is the canonical pattern for finding the active rollout matching the current CWD. The new `codexUploadsDetector.ts` must use the same pattern.

**Codex session adapter:**
- `src/agents/plugins/codex/codex.session.ts` — `CodexSessionAdapter`:
  - `discoverSessions({ maxAgeDays, limit })` → scans `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/codemie/home/sessions/YYYY/MM/DD/rollout-*.jsonl`; returns `SessionDescriptor[]` sorted newest-first
  - `parseSessionFile(filePath, sessionId)` → reads rollout JSONL, extracts `session_meta`/`turn_context`; returns parsed metadata including `metadata.projectPath` (the CWD when Codex started)

**Codex message types:**
- `src/agents/plugins/codex/codex-message-types.ts` — defines `CodexLine` discriminated union; contains `response_item` and `event_msg` record shapes

**Codex user prompt parser:**
- `src/agents/plugins/codex/session/codex-user-prompt.ts` — `firstCodexUserText()` and `isCodexInjectedUserText()` demonstrate the rollout record shapes:
  - `event_msg { payload.type === 'user_message', payload.message }` — text-only metadata
  - `response_item { payload.type === 'message', payload.role === 'user', payload.content: ContentBlock[] }` — actual content with `input_text` / `input_image` / `input_file` blocks

**Session types:**
- `src/agents/core/session/types.ts` — `Session.correlation: CorrelationResult`:
  ```typescript
  interface CorrelationResult {
    status: CorrelationStatus;           // 'pending' | 'matched' | 'failed'
    agentSessionFile?: string;           // Path to matched agent JSONL/rollout file
    agentSessionId?: string;
    detectedAt?: number;
    retryCount: number;
  }
  ```
  For Codex, `status` is always `'pending'` and `agentSessionFile` is never set.

**Utilities reusable by new detector:**
- `src/agents/core/session/utils/jsonl-reader.ts` — `readJSONL<T>()` and `readJSONLTolerant<T>()` — shared JSONL reader
- `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` — `readFilesFromPaths()` export is already agent-agnostic and reusable

---

### Architecture and Layers Affected

| Layer | Component | Change required |
|---|---|---|
| CLI / Command | `src/cli/commands/assistants/chat/index.ts` | Add agent-aware dispatch: check `CODEMIE_AGENT` env var, call Codex detector when agent is `codex` |
| CLI / Detector | `src/cli/commands/assistants/chat/codexUploadsDetector.ts` | **New file** — Codex-specific rollout parsing analogous to `claudeUploadsDetector.ts` |
| Agent Plugin | `src/agents/plugins/codex/codex.plugin.ts` | `onSessionStart`: optionally store rollout discovery criteria; see risk notes |
| Core Session | `src/agents/core/session/types.ts` | No changes required; `CorrelationResult.agentSessionFile` shape is already sufficient |

---

### Integration Points

**Agent context detection in `chat/index.ts`:**
- `process.env.CODEMIE_AGENT` is set by `BaseAgentAdapter` from `metadata.name` before the child process runs. Inside a Codex skill invocation, `CODEMIE_AGENT === 'codex'`.
- The dispatch branch should be:
  ```typescript
  const agentName = process.env.CODEMIE_AGENT;
  if (agentName === 'codex') {
    detectedFiles = await detectCodexFileUploads({ cwd: process.cwd(), quiet: false });
  } else if (process.env.CODEMIE_SESSION_ID) {
    detectedFiles = await detectFileUploadsFromSession(process.env.CODEMIE_SESSION_ID, { quiet: false });
  }
  ```

**Rollout discovery in `codexUploadsDetector.ts`:**
- Use `CodexSessionAdapter.discoverSessions({ maxAgeDays: 1, limit: 10 })` + CWD realpath match (identical to incremental-sync tick pattern).
- No dependency on `session.correlation.agentSessionFile` — bypasses the broken hook correlation entirely.
- Input: current `process.cwd()` (the project directory where Codex was launched).
- Discovery must be tolerant of concurrent write: the rollout is being appended to as Codex runs. Use `readJSONLTolerant<T>()`.

**Turn identification in the rollout:**
- Find the most recent `turn_id` that has a `response_item` record with `payload.role === 'user'` containing `input_image` or `input_file` blocks.
- Image data: `block.image_url` is a data URI `"data:<mime>;base64,<b64>"` — extract MIME and base64 by splitting on `,`.
- Filename: extracted from the `<image name=... path="...">` wrapper text block that precedes the `input_image` block in the same `content` array; fall back to `event_msg.local_images[i]` for the same `turn_id`.

**SDK upload chain (unchanged):**
- `DetectedFile` returned by the new detector must match the existing interface exactly (same fields: `fileName`, `data`, `mediaType`, `type`, `sizeBytes`) so `uploadFilesToCodeMie()` and `sendMessageWithHistory()` require no changes.

---

### Patterns and Conventions

- Detector files in `src/cli/commands/assistants/chat/` follow the pattern: named `<agent>UploadsDetector.ts`, export a primary `detect*` async function returning `Promise<DetectedFile[]>`, use `logger.debug` for diagnostics and `chalk` for console output.
- All JSONL reading goes through `readJSONL` / `readJSONLTolerant` from `src/agents/core/session/utils/jsonl-reader.ts`.
- Realpath normalization via `fsRealpath` + `safeRealpath` fallback is required for CWD matching (macOS symlinks: `/Users/foo` ↔ `/private/Users/foo`).
- The `DetectedFile` interface is defined in `claudeUploadsDetector.ts` and imported into `index.ts`; the new Codex detector should import and reuse `DetectedFile` rather than redefining it.
- Agent plugin lifecycle methods (`onSessionStart`, `onSessionEnd`) use fire-and-forget error handling (`try/catch` with `logger.error`, never throwing).
- Constants (type strings, status codes) are extracted into `const` objects at module top level.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture; CLI layer dispatches to Provider/Plugin layer via Registry
- `.ai-run/guides/integration/external-integrations.md` — provider plugin patterns, SSO, agent adapters
- `.ai-run/guides/integration/exposed-api.md` — CLI surface, plugin contracts
- `docs/superpowers/plans/2026-05-09-codex-hooks-incremental-sync.md` — records the investigation confirming Codex hooks are non-functional; establishes the incremental-sync timer as the canonical workaround

### Architectural Decisions

- **ADR (inline, `codex.plugin.ts` lines 27–35):** Codex hooks advertised in 0.129.0 were confirmed non-firing on `codex exec`; timer-based incremental sync chosen as the workaround.
- **Decision (inline, `codex.plugin.ts` `beforeRun`):** CodeMie-managed Codex runs use `CODEX_HOME=~/.codex/codemie/home` to isolate state from native Codex.
- **Decision (inline, `codex.plugin.ts` `enrichArgs`):** Custom `model_providers.codemie` provider used to bypass `~/.codex/auth.json` precedence for OPENAI_API_KEY.
- **Decision (`claudeUploadsDetector.ts` comment):** Session detection always uses `CODEMIE_SESSION_ID` (not `--conversation-id`) because the two identify different things: the agent session vs the assistant chat thread.

### Derived Conventions

- New detector must be in `src/cli/commands/assistants/chat/` alongside `claudeUploadsDetector.ts`.
- Rollout discovery must use `CodexSessionAdapter` (not raw `fs.glob`) to inherit the multi-root scan logic and `SessionDescriptor` sorting.
- The `DetectedFile` interface defined in `claudeUploadsDetector.ts` is the shared contract; do not duplicate it.
- Agent-discriminating logic in `index.ts` must default to the Claude path so existing behavior is preserved when `CODEMIE_AGENT` is unset or `'claude'`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts` — covers `detectFileUploadsFromSession` (3 call sites); uses fixture JSONL files; tests `isMeta`+`promptId` grouping logic. **No Codex analog exists yet.**
- `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts` — covers `startCodexIncrementalSync` / `stopCodexIncrementalSync` with a fake adapter; does not test rollout-to-file extraction.
- `src/agents/plugins/codex/__tests__/codex.paths.test.ts` — covers `getCodexSessionDayPath`.
- `src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts` — covers `extractCodexUsageRecords` using fixture rollout files at `tests/integration/session/fixtures/codex/`.

### Testing Framework and Patterns

- **Framework**: Vitest
- **Fixtures**: Codex rollout fixture files exist at `tests/integration/session/fixtures/codex/`. The new detector tests should add a fixture rollout JSONL containing `response_item` records with `input_image` blocks.
- **Mocking pattern**: dynamic imports after `vi.mock()` setup (per `.ai-run/guides/testing/testing-patterns.md`).
- **Claude detector test pattern**: mock `fs.existsSync`, `fs.readFileSync`, and the JSONL reader; supply synthetic `ClaudeMessage[]` arrays. The same approach applies to Codex tests using synthetic `CodexLine[]` arrays.

### Coverage Gaps

- `codexUploadsDetector.ts` — entire new module; zero coverage until tests are written
- `codex.plugin.ts` `onSessionStart` — no test for correlation store update if it is added
- `chat/index.ts` agent-dispatch branch — no test for `CODEMIE_AGENT === 'codex'` path

---

## 5. Configuration and Environment

### Environment Variables

| Variable | Purpose |
|---|---|
| `CODEMIE_SESSION_ID` | CodeMie session ID set by hooks; used by Claude detector path; Codex does not set this reliably via hooks but `onSessionStart` creates the session file with this ID |
| `CODEMIE_AGENT` | Agent name string (`'codex'`, `'claude'`, etc.); set by `BaseAgentAdapter` from `metadata.name`; used by `chat/index.ts` to choose detector |
| `CODEX_HOME` | Codex home dir override; set to `~/.codex/codemie/home` by `beforeRun` for CodeMie-managed runs |
| `CODEMIE_CODEX_SYNC_ENABLED` | Set to `'false'` to disable incremental sync |
| `CODEMIE_CODEX_SYNC_INTERVAL_MS` | Sync interval override (default 30 000 ms) |

### Configuration Files

- `~/.codemie/sessions/{id}.json` — `Session` object; `correlation.agentSessionFile` is populated for Claude, not for Codex
- `~/.codex/sessions/YYYY/MM/DD/rollout-{ISO8601}-{uuid}.jsonl` — Codex rollout (native CODEX_HOME)
- `~/.codex/codemie/home/sessions/YYYY/MM/DD/rollout-*.jsonl` — Codex rollout (CodeMie-managed CODEX_HOME)
- `~/.codex/skills/{slug}/SKILL.md` — generated by `codex-skill-generator.ts`; current template instructs agent to use `--file`; no session-based detection mentioned

### Feature Flags and Deployment Concerns

- No feature flags gate this functionality; the agent-dispatch branch in `index.ts` is the only toggle (presence of `CODEMIE_AGENT`).
- The generated Codex skill template in `src/cli/commands/assistants/setup/generators/codex-skill-generator.ts` currently tells the skill "do NOT use `CODEMIE_SESSION_ID` as a fallback" — this note may become stale or misleading once session-based detection is in place and should be reviewed.

---

## 6. Risk Indicators

- **No `session.correlation.agentSessionFile` for Codex** — `onSessionStart` creates the session file with `status: 'pending'`, and `agentSessionFile` is never set because hooks do not fire. The new detector must bypass `extractAgentSessionFile()` entirely and discover the rollout directly via `CodexSessionAdapter.discoverSessions()` + CWD matching, identical to the incremental-sync tick pattern.

- **Rollout timing race** — at the moment `codemie assistants chat` is invoked from a Codex skill, the rollout file is still being written (Codex is running). The detector must use `readJSONLTolerant<T>()` rather than `readJSONL<T>()` to tolerate incomplete/truncated trailing lines.

- **Rollout path ambiguity (dual CODEX_HOME)** — `CodexSessionAdapter.discoverSessions()` already scans both `~/.codex/sessions` and `~/.codex/codemie/home/sessions`. Multiple rollout files may match the same CWD + time window. The detector must take the newest match only (descriptors are already sorted newest-first by the adapter).

- **Different base64 encoding format** — Claude: `item.source.data` (raw base64 string). Codex: `block.image_url = "data:<mime>;base64,<b64>"` (data URI). The new detector must split on the first `,` to separate MIME from base64. The MIME value from the data URI overrides any mime-types lookup.

- **`event_msg.images` is always empty** — base64 is never stored in `event_msg`. Filename can be recovered from `event_msg.local_images[i]` (temp file path) or from the `<image name=... path="...">` text wrapper in the `response_item`. The two records share the same `turn_id`; the new detector must correlate by `turn_id`.

- **`turn_id` location** — based on pre-completed research, `turn_id` is carried in `internal_chat_message_metadata_passthrough`. This field name must be confirmed against `codex-message-types.ts` before implementation; the type definitions are the authoritative source.

- **No existing test coverage for the new code surface** — `codexUploadsDetector.ts` starts with zero tests; the agent-dispatch branch in `index.ts` has no test. A fixture rollout JSONL with `input_image` blocks is needed (can be derived from existing fixtures at `tests/integration/session/fixtures/codex/`).

- **Codex skill generator stale note** — `src/cli/commands/assistants/setup/generators/codex-skill-generator.ts` currently advises against using `CODEMIE_SESSION_ID`. Once session-based detection is transparent (no env var required), that note may confuse future maintainers; it should be removed or updated.

- **`CODEMIE_AGENT` set by `BaseAgentAdapter`** — the agent-type check in `chat/index.ts` depends on `CODEMIE_AGENT` being present. Confirm `BaseAgentAdapter` sets it unconditionally before Codex launches; if not, the guard must fall through to the Claude path silently (not throw).

- **`DetectedFile` import coupling** — `DetectedFile` is currently defined inside `claudeUploadsDetector.ts` and imported from there by `index.ts`. If the Codex detector imports `DetectedFile` from `claudeUploadsDetector.ts`, a circular-import risk exists if `claudeUploadsDetector.ts` is ever changed to import from the Codex side. Safest: export `DetectedFile` and `readFilesFromPaths` from a shared `uploads-types.ts` in the same directory.

---

## 7. Summary for Complexity Assessment

This task touches three architectural layers: the CLI/Command layer (`chat/index.ts`), a new CLI/Detector module (`codexUploadsDetector.ts`), and the Agent Plugin layer (`codex.plugin.ts`). The estimated file change surface is 3–4 files: one new file, two modified files, and potentially a shared types extraction. The SDK upload chain (`uploadFilesToCodeMie`, `client.files.bulkUpload`) and the `DetectedFile` contract require no changes, which significantly bounds the blast radius.

The task introduces one genuinely novel pattern: rollout-based attachment extraction. The incremental-sync tick already demonstrates the rollout discovery algorithm (CWD realpath match, adapter.discoverSessions, parseSessionFile), so the core discovery logic can be cloned with minor adaptation. The novel piece is parsing the OpenAI Responses API content block format (`input_image` with data URI `image_url`) instead of the Claude base64 `source.data` shape. This requires careful handling of the data URI split and turn-based grouping using `turn_id`/`internal_chat_message_metadata_passthrough`. The exact field path for `turn_id` must be confirmed against `codex-message-types.ts` before coding — this is the primary investigation step remaining.

Test coverage posture is weak for the new code: no existing test covers `codexUploadsDetector.ts` (it doesn't exist yet), and the agent-dispatch branch in `index.ts` is untested. Existing fixtures at `tests/integration/session/fixtures/codex/` provide a starting point, but a new fixture rollout containing `response_item` + `input_image` blocks must be created. The absence of test infrastructure for the new detector path is the most significant risk factor for regression — both for the Codex path and for inadvertent breakage of the Claude path if `detectFileUploadsFromSession` import or the dispatch logic is touched incorrectly.
