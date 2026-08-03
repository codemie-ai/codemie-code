# Technical Research

**Task**: gemini attachments abstraction cli agents
**Generated**: 2026-08-03T00:00:00Z
**Research path**: codegraph + filesystem

---

## 1. Original Context

CodeMie CLI (codemie-gemini): scale file attachments support via abstraction layer. Extend file attachments support to codemie-gemini and implement it via a reusable abstraction so multiple CLI agents can share the same attachments pipeline. Requirements: (1) codemie-gemini supports sending at least one attached file with a message to a CodeMie assistant; (2) Attachments implementation is done via a reusable abstraction, with no per-agent copy/paste; (3) Constraints/limits documented: types, size, single/multi-file; (4) No regression for sending messages without attachments; (5) Work aligns with EPMCDME-10645. Affected areas: CodeMie CLI codemie-gemini integration, shared attachments abstraction (common layer for agents), request payload format/SDK usage for assistant calls, regression surface for agents that already have PoCs (e.g. codemie-claude).

---

## 2. Codebase Findings

### Existing Implementations

**Attachment pipeline — already in place, but Claude-only:**

- `src/cli/commands/assistants/chat/index.ts` — `createAssistantsChatCommand()`: defines `-f, --file <path>` flag (accumulator, repeatable); orchestrates the full pipeline: `detectFileUploadsFromSession()` + `readFilesFromPaths()` → `uploadFilesToCodeMie()` → `client.files.bulkUpload()` → `client.assistants.chat()` with `file_names`. This is the single integration point for all agents using the `codemie assistants chat` subcommand.
- `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` — **Reference PoC (Claude-specific)**. Exports:
  - `DetectedFile` interface (`{ fileName, data: base64, mediaType, type, sizeBytes }`) — currently embedded here, needs extraction
  - `detectFileUploadsFromSession(conversationId)` — reads `~/.codemie/sessions/{id}.json` → resolves `correlation.agentSessionFile` (Claude JSONL path) → parses last `RECENT_MESSAGES_LIMIT=2` user messages → extracts `{ source: { type: 'base64', data, media_type } }` blocks → returns `DetectedFile[]`
  - `readFilesFromPaths(paths)` — disk-based, format-agnostic; reads files, detects MIME via `mime-types`, returns `DetectedFile[]`; this function is fully reusable today
- `src/cli/commands/assistants/chat/types.ts` — `ChatCommandOptions` already carries `file?: string[]`; `MessageSendRequest` does NOT model `file_names` (inline construction in `chat/index.ts`)
- `src/cli/commands/sdk/utils/file-utils.ts` — a second `readFilesFromPaths` variant returning SDK `File[]` (not `DetectedFile[]`); a separate concern for SDK-direct flows, not to be merged with the chat pipeline version

**Gemini plugin — no attachment logic:**

- `bin/codemie-gemini.js` — entry point; delegates to `AgentRegistry` + `AgentCLI`; identical pattern to `codemie-claude.js`
- `src/agents/core/AgentCLI.ts` — universal CLI builder for all agents; defines shared flags (`--task`, `--resume`, etc.); NO `--file` flag (file flag lives only on the `codemie assistants chat` subcommand, not on the agent runner itself)
- `src/agents/core/BaseAgentAdapter.ts` — abstract base; env var transform, proxy setup, subprocess spawn lifecycle; all agents extend this
- `src/agents/plugins/gemini/gemini.plugin.ts` — `GeminiPlugin extends BaseAgentAdapter`; `GeminiPluginMetadata` with `envMapping`, `flagMappings`, lifecycle hooks; no attachment-related code or tests
- `src/agents/plugins/gemini/gemini.session-adapter.ts` — parses `~/.gemini/tmp/{hash}/chats/` JSON session files; registers `GeminiMetricsProcessor` and `GeminiConversationsProcessor`
- `src/agents/plugins/gemini/session/processors/gemini.conversations-processor.ts` — builds conversation turns for `client.assistants.chat`; currently hardcodes `file_names: []` (gap: attachment names never passed)
- `src/cli/commands/assistants/setup/generators/gemini-skill-generator.ts` — already generates SKILL.md documents showing `--file` usage in examples; **the user-facing UX contract is already published**

**Session and agent types:**

