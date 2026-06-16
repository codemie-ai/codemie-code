# BMAD SDLC Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless BMAD SDLC initialization preset that installs BMM plus TEA with the correct BMAD tool integration.

**Architecture:** Keep BMAD behavior inside `BmadPlugin` and expose only generic framework init options from `AgentCLI`. `BmadPlugin` builds the upstream `npx bmad-method install` arguments from CodeMie options, with `sdlc` as the recommended preset and an interactive escape hatch.

**Tech Stack:** TypeScript, Commander, Vitest, existing framework plugin registry.

---

### Task 1: BMAD Plugin Preset Behavior

**Files:**
- Create: `src/frameworks/plugins/bmad.plugin.test.ts`
- Modify: `src/frameworks/plugins/bmad.plugin.ts`

- [ ] **Step 1: Write failing tests**

Add tests that instantiate `BmadPlugin`, mock `npxRun`, and verify:
- default init runs `bmad-method install --yes --directory <cwd> --modules bmm,tea --tools claude-code --set core.output_folder=_bmad-output`
- `preset: "minimal"` installs only `bmm`
- `channel: "next"` uses package `bmad-method@next`
- `preset: "interactive"` preserves interactive installer behavior

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- src/frameworks/plugins/bmad.plugin.test.ts`

Expected: FAIL because the tests file or new behavior does not exist.

- [ ] **Step 3: Implement plugin changes**

Update `BmadPlugin` to parse init options, map CodeMie agent names to BMAD tool IDs, and call `npxRun` with non-interactive arguments by default.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- src/frameworks/plugins/bmad.plugin.test.ts`

Expected: PASS.

### Task 2: CLI Init Option Forwarding

**Files:**
- Modify: `src/agents/core/AgentCLI.ts`
- Test: CLI help or direct unit coverage if practical

- [ ] **Step 1: Add init command options**

Expose:
- `--preset <preset>`
- `--bmad-channel <channel>`
- `--bmad-modules <modules>`
- `--bmad-tools <tools>`
- `--bmad-set <key=value...>`
- `--interactive`

- [ ] **Step 2: Forward options into framework init**

Pass the parsed values through `FrameworkInitOptions` without changing other frameworks.

- [ ] **Step 3: Verify CLI help/build**

Run: `npm run build`

Expected: TypeScript build succeeds.

### Task 3: Documentation

**Files:**
- Modify: `docs/COMMANDS.md`

- [ ] **Step 1: Document BMAD init presets**

Add examples for `codemie-claude init bmad`, `--preset minimal`, and `--interactive`.

- [ ] **Step 2: Run targeted validation**

Run: `npm test -- src/frameworks/plugins/bmad.plugin.test.ts`

Expected: PASS.
