# Fix Duplicate Model ID in Claude Model Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `autoSelectModelTiers()` from assigning an opus model ID to the `sonnetModel` tier, eliminating the duplicate-ID display in the Claude Code model selector.

**Architecture:** Add a keyword guard in `autoSelectModelTiers()` (`setup.ts`) so `sonnetModel` is only populated when the selected model is not opus- or haiku-class; if no sonnet-class model is provisioned `sonnetModel` is left unset. Separately, deduplicate model IDs in `fetchCodeMieModels()` to guard against backend duplicates. Export the currently-private function so the test file can call it directly instead of duplicating the algorithm.

**Tech Stack:** TypeScript, Node.js ≥ 20, Vitest

## Global Constraints

- ES modules throughout; all imports must include `.js` extension.
- No `require()`, no `__dirname` — use `getDirname(import.meta.url)` when needed.
- `@/` alias for deep imports.
- No `any` in new code; explicit return types on any new exports.
- Keyword-based tier classification: `includes('haiku')`, `includes('opus')` — match the existing pattern.
- `sonnetModel` must be left **unset** (not assigned the opus ID) when no sonnet-class model is provisioned (per EPMCDME-12779 AC).
- Tests only on explicit request — this plan exists under an explicit "write tests" context (TDD flow).
- No placeholder TODOs.

---

### Task 1: Export `autoSelectModelTiers` and helper functions, add failing regression test

**Files:**
- Modify: `src/cli/commands/setup.ts` (add `export` to `autoSelectModelTiers`, `parseModelVersion`, `compareModelVersions`, `selectLatestModel`)
- Modify: `src/cli/commands/__tests__/model-tier-auto-selection.test.ts` (import from source, add failing test)

**Interfaces:**
- Produces: `export async function autoSelectModelTiers(models: string[], selectedModel: string): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }>`
- Produces: `export function parseModelVersion(modelName: string): number[]`
- Produces: `export function compareModelVersions(a: string, b: string): number`
- Produces: `export function selectLatestModel(models: string[]): string | undefined`

- [ ] **Step 1: Export the four functions in `setup.ts`**

In `src/cli/commands/setup.ts`, find each of the four function declarations and add the `export` keyword. The functions are at approximately:
- `function parseModelVersion` (search for the line)
- `function compareModelVersions`
- `function selectLatestModel`
- `async function autoSelectModelTiers`

Change each from:
```typescript
function parseModelVersion(modelName: string): number[] {
```
to:
```typescript
export function parseModelVersion(modelName: string): number[] {
```

```typescript
function compareModelVersions(a: string, b: string): number {
```
to:
```typescript
export function compareModelVersions(a: string, b: string): number {
```

```typescript
function selectLatestModel(models: string[]): string | undefined {
```
to:
```typescript
export function selectLatestModel(models: string[]): string | undefined {
```

```typescript
async function autoSelectModelTiers(
  models: string[],
  selectedModel: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }> {
```
to:
```typescript
export async function autoSelectModelTiers(
  models: string[],
  selectedModel: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }> {
```

- [ ] **Step 2: Update `model-tier-auto-selection.test.ts` — replace local duplicates with imports**

Replace the top of the test file (lines 1–65, the local duplicate implementations) with imports from `setup.ts`. The file currently starts with comment block then four local function definitions. Replace everything before line 67 (the first `describe` block) with:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseModelVersion,
  compareModelVersions,
  selectLatestModel,
  autoSelectModelTiers,
} from '../setup.js';
```

- [ ] **Step 3: Add the failing regression test**

At the end of the `describe('autoSelectModelTiers integration'` block (after line 383, before the closing `}`), add:

```typescript
  describe('opus-only tenant — bug EPMCDME-12779', () => {
    it('should not set sonnetModel when selectedModel is opus-class', async () => {
      const models = ['claude-opus-4-6-20260205'];
      const result = await autoSelectModelTiers(models, 'claude-opus-4-6-20260205');
      expect(result.sonnetModel).toBeUndefined();
      expect(result.opusModel).toBe('claude-opus-4-6-20260205');
    });

    it('should not set sonnetModel when selectedModel contains opus keyword', async () => {
      const models = ['claude-opus-4-7', 'claude-haiku-4-5-20251001'];
      const result = await autoSelectModelTiers(models, 'claude-opus-4-7');
      expect(result.sonnetModel).toBeUndefined();
      expect(result.opusModel).toBe('claude-opus-4-7');
      expect(result.haikuModel).toBe('claude-haiku-4-5-20251001');
    });

    it('should set sonnetModel normally when selectedModel is sonnet-class', async () => {
      const models = ['claude-sonnet-4-6', 'claude-opus-4-6-20260205', 'claude-haiku-4-5-20251001'];
      const result = await autoSelectModelTiers(models, 'claude-sonnet-4-6');
      expect(result.sonnetModel).toBe('claude-sonnet-4-6');
      expect(result.opusModel).toBe('claude-opus-4-6-20260205');
      expect(result.haikuModel).toBe('claude-haiku-4-5-20251001');
    });
  });