- `src/agents/core/session/BaseSessionAdapter.ts` — `SessionAdapter` interface + `ParsedSession` unified type; shared across all agents
- `src/agents/core/session/types.ts` — `Session`, `CorrelationResult`, `SyncState`; stored in `~/.codemie/sessions/{id}.json`
- `src/agents/plugins/claude/claude-message-types.ts` — `ClaudeMessage` type used by `claudeUploadsDetector`; Claude-specific

**SDK layer:**

- `src/utils/sdk-client.ts` — `getCodemieClient()` → initializes `CodeMieClient` with SSO cookies; used by `chat/index.ts`

### Architecture and Layers Affected

| Layer | Component | Change Required |
|---|---|---|
| CLI command layer | `src/cli/commands/assistants/chat/index.ts` | Swap direct `claudeUploadsDetector` import for agent-aware abstraction |
| Abstraction layer (new) | `src/cli/commands/assistants/chat/` or `src/agents/core/` | Create `UploadsDetector` interface; extract `DetectedFile` to shared types |
| Claude implementation | `src/cli/commands/assistants/chat/claudeUploadsDetector.ts` | Implement `UploadsDetector` interface; export `DetectedFile` from shared location |
| Gemini implementation (new) | `src/cli/commands/assistants/chat/geminiUploadsDetector.ts` | Implement `UploadsDetector` for Gemini session format |
| Gemini conversations processor | `src/agents/plugins/gemini/session/processors/gemini.conversations-processor.ts` | Evaluate whether `file_names: []` hardcode needs fixing at this layer |
| SDK/upload layer | `client.files.bulkUpload` + `client.assistants.chat` with `file_names` | No change — already agent-neutral |

The architecture guide (`architecture.md`) mandates that plugins must not depend on each other. The current `chat/index.ts` directly imports `claudeUploadsDetector.ts` — a Claude-specific module — violating the expected abstraction boundary. This task exists to fix that violation.

Per the guide: shared abstractions belong in `src/agents/core/` or within the command layer that uses them (`src/cli/commands/assistants/chat/`). Since the detector is CLI-layer logic consuming session data, placement in `chat/` is acceptable.

### Integration Points

**Internal dependencies:**

- `bin/codemie-gemini.js` → `AgentCLI` → `BaseAgentAdapter` → `GeminiPlugin`
- `cli/commands/assistants/chat/index.ts` → `claudeUploadsDetector.ts` → `agents/plugins/claude/claude-message-types.ts` (direct coupling to Claude — the abstraction smell to fix)
- `cli/commands/assistants/chat/index.ts` → `codemie-sdk` (`client.files.bulkUpload`, `client.assistants.chat`)
- `AgentCLI` → `AgentRegistry` → `GeminiPlugin extends BaseAgentAdapter`
- `GeminiPlugin` → `GeminiSessionAdapter` → `GeminiConversationsProcessor`

**External dependencies:**

- `codemie-sdk`: `CodeMieClient`, `FileToUpload`, `File`, `client.files.bulkUpload()`, `client.assistants.chat()` with `file_names` — the SDK call is already fully agent-neutral; no SDK changes anticipated
- `mime-types`: MIME detection in `readFilesFromPaths()` — already used by the Claude path; reusable as-is

**Key runtime hook:**

`chat/index.ts` calls `detectFileUploadsFromSession(conversationId)` where `conversationId` comes from `CODEMIE_SESSION_ID` env var. When the active agent is Gemini, this must route to a Gemini-aware implementation. The session correlation key (`correlation.agentSessionFile`) in `~/.codemie/sessions/{id}.json` determines which session file to read; a Gemini session file has a different structure (top-level `messages[]` JSON, plain string content) versus Claude's JSONL with embedded base64 blobs.

### Patterns and Conventions

