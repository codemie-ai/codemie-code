# Technical Research

**Task**: claude session bash-input logging conversations processor
**Generated**: 2026-07-30T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-13675 — codemie-claude does not log bash commands executed with ! prefix in the Claude session folder.

Bug description (verbatim from Jira):
When a user starts codemie-claude and executes shell commands in the current session using Claude Code syntax such as !ls -al or !ls -al (with trailing space), those commands should be captured as part of the session/action history. Currently, after running several bash commands and then asking a code-related question, Claude Code works correctly, but the expected log text is missing from the Codemie claude folder. This reduces traceability and makes it harder to audit what happened during a local AI coding session, especially when command execution is part of the troubleshooting or code-analysis workflow.

Preconditions:
- CodeMie CLI is installed and configured.
- codemie-claude is available and starts successfully.
- Claude Code is operational in the current environment.
- Session/action logging to the Codemie claude folder is expected to be enabled.

Steps to Reproduce:
1. Start codemie-claude.
2. In the current interactive session, execute bash commands several times, for example: !ls -al, !ls -al 
3. Ask a code-related question in the same session.
4. Verify that Claude Code responds and functions correctly.
5. Open/check the Codemie claude folder (~/.codemie/sessions/) where session/action log text is expected.
6. Observe whether the bash commands executed with ! are present in the log text.

Expected: Bash commands executed with ! inside the codemie-claude session are captured in the session/action log. The Codemie claude folder contains log text reflecting the executed bash commands and relevant session actions. Multiple bash commands in one session are captured in the correct order. A following code-related prompt does not cause previously executed bash command log entries to be lost. The log output clearly distinguishes user prompts, bash commands, and assistant responses.

Actual: No expected log text for the executed bash commands appears in the Codemie claude folder.

REPRO EVIDENCE (already gathered):
- Claude Code writes ! bash commands into the raw session JSONL at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl as user messages of the form:
    {"type":"user","message":{"role":"user","content":"<bash-input> ls -al</bash-input>"}, ...}
    {"type":"user","message":{"role":"user","content":"<bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr>"}, ...}
- The Codemie session artifacts live at ~/.codemie/sessions/<sessionId>_conversation.jsonl (payloads pending API sync).
- Running the ConversationsProcessor on synthetic bash-input turns:
  * Single !ls -al: produces a User entry, but the message field contains RAW <bash-input> XML instead of "!ls -al".
  * Several bash commands then a real code question: only the FIRST bash-input is captured; subsequent bash commands, the follow-up question, AND the assistant response are all silently dropped.

The processor lives at: src/agents/plugins/claude/session/processors/claude.conversations-processor.ts
The session adapter lives at: src/agents/plugins/claude/claude.session.ts
Existing processor tests live at: src/agents/plugins/claude/__tests__/claude.conversations-processor.test.ts

Working directory (repo root): /Users/Evgenii_Kurdakov/Desktop/projects/codemie-dev/codemie-code
Current branch: EPMCDME-13675

Focus areas for the technical analysis:
1. Trace the full data flow: how a user typing "!ls -al" in the codemie-claude session ends up (or fails to end up) in ~/.codemie/sessions/<sid>_conversation.jsonl.
2. Identify EVERY filter that acts on <bash-input> / <bash-stdout> / <bash-stderr> records: shouldFilterMessage, isSystemMessage, isConversationSplitter, isSyntheticUserPrompt, isToolResult, isMeta.
3. Explain the turn-splitting logic (transformMessages/transformTurn) with respect to how multiple bash-input user messages are grouped, and how this interacts with a following real user question.
4. Identify where <bash-input>/<bash-stdout> wrappers should ideally be unwrapped or represented differently so the log distinguishes user prompts from bash commands.
5. Note any existing patterns for handling similar "special" user message content (e.g., <local-command-caveat>, /clear splitters, <uploaded_files>) that could guide the fix.
6. Identify related unit tests (naming conventions, mocking style) so a follow-up plan can reuse them.
7. Call out risk indicators: incremental sync state (lastSyncedMessageUuid, lastSyncedHistoryIndex), turn continuation logic, and any interaction with sub-agent / stop-hook processing.

---

## 2. Codebase Findings

### Existing Implementations

