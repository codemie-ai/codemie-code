# Align Selection UI Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for inline implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align CodeMie custom terminal selection rows across setup flows.

**Architecture:** Add reusable row-formatting helpers to the shared selection UI module, then migrate custom renderers to those helpers. Keep Inquirer-owned prompts unchanged.

**Tech Stack:** TypeScript, Chalk, Vitest.

---

## File Structure

- Modify: `src/cli/commands/shared/selection/ui.ts` for shared row helpers.
- Create or modify: `src/cli/commands/shared/selection/__tests__/ui.test.ts` for helper tests.
- Modify: `src/cli/commands/assistants/setup/selection/ui.ts` for assistant list rows.
- Modify: `src/cli/commands/skills/setup/selection/ui.ts` for skill list rows.
- Modify: `src/cli/commands/shared/agent-targets.ts` for agent target rows.
- Modify: `src/cli/commands/assistants/setup/configuration/ui.ts` for setup mode rows.
- Modify: `src/cli/commands/assistants/setup/manualConfiguration/ui.ts` for manual configuration row cursor gutter.
- Modify: `src/cli/commands/shared/prompts/storage-scope.ts` for storage scope rows.
- Modify existing renderer tests where output assumptions need updating.

### Task 1: Shared Row Helpers

Test-first: yes - add tests showing cursor and marker gutters stay stable between selected/unselected and cursor/non-cursor rows.

- [ ] **Step 1: Write failing helper tests**

Add tests for a shared selectable row helper that assert:

```ts
expect(cursorSelected).toContain('› ◉ Alpha');
expect(noCursorSelected).toContain('  ◉ Alpha');
expect(cursorUnselected).toContain('› ◯ Alpha');
expect(noCursorUnselected).toContain('  ◯ Alpha');
expect(rowWithDescription).toContain('\n    Description');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/cli/commands/shared/selection/__tests__/ui.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement helper**

Add exported helpers in `src/cli/commands/shared/selection/ui.ts` for selectable rows, choice rows, detail indentation, and cursor gutter.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/cli/commands/shared/selection/__tests__/ui.test.ts`

Expected: PASS.

### Task 2: Migrate Full-Screen Multi-Select Lists

Test-first: yes - add/adjust assistant and skill renderer tests to verify rows and descriptions align through the shared helper.

- [ ] **Step 1: Write failing renderer tests**

Assert assistant and skill selected rows contain the same gutter pattern and that descriptions start with four spaces.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/cli/commands/assistants/setup/selection/__tests__/ui.test.ts src/cli/commands/skills/setup/selection/__tests__/ui.test.ts`

Expected: FAIL for the skill test if the file is newly added or helper expectations are not yet implemented.

- [ ] **Step 3: Migrate renderers**

Use the shared selectable row helper in assistant and skill list row rendering.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/cli/commands/assistants/setup/selection/__tests__/ui.test.ts src/cli/commands/skills/setup/selection/__tests__/ui.test.ts`

Expected: PASS.

### Task 3: Migrate Other Custom Selectors

Test-first: yes - add/adjust tests for setup configuration, manual configuration, storage scope, and agent target rendering where test seams exist.

- [ ] **Step 1: Write failing renderer tests**

Add assertions that custom selectors use the same cursor gutter and marker pattern without changing text.

- [ ] **Step 2: Run test to verify it fails**

Run targeted Vitest files for affected renderers.

Expected: FAIL before migration where shared row output differs.

- [ ] **Step 3: Migrate renderers**

Apply the shared row helper to agent target, configuration mode, manual configuration cursor gutter, and storage scope rows.

- [ ] **Step 4: Run test to verify it passes**

Run targeted Vitest files for affected renderers.

Expected: PASS.

### Task 4: QA

Test-first: no - validation task.

- [ ] **Step 1: Run focused tests**

Run: `npm run test:run -- <affected test files>`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Review diff**

Run: `git diff --stat` and inspect changed files for unrelated churn.

Expected: only task artifacts, shared selection UI, custom renderers, and focused tests changed.
