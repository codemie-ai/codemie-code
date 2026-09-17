# Fix Proxy Desktop Vertex-Only Claude Models

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or inline TDD per task.

**Goal:** Allow `codemie proxy connect desktop` to succeed when the local proxy exposes only Vertex-hosted Claude model IDs (e.g. `claude-sonnet-4-6-vertex`).

**Architecture:** Keep prefer-non-vertex behavior for mixed catalogs; fall back to vertex IDs when no canonical Claude models exist. Extend preferred-model curation to resolve `{preferred}-vertex` after exact and dated matches.

**Tech Stack:** TypeScript, Vitest, Claude Desktop proxy connector

---

### Task 1: Vertex fallback in `fetchClaudeModels`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

Test-first: yes — vertex-only `/v1/llm_models` response returns vertex Claude IDs; mixed response still excludes vertex when canonical IDs exist.

- [ ] Add failing tests for vertex-only and mixed responses
- [ ] Implement prefer-non-vertex, fallback-to-vertex logic
- [ ] Run desktop connector unit tests (GREEN)

### Task 2: Vertex suffix in `selectPreferredClaudeModels`

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

Test-first: yes — preferred `claude-sonnet-4-6` resolves to `claude-sonnet-4-6-vertex` when only vertex variant is available.

- [ ] Add failing test for vertex suffix fallback
- [ ] Add `${name}-vertex` resolution after dated fallback
- [ ] Run desktop connector unit tests (GREEN)

### Task 3: End-to-end `writeDesktopConfig` for vertex-only tenant

**Files:**
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

Test-first: yes — vertex-only mock succeeds and writes vertex IDs into `inferenceModels`.

- [ ] Add integration-style test with client-like model list
- [ ] Verify no regression in existing happy-path test
- [ ] Run desktop connector unit tests (GREEN)