- **Plugin/adapter pattern**: every agent extends `BaseAgentAdapter` and implements `AgentAdapter`; agent-specific logic goes into `{agent}.plugin.ts` + `{agent}.session-adapter.ts`. The abstraction layer must not live inside a plugin.
- **`DetectedFile` as transfer object**: `{ fileName, data: base64, mediaType, type, sizeBytes }` flows from detection → `uploadFilesToCodeMie()` → `FileToUpload[]` → SDK. This interface is the natural abstraction boundary and must be extracted to a shared `types.ts`.
- **Two detection paths**: (a) `--file` CLI flag → `readFilesFromPaths()` (disk, agent-agnostic, already works for Gemini); (b) session JSONL auto-detection → `detectFileUploadsFromSession()` (Claude-specific, needs Gemini implementation).
- **Flag pass-through**: `AgentCLI.collectPassThroughArgs()` passes unknown flags directly to subprocesses; `flagMappings` in metadata handles remapping. If `--file` were to be added to the agent runner (not just `codemie assistants chat`), this pattern is available.
- **`UploadsDetector` interface shape** (to be introduced): `{ detectFromSession(conversationId: string, options?: DetectorOptions): Promise<DetectedFile[]> }` — the same signature as the existing function; Claude and Gemini each provide an implementation.
- Code quality conventions from guides: ES modules with `.js` extensions, single quotes, explicit return types, `logger.debug()` not `console.log`, `interface` over `type` for shapes.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `src/.ai-run/guides/architecture/architecture.md` — defines the 5-layer plugin architecture (`CLI → Registry → Plugin → Core → Utils`), file naming conventions (`*.plugin.ts`, `types.ts`), and the constraint that **plugins must not depend on each other**. The abstraction layer must live in `src/agents/core/` or within `src/cli/commands/assistants/chat/` (not inside any plugin).
- `src/.ai-run/guides/integration/external-integrations.md` — covers Gemini plugin metadata (`envMapping`, `ssoConfig`, lifecycle hooks), provider selection rules, and session analytics flow. The Gemini plugin currently has no attachment-related lifecycle behavior documented.
- `src/.ai-run/guides/development/development-practices.md` — ES modules, `.js` extensions, single quotes, explicit return types, `logger.debug()` not `console.log`, `PathSecurityError` for traversal, `sanitizeLogArgs()`.
- `src/.ai-run/guides/standards/code-quality.md` — TypeScript style; `interface` over `type` for shapes.
- `src/.ai-run/guides/quality-gates.md` — zero-warn lint, typecheck, build must pass before merge.
- `src/.ai-run/guides/project.md` — Jira key `EPMCDME`, GitHub PR via `gh`, branch pattern `EPMCDME-\d+`.

### Architectural Decisions

No formal ADR files exist. Relevant recorded decisions:

- Architecture guide mandates: **plugins must not depend on each other**. The current state — `chat/index.ts` (a shared command layer) importing `claudeUploadsDetector.ts` (a Claude-specific module) — is the architectural violation this task corrects.
- `NOTE` in `src/agents/plugins/claude/sounds-installer.ts`: "This function violates typical utils layer pattern by handling UI directly." — acknowledged single deliberate exception; not a precedent.
- `TODO` in `src/agents/plugins/gemini/session/processors/gemini.conversations-processor.ts`: `// TODO: Detect continuations` adjacent to `isTurnContinuation: false` — indicates known incomplete work in the Gemini session processor that may intersect with attachment handling.

### Derived Conventions

