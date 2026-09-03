# Implementation Plan — EPMCDME-14674: Fix Gemini Agent Analytics Tracking

## Acceptance criteria
1. **JSONL Stream Support**: Support streaming/JSONL file discovery, header reading, and line-by-line parsing in `GeminiSessionAdapter`.
2. **Deduplicate turn-level messages**: Merge message fields (toolCalls, tokens, thoughts, model, content) in-place based on message `id` to prevent token double-counting.
3. **Robust Array prompt content extraction**: Parse user prompt text from strings, structured array content (`[{ text: "..." }]`), or nested responses defensively. Filter out internal `<session_context>` XML blocks.
4. **Serena MCP Tool Mapping**: Map Serena MCP tools (`mcp_serena_*`) to standard file operation types, resolving file paths and calculating line counts defensively across varied parameter structures.
5. **Dashed Pricing model lookup**: Populate `pricing.json` with standard dashed entries for `gemini-3-7-flash`, `gemini-3-5-flash`, and `gemini` models, as well as dotted aliases.
6. **Git Branch attribution**: Dynamically attribute git branch to deltas in `GeminiMetricsProcessor`.

---

## Tasks

### Task 1: Streaming `.jsonl` support and in-place message upserting in `GeminiSessionAdapter`
- **Test-first**: yes — Test that `parseSessionFile` parses a `.jsonl` stream, handles `$set` operators, and merges multiple stream chunks of identical `id` without duplicating messages or tokens.
- **Description**: Modify `src/agents/plugins/gemini/gemini.session-adapter.ts` to support both `.json` and `.jsonl` formats. Line-by-line stream parser with robust error logging, `$set.messages` processing, and in-place message indexing/upserting by `id`.

### Task 2: Advanced text extraction, branch attribution, and Serena MCP tool mapping in `GeminiMetricsProcessor`
- **Test-first**: yes — Test that user prompt extraction handles structured arrays and skips `<session_context>`, that `gitBranch` is correctly attributed, and that Serena MCP tools map to the correct file operation types with line counts.
- **Description**: Modify `src/agents/plugins/gemini/session/processors/gemini.metrics-processor.ts`. Extract branch from context/metadata. Implement `extractPromptText()` supporting strings/arrays. In `extractFileOperation()`, map `mcp_serena_*` tools and resolve arguments defensively.

### Task 3: Pricing table additions in `pricing.json`
- **Test-first**: yes — Test that `lookupPrice` correctly resolves prices for `gemini-3-7-flash`, `gemini-3-5-flash`, and `gemini` models.
- **Description**: Add standard dashed keys and dotted aliases for Gemini models in `src/utils/pricing.json`.

### Task 4: Automated Verification (Unit Tests)
- **Test-first**: yes — Test that running the vitest test suites verifies all requirements and passes.
- **Description**: Add unit tests in `src/agents/plugins/gemini/__tests__/gemini.session-adapter.test.ts`, `src/agents/plugins/gemini/session/processors/__tests__/gemini.metrics-processor.test.ts`, and update `src/utils/__tests__/pricing.test.ts`.