Primary processor (the bug site):
- `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts` — `ClaudeConversationsProcessor`: reads raw Claude JSONL messages and writes conversation-history records to `~/.codemie/sessions/<sid>_conversation.jsonl`; contains all filter and transform logic including both bug sites
- `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` — `ClaudeMetricsProcessor`: extracts token/tool metrics from assistant messages; runs at priority 1 (before ConversationsProcessor at priority 2); has its own `isSyntheticUserPrompt` guard and uses `stripClear`
- `src/agents/plugins/claude/session/strip-clear.ts` — utility: given raw message array, removes all entries before the last `/clear` sentinel (`<command-name>/clear</command-name>`); imported by MetricsProcessor but NOT by ConversationsProcessor

Session adapter:
- `src/agents/plugins/claude/claude.session.ts` — `ClaudeSessionAdapter`: reads `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, dedupes by UUID (keeping LAST occurrence for duplicates — see architectural decision below), discovers sub-agent JSONL files, runs both processors in priority order, persists `lastSyncedMessageUuid`/`lastSyncedHistoryIndex` to SessionStore

Supporting files:
- `src/agents/plugins/claude/claude-message-types.ts` — TypeScript interfaces for raw Claude JSONL format (`ClaudeMessage`, `ContentItem`, etc.)
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — declares Claude Code lifecycle hook events: `SessionStart`, `SessionEnd`, `PermissionRequest`, `SubagentStop`, `Stop`, `UserPromptSubmit`, `PreCompact`
- `src/cli/commands/hook.ts` — hook event router: `Stop` and `SessionEnd` both call `performIncrementalSync()` → `sessionAdapter.processSession()`; `UserPromptSubmit` does activity tracking only (no `processSession` call)
- `src/agents/plugins/claude/claude.plugin.ts` — plugin metadata; `getSessionAdapter()` returns `new ClaudeSessionAdapter(ClaudePluginMetadata)`
- `src/providers/plugins/sso/session/BaseSessionAdapter.ts` — interfaces `ParsedSession`, `AggregatedResult`, `SessionAdapter` (contract implemented by `ClaudeSessionAdapter`)
- `src/agents/core/session/session-config.ts` — `getSessionConversationPath(sessionId)`: computes `$CODEMIE_HOME/sessions/<sid>_conversation.jsonl`; reads `CODEMIE_HOME` env var, defaults to `~/.codemie`

### Architecture and Layers Affected

Layer 1 — External / Claude Code (not modified): generates `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` with `<bash-input>` and `<local-command-stdout>` records; fires hook events via hooks.json

Layer 2 — Hook Router (`src/cli/commands/hook.ts`): receives hook event JSON on stdin; routes `Stop` and `SessionEnd` to `performIncrementalSync`; routing logic unchanged by this fix

Layer 3 — Session Adapter (`src/agents/plugins/claude/claude.session.ts`): reads JSONL, dedupes by UUID, discovers sub-agent files, orchestrates processors; unchanged by this fix unless multi-turn-per-invocation is chosen as the fix strategy

Layer 4 — Processor Registry (`BaseSessionAdapter` interface): unchanged

Layer 5 — ConversationsProcessor (`src/agents/plugins/claude/session/processors/claude.conversations-processor.ts`): PRIMARY BUG SITE; two functions require changes — `isSystemMessage()` and `extractUserMessage()`/`extractCommand()`

Layer 6 — SessionStore: persists `lastSyncedMessageUuid` and `lastSyncedHistoryIndex` across Stop/SessionEnd invocations; any fix must correctly advance these pointers

Layer 7 — Downstream API sync: on `SessionEnd`, the processed JSONL is uploaded and the local session file is renamed/finalized; this creates a hard deadline — messages not processed before `SessionEnd` completes are permanently lost

### Integration Points

Internal module dependencies (data flow):
```
hook.ts
  └── performIncrementalSync()
        └── ClaudeSessionAdapter.processSession()          [claude.session.ts]
              ├── reads ~/.claude/projects/.../*.jsonl     [external: Claude Code]
              ├── ClaudeMetricsProcessor.process()         [claude.metrics-processor.ts]
              │     └── stripClear()                       [strip-clear.ts]
              ├── ClaudeConversationsProcessor.process()   [claude.conversations-processor.ts]
              │     ├── shouldFilterMessage()
              │     │     ├── isSystemMessage()            [BUG 1 + BUG 2 root cause]
              │     │     ├── isConversationSplitter()
              │     │     ├── isToolResult()
              │     │     ├── isSyntheticUserPrompt()
              │     │     └── isMeta()
              │     ├── transformMessages()                [single-turn-per-call design]
              │     │     └── transformTurn()
              │     │           ├── extractUserMessage()
              │     │           │     ├── extractCommand() [BUG 1 site]
              │     │           │     └── extractUploadedFiles()
              │     │           └── extractAssistantMessage()
              │     └── writes ~/.codemie/sessions/<sid>_conversation.jsonl
              └── SessionStore.save(lastSyncedMessageUuid, lastSyncedHistoryIndex)
```

Type dependency direction:
- `claude-message-types.ts` → consumed by both processor files
- `BaseSessionAdapter.ts` (interfaces `ParsedSession`, `SessionAdapter`, `AggregatedResult`) → implemented by `claude.session.ts`
- `BaseProcessor.ts` (interfaces `SessionProcessor`, `ProcessingContext`) → implemented by both processor files
- `strip-clear.ts` → imported only by `claude.metrics-processor.ts`, NOT by ConversationsProcessor

External service connections: none within the processor; external API sync happens in the hook layer after processors complete.

### Patterns and Conventions

All of the following are existing handling patterns for "special" user message content. The bash-input fix should follow the same structural approach:

Pattern 1 — `isSystemMessage()` text-prefix filtering (lines ~577-596 of conversations-processor):
Filters messages whose text starts with specific hard-coded strings. Messages filtered here do not become `firstRealMessage` and do not consume a turn slot. Current recognized prefixes:
- `'Caveat: The messages below were generated by the user while running local commands'` — legacy local-command preamble
- `'<local-command-caveat>'` — XML form of the caveat
- `'Unknown slash command:'` — unknown `/cmd` feedback
- `'<local-command-stdout>'` — shell passthrough STDOUT
- `'[Request interrupted by user'` — user pressed Escape mid-generation

Also filters: messages containing a `/compact` or `/compress` slash command.

Notably absent: `'<bash-input>'` is NOT in this list. This absence is Bug 2's root cause.

Pattern 2 — `extractCommand()` slash command formatting (lines ~763-765):
Regex `/(<command-name>)(\/[^<]+)(<\/command-name>)/` extracts and returns slash commands like `/compact`. Returns `null` for anything else including `<bash-input>`. The null path causes `extractUserMessage()` to fall back to returning raw text verbatim. This absence is Bug 1's root cause.

Pattern 3 — `extractUploadedFiles()` XML unwrapping:
Scans content for `<uploaded_files>...</uploaded_files>` blocks; extracts file paths and surfaces them inline in the message text. This is the closest structural precedent for unwrapping XML-tagged content into a human-readable form — the bash-input fix should follow this same unwrapping approach.

Pattern 4 — `isConversationSplitter()`:
Detects `/clear` commands and creates a hard session boundary.

Pattern 5 — `isMeta()`:
Filters `msg.isMeta === true` records (file-attachment path injections from codemie UI).

Pattern 6 — `isSyntheticUserPrompt()`:
Filters automated/synthetic prompts where `parentUuid` points to a tool_result message.

Pattern 7 — Mid-turn system event tolerance (architectural comment at lines 271-275 and 318-322):
The turn-boundary scanner does NOT break on `system` type records because Claude Desktop interleaves `system` events (init, audit) inside a single turn. Breaking early would truncate the turn before the assistant's final reply. Any bash-input fix must respect this same constraint.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — defines the 5-layer architecture and processor/plugin placement; confirms `src/agents/plugins/claude/` is the correct Plugin Layer location; processors are an internal implementation detail of the adapter, not exposed to the plugin layer. Directly governs where the fix should be made.
- `.ai-run/guides/development/development-practices.md` — logging standards, TypeScript patterns (single quotes, `.js` import extensions, explicit return types, `async`/`await`); applies to all code written in the fix.
- `.ai-run/guides/testing/testing-patterns.md` — testing conventions governing how tests should be structured.
- `.ai-run/guides/standards/git-workflow.md` — PR and commit discipline.
- `.ai-run/guides/standards/code-quality.md` — code quality standards.

### Architectural Decisions

- Lines 271-275 and 318-322 of `claude.conversations-processor.ts`: explicit inline comment that the turn-end boundary scanner does not break on `system` records, because Claude Desktop interleaves `system` events inside turns. Breaking early truncates the turn before the assistant's final reply. Load-bearing decision — the bash-input fix must not change this behavior.
- Line 292 of `claude.conversations-processor.ts`: "Turn continuation: only emit the updated Assistant entry, not the User again" — intentional design to avoid duplicate User entries on re-syncs via `isTurnContinuation` flag.
- Lines 388-393 of `claude.conversations-processor.ts`: decision to surface uploaded file names inline in the message text rather than as `file_names` references — the reader API returns 500 on a plain file name. This is the structural template for the bash-input unwrapping fix.
- Lines 162-167 of `claude.session.ts`: decision to collapse duplicate-uuid records keeping the LAST occurrence, motivated by Claude Desktop re-writing the user message after session init/status events.
- Lines 38-39 of `claude.session.ts`: encapsulation boundary — processors are managed internally and not exposed to the plugin layer.
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` line 297: the analytics aggregator already knows about the local-command caveat boilerplate and skips it for session titles. Any fix must not log raw boilerplate text — only the actual command should be logged.

### Derived Conventions

- Processors run in declared priority order: MetricsProcessor (priority 1) then ConversationsProcessor (priority 2).
- `shouldProcess()` checks `CODEMIE_CONV_SYNC_DISABLED=1` as a kill switch before any processing begins.
- Processing is intentionally incremental: one turn per `processSession()` call, tracked via `lastSyncedMessageUuid` and `lastSyncedHistoryIndex`.
- A "turn" is bounded by: the `firstRealMessage` (first user message not filtered by `shouldFilterMessage`) up to (not including) the next unfiltered user message.
- `isToolResult` (pure tool_result array content) and `isSyntheticUserPrompt` (automated continuation prompt) are both silently skipped.
- The analytics layer already treats `<local-command-caveat>` boilerplate as noise — consistent with filtering or sanitizing it in the processor.

---

## 4. Testing Landscape

### Existing Coverage

Tests for `ClaudeConversationsProcessor` in `src/agents/plugins/claude/__tests__/claude.conversations-processor.test.ts` (3 tests total):
1. Mid-turn `system` events (subtype `init` and `audit`) do not truncate the assistant answer — guards the fix for the prior Claude Desktop regression
2. `<uploaded_files>` XML block is stripped; file basenames are surfaced inline in the user message; `file_names` array is empty
3. Plain string content user message with no attachments — `file_names: []`, message text preserved verbatim

Integration test: `tests/integration/session/incremental-conversation-processing.test.ts` — full pipeline via `ClaudeSessionAdapter.processSession()` using fixture JSONL files at `tests/integration/session/fixtures/claude/incremental-simple/turn-{1,2}.jsonl`; validates output JSONL structure, turn-continuation flag, history field completeness, subagent thoughts.

Adjacent processor tests:
- `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-clear.test.ts` — MetricsProcessor /clear sentinel stripping
- `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-names.test.ts` — MetricsProcessor named invocations (Skill, Task, slash-commands)

### Testing Framework and Patterns

Framework: Vitest `^4.1.5`; three named projects in `vitest.config.ts`: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts` excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts`). Coverage via v8. `globals: true` in unit and cli projects.

Unit test fixture pattern (inline POJO factories, no file I/O):
```ts
let clock = 0;
const ts = () => new Date(1700000000000 + clock++ * 1000).toISOString();
const user = (uuid, content) => ({ type: 'user', uuid, timestamp: ts(), message: { role: 'user', content } });
const assistant = (uuid, content) => ({ type: 'assistant', uuid, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: content }] } });
const system = (uuid, subtype = 'init') => ({ type: 'system', subtype, uuid, timestamp: ts() });
```

Private method access pattern (used to test `transformMessages` directly):
```ts
(proc as any).transformMessages(messages, { lastSyncedHistoryIndex: -1 }, 'assistant-id', 'claude', undefined)
```

Logger always mocked:
```ts
vi.mock('../../../../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
```

MetricsProcessor tests use a different pattern (real temp dir + `vi.resetModules()` + dynamic import) — not relevant for the conversations processor fix.

Integration tests use real fixture JSONL files under `tests/integration/session/fixtures/`.

### Coverage Gaps

All of the following gaps are directly relevant to the bash-input bug:

1. No test for `<bash-input>` message content in any form — neither the unwrapping to `!<command>` format (Bug 1) nor its filtering behavior (Bug 2)
2. No test for the full bash-input sequence: `isMeta=true` caveat message + `<bash-input>` command message + `<local-command-stdout>` output message as a 3-message group
3. No test for `isMeta: true` filtering path — verifying that an `isMeta=true` user message is skipped while a following real user message is still found as `firstRealMessage`
4. No test for multi-turn scenario: bash-input followed by a real user question — expected behavior is that the real question becomes the User history entry
5. No test for `<local-command-stdout>` pattern matching in `isSystemMessage`
6. No test for `isSyntheticUserPrompt` filter path
7. No test for `[Request interrupted by user` pattern in `isSystemMessage`
8. No integration fixture covering a session where `!` commands precede an LLM exchange

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides the base data directory (default `~/.codemie`); changes where `sessions/` is written; defined in `src/utils/paths.ts:getCodemieHome()`
- `CODEMIE_CONV_SYNC_DISABLED=1` — gates `ConversationsProcessor.shouldProcess()` (line 41 of conversations-processor); if set, no `_conversation.jsonl` is written at all; also auto-set by `AgentCLI` on external-session resume (`--resume` with a foreign session ID)
- `CODEMIE_METRICS_DISABLED=1` — disables MetricsProcessor only; no effect on conversation logging
- `CODEMIE_DEBUG=1` / `CODEMIE_DEBUG=true` — enables debug-level logging
- `CODEMIE_PROFILE_CONFIG` / `CODEMIE_PROFILE_NAME` — profile JSON; affects `claudeAutocompactPct` but not session logging

Claude-specific env vars set by the plugin at `beforeRun` (informational):
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
- `CLAUDE_CODE_ENABLE_TELEMETRY=0`
- `DISABLE_AUTOUPDATER=1`
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` — proxy/model routing

### Configuration Files

- `config.example.json` — top-level user-facing config: provider, baseUrl, apiKey, model, timeout, debug flag, allowedDirs, ignorePatterns; no session-logging toggle
- `src/agents/plugins/claude/plugin/hooks/hooks.json` — Claude Code lifecycle hooks; `Stop` and `SessionEnd` trigger `processSession`; no `PreToolUse`/`PostToolUse` hooks exist for bash passthrough commands

### Feature Flags and Deployment Concerns

No feature flags control bash-input logging specifically. All filtering logic is hardcoded in `isSystemMessage()`. The fix is a pure code change to the processor; no config file or env var changes are needed.

Deployment concern: `CODEMIE_CONV_SYNC_DISABLED` is automatically set on external-session resume — this means replaying bash-input processing for resumed sessions is already disabled at the platform level and is not affected by this fix.

---

## 6. Risk Indicators

- `<bash-input>` absent from `isSystemMessage()` pattern list: this single omission causes both bugs simultaneously — raw XML in logged messages (Bug 1) and subsequent turn starvation (Bug 2). The fix to `isSystemMessage()` is the highest-leverage change.
- Single-turn-per-invocation design in `transformMessages()`: `processSession()` is called at most twice per session (`Stop` hook + `SessionEnd` hook). With N bash commands before a real question, N+1 invocations are needed to reach the real LLM turn. If N > 1, the real question and its assistant response are permanently lost when the session is finalized on `SessionEnd`. This is the mechanism of Bug 2.
- Session finalization hard deadline: on `SessionEnd`, after `processSession()` returns, the local JSONL is renamed and uploaded. Messages not processed before this point are permanently lost. The fix must ensure all pending turns are drained within the two available invocations, OR the fix must choose not to log bash commands separately (only log real LLM turns) to avoid the N+1 problem entirely.
- `lastSyncedMessageUuid` / `lastSyncedHistoryIndex` sync state: any fix that changes which messages are treated as `firstRealMessage` will change which UUID is written to `lastSyncedMessageUuid` after a Stop-hook run. If bash-input messages are added to `isSystemMessage()`, the pointer will now advance past all consecutive bash commands to the first real user question — a behavioral change in sync state advancement. Must be verified against the turn-continuation path.
- `isTurnContinuation` flag and duplicate emission: if the same turn is partially synced at `Stop` and then completed at `SessionEnd`, the `isTurnContinuation` flag controls whether the User entry is re-emitted. Changes to `firstRealMessage` detection may affect which entry is considered the "same" turn on continuation. Covered by line 292 comment but not by any test.
- Mid-turn `system` event tolerance (lines 271-275, 318-322): the turn-boundary scanner does not break on `system` records by design. Any modification to `shouldFilterMessage()` or the scanner loop must not change this behavior — there is one test covering this scenario and it must remain green.
- `<bash-stderr>` is unhandled and unmentioned in `isSystemMessage()`: the repro evidence references `<bash-stderr>` alongside `<bash-stdout>`, but the processor has no handler for it. The fix should account for stderr records too.
- Analytics aggregator skips caveat boilerplate (confirmed in aggregator test line 297): the fix must not log raw `<local-command-caveat>` or caveat prose text — only sanitized command text (e.g., `!ls -al`) should appear in the conversation log. Raw XML in logged output would propagate downstream.
- No tests for the `<bash-input>` path, `isMeta` filter, `isSyntheticUserPrompt` filter, or `<local-command-stdout>` pattern: the affected code paths are entirely untested. Any fix must be accompanied by new unit tests covering all scenarios listed in Section 4, including the multi-bash-then-real-question scenario.
- Sub-agent interaction: `claude.session.ts` discovers sub-agent JSONL files and processes them through the same processor pipeline. If a sub-agent session contains bash-input records, the same bugs apply. The fix must be verified to work correctly for sub-agent sessions as well.

---

## 7. Summary for Complexity Assessment

The bug has two distinct root causes, both located in a single method boundary within `ClaudeConversationsProcessor`. Bug 1 (raw XML in logged message) originates in `extractCommand()` at approximately line 763: the function's regex only recognizes `<command-name>/slash-cmd</command-name>` patterns and returns `null` for `<bash-input>` content, causing `extractUserMessage()` to fall back to returning the raw XML string verbatim. The fix is a small targeted addition — a new regex branch in `extractCommand()` or `extractUserMessage()` that matches `<bash-input>(.*)</bash-input>` and returns `!<command>`. Bug 2 (subsequent turns dropped) originates in `isSystemMessage()`: `<bash-input>` is absent from its hard-coded prefix list, so bash-command messages are not filtered and each one consumes the processor's single-turn-per-invocation slot. With N bash commands before a real LLM question, the real question is never reached within the two available processing opportunities (Stop + SessionEnd hooks). The fix requires adding `'<bash-input>'` to the `isSystemMessage()` pattern list. The same should be done for `<bash-stderr>` which is also unhandled. Together, these two changes (add a pattern to `isSystemMessage`, add an unwrapping branch in `extractUserMessage`) are confined to `claude.conversations-processor.ts` and affect approximately 15-25 lines of code. No changes to the session adapter, hook router, or downstream sync layer are required.

The primary complexity risk is in the interaction between the fix and the incremental sync state machine (`lastSyncedMessageUuid`, `lastSyncedHistoryIndex`, `isTurnContinuation`). Adding `<bash-input>` to `isSystemMessage()` will change which UUID is written as `lastSyncedMessageUuid` after a Stop-hook run — the pointer now advances past all consecutive bash commands to the first real LLM question. This must be verified to not corrupt the turn-continuation logic on the subsequent SessionEnd hook call. The architectural comment at lines 271-275 and 318-322 (do not break on `system` records during turn-boundary scanning) is load-bearing and must remain intact. The existing test for mid-turn system events is the safety net for this constraint.

Test coverage posture is poor for the affected paths: of the three existing unit tests for `ClaudeConversationsProcessor`, none exercises `<bash-input>` content, `isMeta` filtering, `isSyntheticUserPrompt`, or the multi-turn scenario where bash commands precede a real question. The fix must be accompanied by at minimum: (1) a test for single `<bash-input>` unwrapping to `!ls -al` format, (2) a test for `<bash-input>` being filtered from `firstRealMessage` detection so the following real question is captured, (3) a test for the multi-bash-then-real-question scenario end-to-end through `transformMessages`, and (4) a test verifying `<local-command-stdout>` and `<bash-stderr>` records are filtered without affecting the surrounding turn. These can be implemented using the existing inline POJO factory pattern (no file I/O required) and the `(proc as any).transformMessages()` private-access technique already established in the test file.