- The `DetectedFile` interface must be extracted from `claudeUploadsDetector.ts` to a shared `types.ts` in `src/cli/commands/assistants/chat/` (or wherever the abstraction lives) so both Claude and Gemini implementations can import it without cross-plugin dependency.
- The `readFilesFromPaths()` function (disk-based, `DetectedFile[]` output) in `claudeUploadsDetector.ts` is already fully agent-agnostic and should remain in the abstraction layer or a shared utils file — not duplicated per agent.
- Gemini session files do NOT embed base64 file blobs (content is plain strings), so a `GeminiUploadsDetector.detectFromSession()` implementation will likely return an empty array. The `--file` flag path (`readFilesFromPaths`) is the primary attachment mechanism for Gemini.
- The abstraction should NOT attempt to make `chat/index.ts` agent-aware via conditional branching. Instead, use a strategy/factory pattern: the correct `UploadsDetector` implementation is selected at command setup time based on agent context (session type or plugin identity).

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts` — comprehensive unit tests covering `detectFileUploadsFromSession` (Claude JSONL parsing, base64 extraction, 100 MB size limit enforcement, fallback filenames, quiet mode) and `readFilesFromPaths` (disk reads, MIME detection, directory/not-found/error skipping). These tests must continue to pass after refactoring.
- `tests/unit/cli/commands/assistants/chat/index.test.ts` — verifies `--file`/`-f` option is registered on the Commander program (structure check only; no execution logic tested).
- `tests/integration/session/gemini-conversation-processing.test.ts` — integration test for Gemini session turn-parsing, tool-call extraction, incremental sync using a real fixture at `tests/integration/metrics/fixtures/gemini/session-2025-12-01T21-45-5b959dae.json`; not attachment-related but provides a Gemini session fixture that could serve as a basis for an attachment detector test.
- `src/agents/plugins/gemini/__tests__/gemini.extension-installer.test.ts` — Gemini extension installer only; no plugin-level tests.
- `src/agents/core/__tests__/AgentCLI-resume.test.ts` — `AgentCLI` resume behavior; no attachment coverage.
- `src/agents/core/__tests__/flag-transform.test.ts` — flag transformation utility; no attachment coverage.

### Testing Framework and Patterns

- **Framework**: Vitest with three named projects: `unit` (src/**/*.test.ts, isolation mode, 30 s timeout), `cli` (tests/integration/** excluding agent-*, 30 s), `agent` (tests/integration/agent-*.test.ts, real network/SSO/JWT, 180 s, configurable workers via `CI_AGENT_MAX_WORKERS`).
- `vi.mock()` at module level for all I/O dependencies (fs, logger, readJSONL, session-config, chalk)
- `beforeEach` + `vi.clearAllMocks()` / `afterEach` + `vi.restoreAllMocks()` for isolation
- `vi.mocked()` for typed mock access; `mockReturnValueOnce` chaining for sequential calls
- `TempWorkspace` helper (`tests/helpers/temp-workspace.ts`) for filesystem isolation in integration tests
- Fixture-driven integration tests: real JSON session files in `tests/integration/metrics/fixtures/gemini/`
- `dryRun: true` in integration processing context to prevent real network calls

### Coverage Gaps

- **No tests for `GeminiPlugin` or `GeminiSessionAdapter`** in any attachment-related context; the plugin is untested at the plugin level.
- **No tests for `uploadFilesToCodeMie()`** — the SDK upload path is not directly tested.
- **No abstraction layer exists** → no tests for it; these must be created new.
- **No test for `GeminiUploadsDetector`** (does not exist yet).
- **No integration/e2e test for `--file` option end-to-end** (detection → upload → assistant call).
- **No test for the agent-dispatch path** — what happens when `detectFileUploadsFromSession` is called with a Gemini session context (rather than Claude).
- If `readFilesFromPaths()` is extracted from `claudeUploadsDetector.ts` to a shared module, the existing `claudeUploadsDetector.test.ts` tests for it will need import path updates.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SESSION_ID` — used as `conversationId` fallback in `chatWithAssistant`; also the key for `detectFileUploadsFromSession` session file lookup; will continue to work for Gemini as-is
- `GEMINI_API_KEY` — Gemini CLI direct API key authentication
- `GEMINI_MODEL` — Gemini model selection override
- `GOOGLE_GEMINI_BASE_URL` / `GEMINI_BASE_URL` — base URL override for Gemini backend (both checked in order)
- `CODEMIE_URL` — CodeMie backend URL
- `CODEMIE_AUTH_METHOD` / `CODEMIE_JWT_TOKEN` — authentication configuration
- `CI_AGENT_MAX_WORKERS` — parallel worker count for agent integration tests in CI (default 2)

### Configuration Files

- `src/env/types.ts` — all config shapes: `ProviderProfile` (per-agent settings, hooks, metrics, assistants, auth); `MultiProviderConfig` v2; `LegacyConfig`; Gemini listed as a valid `agentTargets` value alongside `claude` and `codex`
- `src/env/manager.ts` — `EnvManager`: reads/writes `~/.codemie/codemie-cli.config.json`; lookup priority is `process.env > global config`
- `src/utils/config.ts` — `ConfigLoader`: merges global profile + local `.codemie/` project config + env var overrides

### Feature Flags and Deployment Concerns

- **No feature flags exist** for attachments; the pipeline is always active once `--file` is passed or session detection fires.
- `MAX_FILE_SIZE_MB = 100` — per-file size cap hardcoded in `claudeUploadsDetector.ts`; not externally configurable. The abstraction layer should surface this as a documented constraint (requirement 3).
- `RECENT_MESSAGES_LIMIT = 2` — how many recent user messages are scanned for session-based attachments; also hardcoded. Document in abstraction.
- No `.env.example` file exists in the project root; env vars are documented only in source comments and plugin metadata. Adding Gemini attachment constraints to the env types file or a README section would satisfy requirement 3.

---

## 6. Risk Indicators

