# Support Claude 5.5 Models Implementation Plan

**Goal:** Add complete support for Claude 5.5 generation models (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`) across Claude Desktop proxy connection, VS Code BYOK models, proxy request normalization, pricing, and agent compatibility.

**Architecture:** 
- Desktop connector: update `PREFERRED_CLAUDE_MODELS` and `selectDesktopClaudeModels` to prioritize 5.5 generation and collapse Opus, Sonnet, and Haiku families to their single highest-priority available model.
- VS Code connector: register `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5` capabilities in `VS_CODE_CAPABILITY_TABLE`.
- Proxy request normalizer: expand `MODEL_CAPABILITY_TABLE` in `claude-request-normalizer.plugin.ts` to support adaptive thinking and effort for Claude Opus 5/5.5, Sonnet 5/5.5, and Haiku 5/5.5.
- Pricing & compatibility: vendor `claude-haiku-5-5` pricing in `pricing.json` and enable `forceAdaptiveThinking` in `pi.models.ts`.

**Tech Stack:** TypeScript, Node.js (ESM), Vitest, Claude Messages API.

## Global Constraints

- Conventional Commits: `feat(proxy): add support for Claude 5.5 models in desktop and vscode connectors`
- Zero-warning policy on `npm run lint` and `npm run typecheck`
- Strict ESM import paths with `.js` extensions
- No breaking changes to existing model resolution for 4.x / 5.0 models

---

### Task 1: Update Claude Desktop Connector Models and Collapse Logic

**Test-first:** yes — verify `selectDesktopClaudeModels` selects 5.5 models first and collapses Haiku models when multiple exist

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- `PREFERRED_CLAUDE_MODELS`: readonly array of string IDs
- `selectDesktopClaudeModels(available: string[], preferred?: readonly string[]): string[]`

- [x] Step 1: Update tests in `desktop.test.ts` for preferred models and 5.5 resolution
- [x] Step 2: Update `PREFERRED_CLAUDE_MODELS` and `selectDesktopClaudeModels` in `desktop.ts`
- [x] Step 3: Run desktop connector tests and verify pass

---

### Task 2: Add Claude 5.5 Capabilities to VS Code Connector

**Test-first:** yes — verify `findVsCodeCapabilityEntry` resolves capability entries with adaptiveThinking for 5.5 models

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode-models.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/vscode-models.test.ts`

**Interfaces:**
- `VS_CODE_CAPABILITY_TABLE`: readonly array of `VsCodeCapabilityEntry`
- `findVsCodeCapabilityEntry(tenantId: string): VsCodeCapabilityEntry | undefined`

- [x] Step 1: Add unit tests in `vscode-models.test.ts`
- [x] Step 2: Register capability table entries in `vscode-models.ts`
- [x] Step 3: Run vscode-models tests and verify pass

---

### Task 3: Update Proxy Request Normalizer and Pi Agent Compatibility

**Test-first:** yes — verify normalizer converts thinking enabled to adaptive thinking with effort parameter for 5.5 models

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`
- Modify: `src/agents/plugins/pi/pi.models.ts`
- Modify: `src/utils/pricing.json`
- Test: `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`
- Test: `src/agents/plugins/pi/__tests__/pi.models.test.ts`
- Test: `tests/proxy-normalizer-body-contract.test.ts`

**Interfaces:**
- `MODEL_CAPABILITY_TABLE`: pattern-to-capabilities mapping
- `pricing.json`: cost mapping per model

- [x] Step 1: Add unit tests in `claude-request-normalizer.plugin.test.ts` and `pi.models.test.ts`
- [x] Step 2: Update `MODEL_CAPABILITY_TABLE` rows in `claude-request-normalizer.plugin.ts` with granular `preserveDisabledThinking` and `sampling: false` flags
- [x] Step 3: Update `pi.models.ts` for Haiku 5 adaptive thinking
- [x] Step 4: Add official rates for `claude-haiku-5-5` in `src/utils/pricing.json`
- [x] Step 5: Run normalizer and pricing tests and verify pass
