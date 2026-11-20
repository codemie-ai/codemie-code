# EPMCDME-16970 Hide sh.exe console window in injected shell hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop the console-window flash on Windows when injected hooks spawn `sh`.

**Architecture:** Add `windowsHide: true` to the two child-process option objects in the injected hook source template. No-op off Windows; no signature changes.

**Spec:** `docs/superpowers/tasks/2026-11-20-epmcdme-16970-fix-console-window-flash-in-windows/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Unconditional `windowsHide: true` (no `win32` check).
- Existing options (`detached`, `stdio`, `env`, `timeout`, ...) unchanged.
- Edits must remain valid inside the template string the source is embedded in.
- Do not touch `processes.ts`, `exec.ts`, or `shell-hooks-v2-source.ts`.

## Review Focus

- Generated hook source stays valid JavaScript (template-string escaping untouched).

### Task 1: Add windowsHide to both hook spawn sites

**Files:**
- Modify: `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts:202` (`execCommand()` `execSync` options)
- Modify: `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts:225-229` (`execCommandAsync()` `spawn("sh", ["-c", command], ...)` options)

Test-first: no — repo policy (AGENTS.md) permits tests only on explicit request, and none was requested; the spec lists adding tests as a non-goal.

- [ ] **Step 1:** Add `windowsHide: true` to the `execSync` options object at line ~202 and to the `spawn` options object at line ~225, leaving all other options and the surrounding template-string escaping as is.
