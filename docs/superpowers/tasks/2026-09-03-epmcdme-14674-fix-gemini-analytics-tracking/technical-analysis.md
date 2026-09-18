# Technical Research

**Task**: Fix Gemini Agent Analytics Tracking (EPMCDME-14674)
**Generated**: 2026-09-03
**Research path**: filesystem

---

## 1. Original Context
Gemini CLI sessions are logged as `.jsonl` files (representing a streaming turn append model). The current `GeminiSessionAdapter` is designed for single `.json` files, throwing `SyntaxError` when reading `.jsonl` streams. Additionally, user prompt text extraction fails to handle array prompt structures and internal `<session_context>` XML blocks. Serena MCP tools also need to be mapped to the standard file operation types. Finally, pricing table lacks canonical dash format entries for Gemini models.

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/plugins/gemini/gemini.session-adapter.ts`: Currently parses legacy single-JSON structures. Needs to support streaming `.jsonl` file line-by-line parsing, message upserting by `id` to prevent token double-counting, and support `type: 'gemini'`.
- `src/agents/plugins/gemini/session/processors/gemini.metrics-processor.ts`: Transforms message lists to metric deltas. Needs to handle array prompts, filter out `<session_context>` blocks, resolve `gitBranch`, and map Serena MCP tool names.
- `src/utils/pricing.json`: Pricing data for model tokens. Needs dashed key entries `gemini-3-7-flash`, `gemini-3-5-flash`, and `gemini`.

---

## 3. Documentation Findings
- `.ai-run/guides/architecture/architecture.md`
- `.ai-run/guides/standards/code-quality.md`

---

## 4. Testing Landscape
- `src/agents/plugins/gemini/__tests__/gemini.session-adapter.test.ts`
- `src/agents/plugins/gemini/session/processors/__tests__/gemini.metrics-processor.test.ts`
- `src/utils/__tests__/pricing.test.ts`

---

## 5. Configuration and Environment
- None.

---

## 6. Risk Indicators
- Streaming turn deduplication failure: Double-counting tokens, costs, and turns if multiple lines with identical message ID exist. Mitigated by in-place message upserts via `id` indexing in `parseSessionFile`.
- Stream corruption: Empty or whitespace lines, partial records throwing unhandled parsing exceptions. Mitigated by robust `try...catch` per line.

---

## 7. Summary for Complexity Assessment
Fixing Gemini Agent Analytics Tracking touches `GeminiSessionAdapter` for stream/JSONL parsing, `GeminiMetricsProcessor` for structured user content and Serena MCP tool mapping, and `pricing.json` for model lookup. Automated unit tests will be added for validation. Size is S/M.

---