```

- [ ] **Step 4: Run the new tests — expect RED on the opus-only cases**

```bash
npx vitest run src/cli/commands/__tests__/model-tier-auto-selection.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: the two `opus-only tenant` tests that assert `sonnetModel` is `undefined` **FAIL** (because the current code assigns `selectedModel` unconditionally). The third test (`sonnet-class`) should pass if imports work correctly.

- [ ] **Step 5: Commit exports + failing tests**

```bash
git add src/cli/commands/setup.ts src/cli/commands/__tests__/model-tier-auto-selection.test.ts
git commit -m "test(setup): export autoSelectModelTiers, add failing regression for opus-only tenant (EPMCDME-12779)"
```

---

### Task 2: Fix `autoSelectModelTiers` — guard opus/haiku from sonnet tier

**Files:**
- Modify: `src/cli/commands/setup.ts` lines 624–631 (sonnet-tier block inside `autoSelectModelTiers`)

**Interfaces:**
- Consumes: exported `autoSelectModelTiers` from Task 1
- Produces: same signature, corrected behaviour: `sonnetModel` is unset when `selectedModel` is opus- or haiku-class

- [ ] **Step 1: Apply the keyword guard**

In `src/cli/commands/setup.ts`, locate the sonnet-tier block (currently lines 624–631):

```typescript
  // Use selected model as sonnet tier (or env var if set)
  if (envSonnet) {
    result.sonnetModel = envSonnet;
    logger.debug('Using sonnet model from environment variable', { model: envSonnet });
  } else {
    result.sonnetModel = selectedModel;
    logger.debug('Using selected model as sonnet tier', { model: selectedModel });
  }
```

Replace with:

```typescript
  // Use selected model as sonnet tier only when it is not opus- or haiku-class.
  // When a tenant provisions only opus models the selected model will be opus;
  // assigning it to sonnetModel would cause both tiers to display the same ID
  // in the Claude Code selector (EPMCDME-12779).
  if (envSonnet) {
    result.sonnetModel = envSonnet;
    logger.debug('Using sonnet model from environment variable', { model: envSonnet });
  } else if (
    !selectedModel.toLowerCase().includes('opus') &&
    !selectedModel.toLowerCase().includes('haiku')
  ) {
    result.sonnetModel = selectedModel;
    logger.debug('Using selected model as sonnet tier', { model: selectedModel });
  }
```

- [ ] **Step 2: Run the regression tests — expect GREEN**

```bash
npx vitest run src/cli/commands/__tests__/model-tier-auto-selection.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass, including the three new `opus-only tenant` tests.

- [ ] **Step 3: Run the full unit test suite to check for regressions**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 4: Commit the fix**

```bash
git add src/cli/commands/setup.ts
git commit -m "fix(setup): guard autoSelectModelTiers against opus model ID assigned to sonnet tier (EPMCDME-12779)"
```

---

### Task 3: Deduplicate model IDs in `fetchCodeMieModels`

**Files:**
- Modify: `src/providers/plugins/sso/sso.http-client.ts` (lines 150–168, the `filteredModels` pipeline)

**Interfaces:**
- Produces: same `string[]` return from `fetchCodeMieModels`, with duplicate IDs removed

- [ ] **Step 1: Add a `Set`-based dedup stage to the filter pipeline**

In `src/providers/plugins/sso/sso.http-client.ts`, locate the `filteredModels` block (lines 150–168):

```typescript
  // Filter and map models based on the actual API response structure
  const filteredModels = models
    .filter(model => {
      if (!model) return false;
      // Check for different possible model ID fields
      const hasId = model.id && model.id.trim() !== '';
      const hasBaseName = model.base_name && model.base_name.trim() !== '';
      const hasDeploymentName = model.deployment_name && model.deployment_name.trim() !== '';

      return hasId || hasBaseName || hasDeploymentName;
    })
    .map(model => {
      // Use the most appropriate identifier field
      return model.id || model.base_name || model.deployment_name || model.label || 'unknown';
    })
    .filter(id => id !== 'unknown')
    .sort();
