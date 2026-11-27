## Acceptance criteria

- A CodeMie-managed session (`CODEMIE_SESSION_ID` set) shows a `[CodeMie ●]` segment as the first segment of the statusline: brackets and "CodeMie" dim purple, the dot (U+25CF) green.
- A plain `claude` session (no `CODEMIE_SESSION_ID`) renders exactly as before; project name is still first.
- README example and `STATUSLINE_DESCRIPTION` mention the segment.

# CodeMie Statusline "[CodeMie ●]" Segment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a persistent leading `[CodeMie ●]` segment in the Claude statusline for CodeMie-managed sessions only (Jira EPMCDME-16966).

**Architecture:** `buildStatusLine` stays pure; it gains a `managed` flag and pushes the segment first. `main()` derives the flag from `process.env.CODEMIE_SESSION_ID` (same discriminator as `launchMode()` in `src/agents/core/evidence/routing.ts:54`; no import, the script is standalone).

**Tech Stack:** TypeScript, Vitest.

**Spec:** none (requirements inline; see Acceptance criteria).

## Global Constraints

- Commit per task using the repository's existing convention (Conventional Commits, ticket `EPMCDME-16966` per `.ai-run/guides/standards/git-workflow.md`). No pushes.
- Segment plain text is exactly `[CodeMie ●]` (dot is U+25CF); joined with the existing `' | '`.
- Colors: `[CodeMie ` and `]` use new `C.dimPurple`; `●` uses existing `C.green` (`statusline.ts:594`). Each piece goes through the `c()` helper.
- No new imports in `statusline.ts` (standalone bundle).

## Review Focus

- `CODEMIE_SESSION_ID=""` (empty string) must count as not managed.
- Managed flag with no projectName/other data: line is just the segment, no stray separator.
- Plain-session output byte-identical to before (no `managed` argument passed).
- The managed segment is bracketed like the project segment: any regex that finds "the first `[...]`" must not mistake it for the project name.

---

### Task 1: Render the managed segment in buildStatusLine

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:591-601` (add `dimPurple: '\x1b[2;38;2;177;185;249m'` to `C`), `:626-629` (signature and first push)
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:216-241` (`describe('buildStatusLine')`)

**Interfaces:**
- Produces: `buildStatusLine({ ..., managed = false })`, where `managed: boolean`. When true, `parts[0]` is `` `${c(C.dimPurple, '[CodeMie ')}${c(C.green, '●')}${c(C.dimPurple, ']')}` ``, pushed before the project segment.

- [ ] **Step 1: Write failing tests** in `describe('buildStatusLine')`:
  - `'prefixes [CodeMie ●] as the first segment for managed sessions'`: `stripAnsi(buildStatusLine({ ...basic, managed: true }))` starts with `[CodeMie ●] | [my-project]`; the raw line starts with `\x1b[2;38;2;177;185;249m[CodeMie \x1b[0m\x1b[0;32m●\x1b[0m\x1b[2;38;2;177;185;249m]\x1b[0m`.
  - `'omits the segment for plain sessions'`: `buildStatusLine({ ...basic })` and `{ ...basic, managed: false }` contain neither `CodeMie` nor `●`, and the stripped plain line still matches `/^\[my-project\]/`.
  - `'renders only the segment when nothing else is available'`: `stripAnsi(buildStatusLine({ managed: true }))` equals `[CodeMie ●]`.
  - Keep the project-truncation test (line ~237) with its `^\[` regex on the plain path; add a managed variant using `/^\[CodeMie ●\] \| \[([^\]]*)\]/` with the same 20-char assertions.
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the `managed` destructured param (default `false`) and, as the first statement after `parts` is declared, one push of the three-piece segment described under Interfaces.
- [ ] **Step 4: Re-run** the same command. Expected: PASS (all tests in file).
- [ ] **Step 5: Commit** `feat(statusline): add [CodeMie ●] segment for managed sessions` with ticket reference.

Test-first: yes — managed render returns a line starting with `[CodeMie ●] | [my-project]`; fails before the `managed` param exists.

### Task 2: Gate on CODEMIE_SESSION_ID in main()

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:866` (the only production `buildStatusLine` call).
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`

**Interfaces:**
- Consumes: `managed` param from Task 1.
- Produces: exported `isManagedSession(env: NodeJS.ProcessEnv = process.env): boolean` in `statusline.ts`, returning `Boolean(env.CODEMIE_SESSION_ID)`; `main()` passes `managed: isManagedSession()`. Keeps the gate unit-testable, since no test covers `main()`. An empty string is falsy, so it counts as not managed.

- [ ] **Step 1: Write failing tests** (new `describe('isManagedSession')`): `{ CODEMIE_SESSION_ID: 'abc' }` is true; `{}` is false; `{ CODEMIE_SESSION_ID: '' }` is false.
- [ ] **Step 2: Run** the test file. Expected: FAIL (`isManagedSession` is not exported).
- [ ] **Step 3: Implement** `isManagedSession` next to `buildStatusLine` and use it at line 866.
- [ ] **Step 4: Run** the test file, then `npm run typecheck` and `npm run build`. Expected: PASS (the build also rebundles `statusline.bundle.mjs`; if that file is tracked, include it in the commit).
- [ ] **Step 5: Commit** `feat(statusline): show [CodeMie ●] only when CODEMIE_SESSION_ID is set` with ticket reference.

Test-first: yes — `isManagedSession({ CODEMIE_SESSION_ID: 'abc' })` returns true; fails before the function exists.

### Task 3: Update user-facing descriptions

**Files:**
- Modify: `src/agents/plugins/claude/statusline-installer.ts:15` (`STATUSLINE_DESCRIPTION`): prefix with a CodeMie session indicator, e.g. `'CodeMie session indicator, project, branch, model, context usage, session cost & duration for Claude Code'`.
- Modify: `README.md:553` (add the `[CodeMie ●]` indicator to the list of what the statusline displays) and `README.md:566` (prepend `[CodeMie ●] | ` to the example line, with a one-line note below it that the segment appears only in sessions launched through CodeMie).
- Test: `src/agents/plugins/claude/__tests__/statusline-installer.test.ts`, only if it asserts the old description string. Grep first and update the expectation to match.

- [ ] **Step 1: Grep** the repo's tests for the old description (`Project, branch, model, context usage`). Update any exact match.
- [ ] **Step 2: Edit** the three doc locations above.
- [ ] **Step 3: Run** `npx vitest run src/agents/plugins/claude` and `npm run lint`. Expected: PASS, zero warnings.
- [ ] **Step 4: Commit** `docs(statusline): document [CodeMie ●] segment` with ticket reference.

Test-first: no — documentation strings only; existing tests cover the constant if they assert it.
