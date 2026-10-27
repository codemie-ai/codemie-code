# STLC Factory Session Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Label sessions started by `/stlc-factory:*` skills and `/stlc-feature` as "STLC Factory" instead of "Pure chat".

**Architecture:** Add one entry to the ordered `SESSION_SOURCE_DETECTORS` array in the report layer, mirroring the sdlc-factory detector (namespaced prefix plus exact list for unnamespaced commands). Commit per task using the repository's existing convention.

**Spec:** `/Users/vponkratina/work/ai/codemie-code/docs/superpowers/tasks/2026-10-27-epmcdme-16435-stlc-factory-framework-label/spec.md`

## Global Constraints

- Detector name `stlc-factory`, label `STLC Factory`, placed after `superpowers` and before `openspec`.
- Match prefix `stlc-factory:` or exact name `stlc-feature`; no broad `stlc`/`stlc-` matching. Case-insensitive like existing detectors.
- No change to other detectors, fallback, OTLP adapter, client UI or `types.ts`.

## Review Focus

- A session with both `sdlc-factory:*` and `stlc-factory:*` names keeps "CodeMie AI Factory" (first match wins).
- Unrelated `stlc-other` command stays "Pure chat".

### Task 1: Add STLC Factory detector

**Files:**
- Modify: `src/cli/commands/analytics/report/session-source-detector.ts:48-60` (add `STLC_FACTORY_COMMANDS = ['stlc-feature']` next to `SDLC_FACTORY_COMMANDS`; insert a `{ name: 'stlc-factory', label: 'STLC Factory', matches }` entry between `superpowers` and `openspec`, using `hasPrefix(names, 'stlc-factory:') || hasExact(names, STLC_FACTORY_COMMANDS)`)
- Test: `src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts` (detector name list assertion near line 59)

Test-first: yes — a test that `detectSessionSource` returns "STLC Factory" for skill `stlc-factory:suite-health` and command `stlc-feature` fails (returns "Pure chat") before the detector exists.

- [ ] **Step 1:** Update the test file: change the expected detector name list to `['sdlc-factory','stlc-factory'...]` order `['sdlc-factory','superpowers','stlc-factory','openspec','speckit','bmad']`; add cases: `stlc-factory:exploratory`, `stlc-factory:stlc-foundation`, `stlc-factory:suite-health` (skill) and `stlc-feature` (command) yield `STLC Factory`; uppercase `STLC-Factory:X` matches; `sdlc-factory:x` plus `stlc-factory:y` yields "CodeMie AI Factory"; `stlc-other` yields "Pure chat". Run `npx vitest run src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts`; expect FAIL.
- [ ] **Step 2:** Implement the detector as described above. Re-run the same command; expect PASS.