```

Replace with:

```typescript
  // Filter and map models based on the actual API response structure
  const seen = new Set<string>();
  const filteredModels = models
    .filter(model => {
      if (!model) return false;
      const hasId = model.id && model.id.trim() !== '';
      const hasBaseName = model.base_name && model.base_name.trim() !== '';
      const hasDeploymentName = model.deployment_name && model.deployment_name.trim() !== '';
      return hasId || hasBaseName || hasDeploymentName;
    })
    .map(model => model.id || model.base_name || model.deployment_name || model.label || 'unknown')
    .filter(id => id !== 'unknown')
    .filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort();
```

- [ ] **Step 2: Run the unit test suite**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass (no test covers `fetchCodeMieModels` dedup yet, but no regressions).

- [ ] **Step 3: Commit the dedup fix**

```bash
git add src/providers/plugins/sso/sso.http-client.ts
git commit -m "fix(sso): deduplicate model IDs in fetchCodeMieModels to guard against backend duplicates (EPMCDME-12779)"
```

---

### Task 4: Update design document to reflect corrected behaviour

**Files:**
- Modify: `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md`

**Interfaces:**
- Consumes: corrected `autoSelectModelTiers` behaviour from Task 2

- [ ] **Step 1: Update the Sonnet Tier description**

In `docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md`, locate "2. **Sonnet Tier**: User's selected model" under "Priority 2: Automatic Selection from Available Models" and replace that bullet's body:

Before:
```
2. **Sonnet Tier**: User's selected model
   - Use the model the user selected during setup
   - This is the default/main model for the profile
   - Example: `claude-sonnet-4-6`
```

After:
```
2. **Sonnet Tier**: User's selected model (when it is sonnet-class)
   - Use the model the user selected during setup, **provided it is not opus- or haiku-class**
   - If the user selected an opus or haiku model (e.g. on a tenant that only provisions opus), `sonnetModel` is left unset
   - Example: `claude-sonnet-4-6`
```

- [ ] **Step 2: Add Scenario 5 — opus-only tenant**

Append a new scenario after "Scenario 4: Future Claude Versions":

```markdown
### Scenario 5: Opus-only Tenant (Bug Fix — EPMCDME-12779)

Available models:
- `claude-opus-4-6-20260205` (user selects this — only model available)

Result:
- Haiku: unset (no haiku-class model available)
- Sonnet: **unset** (selected model is opus-class — not assigned to prevent duplicate display)
- Opus: `claude-opus-4-6-20260205`

The Claude Code binary will show only "Custom Opus model" — not a duplicate "Custom Sonnet model" pointing to the same ID.
```

- [ ] **Step 3: Commit the doc update**

```bash
git add docs/CLAUDE_MODEL_TIER_AUTO_SELECTION.md
git commit -m "docs(setup): update model tier auto-selection doc for opus-only tenant behaviour (EPMCDME-12779)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Each model label maps to a unique model ID — guarded in `autoSelectModelTiers` (Task 2)
- ✅ Duplicate model IDs must not appear under separate names — `fetchCodeMieModels` dedup (Task 3)
- ✅ If Sonnet is not provisioned, it is not listed — `sonnetModel` left unset (Task 2)
- ✅ If Opus is listed, it is listed only once under the correct label — `opusModels` filter already picks latest opus; dedup in Task 3 guards the data source
- ✅ Validated against tenant/model-provisioning config — fix operates on the models list returned by the gateway

**Placeholder scan:** No TODOs, TBDs, or "add appropriate" phrases. All code steps are complete.

**Type consistency:** `autoSelectModelTiers` signature unchanged; new `export` keywords do not alter the types. `seen: Set<string>` — consistent with TypeScript generics.