- **Session-based auto-detection is Claude-only and tightly coupled**: `detectFileUploadsFromSession` reads `ClaudeMessage` JSONL with embedded base64 blobs. Gemini session files use a different format (top-level `messages[]` JSON, plain string content — no embedded file blobs). A Gemini session detector will likely return empty results; the `--file` flag path is the realistic attachment mechanism for Gemini. This must be made explicit in tests and documentation.
- **`claudeUploadsDetector.ts` directly imported by shared command layer**: `chat/index.ts` imports a Claude-specific module, violating the architecture guide's plugin independence rule. The refactoring to extract the interface and factory is non-trivial if done carefully to avoid breaking existing Claude tests.
- **`DetectedFile` interface not in a shared location**: it must be moved from `claudeUploadsDetector.ts` to a shared `types.ts`; all existing imports in `claudeUploadsDetector.test.ts` and `chat/index.ts` will need updates.
- **`GeminiPlugin` has zero unit tests**: any change to the Gemini plugin path has no safety net. New tests must be written as part of this task.
- **`uploadFilesToCodeMie()` is not directly tested**: the SDK upload path could silently regress.
- **Two `readFilesFromPaths` implementations exist** (`chat/claudeUploadsDetector.ts` returning `DetectedFile[]`; `cli/commands/sdk/utils/file-utils.ts` returning SDK `File[]`) — these serve different purposes and must not be conflated during refactoring.
- **`gemini.conversations-processor.ts` hardcodes `file_names: []`**: if attachment names need to flow through the session processor (for session replay or metrics), this is a second integration point that may need updating; currently not part of the stated scope but is adjacent.
- **The `--file` flag lives on `codemie assistants chat`, not on `codemie-gemini` directly**: users must invoke `codemie assistants chat --agent gemini --file ...` rather than `codemie-gemini --file ...`. The gemini-skill-generator already documents this UX, but it may surprise users expecting agent-level flag parity. This is a scope/documentation decision, not a code gap.
- **No `--file` flag on `AgentCLI`**: the agent runner itself does not pass `--file` to the underlying subprocess. Adding file attachment to the agent runner level (so files can be sent mid-session via Gemini CLI itself) is out of scope for this task but is a follow-up gap.
- **`MAX_FILE_SIZE_MB` and `RECENT_MESSAGES_LIMIT` are undocumented constants**: requirement 3 (document constraints) requires these to be surfaced explicitly.

---

## 7. Summary for Complexity Assessment

This task touches three architectural layers: the CLI command layer (`src/cli/commands/assistants/chat/`), a new abstraction layer within that same directory, and the Gemini plugin layer (`src/agents/plugins/gemini/`). The estimated file change surface is 4–7 files: `chat/index.ts` (consumer update), `claudeUploadsDetector.ts` (interface implementation, `DetectedFile` export removal), `chat/types.ts` (add `DetectedFile`, `UploadsDetector` interface), one new `geminiUploadsDetector.ts`, one new test file for the Gemini detector, and potentially a factory/selector module. The `gemini.conversations-processor.ts` `file_names: []` hardcode is an adjacent concern that may or may not be in scope.

The technical implementation partially follows established patterns (the `DetectedFile` + `readFilesFromPaths` + `uploadFilesToCodeMie` pipeline already exists and is agent-neutral for the `--file` path), but the session-based auto-detection refactoring introduces novel design work: an `UploadsDetector` interface, a factory or strategy for selecting the right implementation at runtime, and a Gemini session detector that will likely be a no-op (returning empty) since Gemini CLI does not embed file blobs in session JSONL. This requires clear design decisions about whether the abstraction is worth the indirection when only Claude currently benefits from session auto-detection.

Test coverage posture is mixed. The Claude attachment path is well-tested in `claudeUploadsDetector.test.ts`, but `GeminiPlugin` has zero unit tests, `uploadFilesToCodeMie()` is not directly tested, and there is no integration test for the full `--file` flow. The refactoring must not break existing Claude tests (a concrete regression risk), and new tests for the Gemini detector and the abstraction interface must be written. Key risk factors for complexity scoring: (1) the refactoring touches a well-tested module that must not regress; (2) the Gemini plugin is untested today; (3) the "session auto-detection" value for Gemini is architecturally questionable (Gemini doesn't embed files in sessions), which may require a scope decision; (4) the `DetectedFile` extraction is a mechanical but cross-cutting change that touches multiple test files.
