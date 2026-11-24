# Support Claude 5.5 Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete support for Claude 5.5 generation models (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`) across Claude Desktop proxy connection, VS Code BYOK models, proxy request normalization, pricing, and agent compatibility.

**Architecture:** 
- Desktop connector: update `PREFERRED_CLAUDE_MODELS` and `selectDesktopClaudeModels` to prioritize 5.5 generation and collapse Opus, Sonnet, and Haiku families to their single highest-priority available model.
- VS Code connector: register `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5` capabilities in `VS_CODE_CAPABILITY_TABLE`.
- Proxy request normalizer: expand `MODEL_CAPABILITY_TABLE` in `claude-request-normalizer.plugin.ts` to support adaptive thinking and effort for Claude Opus 5/5.5 and Haiku 5.5.
- Pricing & compatibility: vendor `claude-haiku-5-5` pricing in `pricing.json` and enable `forceAdaptiveThinking` in `pi.models.ts`.

**Tech Stack:** TypeScript, Node.js (ESM), Vitest, Claude Messages API.

**Spec:** User request to add support for Claude 5.5 models in `codemie-code`.

## Global Constraints

- Conventional Commits: `feat(proxy): add support for Claude 5.5 models in desktop and vscode connectors`
- Zero-warning policy on `npm run lint` and `npm run typecheck`
- Strict ESM import paths with `.js` extensions
- No breaking changes to existing model resolution for 4.x / 5.0 models

## Review Focus

1. `selectDesktopClaudeModels` collapses each of Opus, Sonnet, and Haiku families to exactly one model (the highest available priority).
2. Existing 4.x/5.0 fallbacks remain intact when a gateway lacks 5.5 models.
3. Proxy request normalizer transforms thinking to adaptive + effort for `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`.
4. `VS_CODE_CAPABILITY_TABLE` entries match Messages API contracts with reasoning effort support.
5. All tests in touched areas pass and pre-commit checks succeed.

---

### Task 1: Update Claude Desktop Connector Models and Collapse Logic

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- `PREFERRED_CLAUDE_MODELS`: readonly array of string IDs
- `selectDesktopClaudeModels(available: string[], preferred?: readonly string[]): string[]`

- [x] **Step 1: Update tests in `desktop.test.ts` for preferred models and 5.5 resolution**
  - Update 5xx fallback test expectation to include 5.5 models.
  - Add unit test for `selectDesktopClaudeModels` verifying 5.5 models take precedence when available.
  - Verify haiku collapse to single highest available model.

- [x] **Step 2: Update `PREFERRED_CLAUDE_MODELS` and `selectDesktopClaudeModels` in `desktop.ts`**
  - Prepend `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5` at the head of their families in `PREFERRED_CLAUDE_MODELS`.
  - Add `haikuKept` to `selectDesktopClaudeModels` to ensure Haiku family collapses to single best model.

- [x] **Step 3: Run desktop connector tests and verify pass**

---

### Task 2: Add Claude 5.5 Capabilities to VS Code Connector

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-models.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`

**Interfaces:**
- `VS_CODE_CAPABILITY_TABLE`: readonly array of `VsCodeCapabilityEntry`
- `findVsCodeCapabilityEntry(tenantId: string): VsCodeCapabilityEntry | undefined`

- [x] **Step 1: Add unit tests in `vscode-models.test.ts`**
  - Test `findVsCodeCapabilityEntry('claude-sonnet-5-5')`
  - Test `findVsCodeCapabilityEntry('claude-opus-5-5')`
  - Test `findVsCodeCapabilityEntry('claude-haiku-5-5')`

- [x] **Step 2: Register capability table entries in `vscode-models.ts`**
  - Add entries for `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5` with `messages` apiType, adaptiveThinking, and reasoning efforts.

- [x] **Step 3: Run vscode-models tests and verify pass**

---

### Task 3: Update Proxy Request Normalizer and Pi Agent Compatibility

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`
- Modify: `src/agents/plugins/pi/pi.models.ts`
- Modify: `src/utils/pricing.json`
- Test: `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`

**Interfaces:**
- `MODEL_CAPABILITY_TABLE`: pattern-to-capabilities mapping
- `pricing.json`: cost mapping per model

- [x] **Step 1: Add unit tests in `claude-request-normalizer.plugin.test.ts`**
  - Test `claude-opus-5-5` and `claude-haiku-5-5` adaptive thinking transformation.

- [x] **Step 2: Update `MODEL_CAPABILITY_TABLE` in `claude-request-normalizer.plugin.ts`**
  - Configure granular capability flags: `claude-opus-5-5` and `claude-sonnet-5-5` omit disabled thinking to prevent upstream 400s; `claude-opus-5` and `claude-haiku-5-5` preserve disabled thinking.
  - Disable sampling for all 5.x Claude models to strip manual sampling params.

- [x] **Step 3: Update `pi.models.ts` and `pricing.json`**
  - Add `id.startsWith('claude-haiku-5')` to `forceAdaptiveThinking` check in `pi.models.ts`.
  - Add `claude-haiku-5-5` rate entry to `pricing.json`.

- [x] **Step 4: Run normalizer and pricing tests and verify pass**

---

### Task 4: Git Branch, Commit, Verification & Pull Request Creation

**Files:**
- All touched files

- [x] **Step 1: Run typecheck and linting**
  - `npm run typecheck`
  - `npm run lint`

- [x] **Step 2: Create feature branch and commit changes**
  - Branch: `feat/support-claude-5-5-models`
  - Commit message following Conventional Commits: `feat(proxy): add support for Claude 5.5 models in desktop and vscode connectors`

- [x] **Step 3: Push branch to remote and create Pull Request**
  - Push to `origin feat/support-claude-5-5-models`
  - Create Pull Request with detailed description and checklist.
