## Clarification assumptions

No clarifying questions were needed; these defaults were chosen from the research and can be reversed by editing this plan:

1. **Bare `-r <id>` is out of scope.** It bypasses `options.resume` and the ownership gate today; the ticket is about `--resume`.
2. **Unknown IDs keep today's behavior** (the "not created through CodeMie" confirm/block flow). A hard "not found" error would break the supported interactive flow of resuming an external native session. AC 7c is tested as "unknown id → `owned: false`, no `nativeId`".
3. **"Non-interactive" means what the code means:** `!process.stdin.isTTY || CODEMIE_NO_PROMPTS=1` (`shouldBlockNonInteractiveResume`). `--task` alone does not block. AC 6 holds because a resolved CodeMie ID is `owned: true` and never reaches the block.
4. **A CodeMie record with no usable native id** (missing, `'unknown'`, or equal to its own `sessionId`) resolves as `owned: true` with no `nativeId`. The id is passed through unchanged and Claude reports its own error.
5. **Git operations:** the commit steps below follow the sdlc-light flow, but AGENTS.md allows git operations only on explicit request. Confirm with the user before the first commit.

# Resume by CodeMie Session ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `codemie-claude --resume <codemie-session-id>` resolves the CodeMie ID shown by `codemie analytics` / `codemie log list-sessions` / `codemie log session` to the native Claude ID, passes the native ID to `claude -r`, and keeps the run CodeMie-owned.

**Architecture:** Add a resolver in `core/session/session-ownership.ts` that returns `{ owned, nativeId? }`. `ClaudePlugin.resolveResumeOwnership` reports the native ID through a new optional `ResumeOwnershipResult.nativeResumeId`. The agent-agnostic `AgentCLI` ownership gate rewrites `options.resume` and `CODEMIE_RESUME_SESSION_ID` to that native ID before building the agent args.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `fs`, Vitest.

**Spec:** Jira EPMCDME-17189; research in `docs/superpowers/tasks/2026-11-13-epmcdme-17189-resume-codemie-session-id/technical-analysis.md`; design constraints in `docs/superpowers/specs/2026-07-06-generic-resume-ownership-validation-design.md`.

## Global Constraints

- `AgentCLI` and `core/types.ts` stay agent-agnostic: no `claude` literal in shared code or messages. New `ResumeOwnershipResult` field is optional.
- A resolved CodeMie ID must return `owned: true`. `owned: false` sets `CODEMIE_SESSION_ORIGIN=external-resume`, which drops all telemetry for the run.
- Resume IDs are format-agnostic: strip only control characters (`/\p{Cc}/gu`), never validate a UUID shape.
- Resolvers must not throw; the `AgentCLI` gate already fails open on a throw.
- Code style: `.js` import suffixes, `logger.debug` (never `console.log`), explicit return types on exports, no `any`. Lint runs with `--max-warnings=0`.
- Tests use real temp dirs (no fs mocking) and `path.join`, as in `session-ownership.test.ts`.

## Review Focus

1. A `<uuid>-<generation>` ID copied from analytics (a `completed_<uuid>-<gen>.json` file) resolves to that generation's native ID (Task 1).
2. A bare CodeMie UUID with several generation files resolves to the newest file's native ID, not an arbitrary one (Task 1).
3. A record whose `agentSessionId` is missing, `'unknown'`, or equal to its own `sessionId` (opencode/codemie-code placeholder) is owned but is not rewritten (Tasks 1, 3).
4. A CodeMie ID that belongs to a non-Claude agent is not resolved, so `claude -r` never receives a foreign agent's ID (Task 1).
5. A native ID still resolves to itself and wins over a CodeMie-ID match; the rewritten ID has control characters stripped and the audit data keeps both IDs (Tasks 1, 3).

---

### Task 1: Resolve a CodeMie or native ID to a native ID

**Files:**
- Modify: `src/agents/core/session/session-ownership.ts`
- Test: `src/agents/core/__tests__/session-ownership.test.ts`

**Interfaces:**
- Consumes: `getCodemiePath`, `logger` (already imported).
- Produces:
  ```ts
  export interface ResumeSessionMatch {
    owned: boolean;          // false = no session record matches
    nativeId?: string;       // native Claude id to pass to `claude -r`; absent when unresolvable
    codemieSessionId?: string; // record.sessionId of the matched record
  }
  export function resolveClaudeResumeSession(resumeId: string, sessionsDir?: string): ResumeSessionMatch;
  ```
  `scanSessionsForClaudeId(claudeSessionId, sessionsDir?): boolean` keeps its signature and existing tests; it becomes `resolveClaudeResumeSession(...).owned`.

- [ ] **Step 1: Write the failing tests** in `session-ownership.test.ts`, in a new `describe('resolveClaudeResumeSession', ...)`. Add a fixture `writeRecord(fileName, record)` that writes `{ sessionId, agentName, correlation: { agentSessionId } }` JSON. Tests (name → assertion):
  - `resolves a native id to itself` → record `agentSessionId: 'native-1'`; `resolveClaudeResumeSession('native-1', TMP)` equals `{ owned: true, nativeId: 'native-1', codemieSessionId: <record.sessionId> }`.
  - `resolves a CodeMie id from a completed file to its native id` → `completed_cm-1.json` with `sessionId: 'cm-1'`, native `native-1`; `resolveClaudeResumeSession('cm-1', TMP)` → `{ owned: true, nativeId: 'native-1', codemieSessionId: 'cm-1' }`.
  - `resolves a live (non-completed) record by sessionId` → file `cm-2.json`.
  - `resolves the <uuid>-<generation> id shown by analytics` → files `completed_cm-3-gen_a.json` (native `n-a`) and `completed_cm-3-gen_b.json` (native `n-b`), both `sessionId: 'cm-3'`; `resolveClaudeResumeSession('cm-3-gen_a', TMP).nativeId === 'n-a'`.
  - `prefers the newest generation file for a bare CodeMie id` → same two files, set mtimes with `utimesSync` so `gen_b` is newer; `resolveClaudeResumeSession('cm-3', TMP).nativeId === 'n-b'`.
  - `returns owned without nativeId when the record has no usable native id` → three cases: no `correlation`, `agentSessionId: 'unknown'`, `agentSessionId === sessionId`; each gives `{ owned: true, nativeId: undefined, codemieSessionId }`.
  - `does not resolve a CodeMie id that belongs to another agent` → `agentName: 'opencode'`, `sessionId: 'cm-4'`, native `oc-native`; result `{ owned: false }`.
  - `returns owned: false for an unknown id` and `returns owned: false when the dir is missing or empty`.
  - `prefers a native-id match over a CodeMie-id match` → record A `sessionId: 'x'`, record B `correlation.agentSessionId: 'x'` with native-resolved `nativeId: 'x'`.
  - `ignores marker files` → `abc-cm-5-codemie-marker.json` containing `{ codemieSessionId: 'cm-5' }`; `resolveClaudeResumeSession('cm-5', TMP).owned === false`.

- [ ] **Step 2: Run to verify failure**

  Run: `npx vitest run --project unit src/agents/core/__tests__/session-ownership.test.ts`
  Expected: FAIL (`resolveClaudeResumeSession` is not exported).

- [ ] **Step 3: Implement `resolveClaudeResumeSession`** in `session-ownership.ts`. Approach: list `*.json` (skip `*_metrics.json` and `*-codemie-marker.json`), parse each (skip unparsable with the existing debug log). Match order: (1) any record with `correlation.agentSessionId === resumeId` → `{ owned: true, nativeId: resumeId, codemieSessionId: record.sessionId }`; (2) CodeMie match = `record.sessionId === resumeId` OR the filename without `.json` and without a leading `completed_` equals `resumeId`, restricted to records whose `agentName` is absent or one of the Claude plugin names (verify the claude / claude-acp `agentName` values with `grep -rn "agentName" src/agents/plugins/claude` and use exactly those). Among CodeMie matches prefer the filename-exact one, otherwise the newest by `statSync(...).mtimeMs`. A match's `nativeId` is `correlation.agentSessionId` unless it is empty, `'unknown'`, or equal to `record.sessionId`. If nothing matches return `{ owned: false }`. Rewrite `scanSessionsForClaudeId` as a one-line wrapper.

- [ ] **Step 4: Run to verify pass**

  Run: `npx vitest run --project unit src/agents/core/__tests__/session-ownership.test.ts`
  Expected: PASS, including the 7 pre-existing tests.

- [ ] **Step 5: Commit** (only after user confirms git ops)

  ```bash
  git add src/agents/core/session/session-ownership.ts src/agents/core/__tests__/session-ownership.test.ts
  git commit -m "fix(agents): resolve CodeMie session ids to native ids for resume (EPMCDME-17189)"
  ```

---

### Task 2: Report the native ID through the Claude resolver

**Files:**
- Modify: `src/agents/core/types.ts:731-736`
- Modify: `src/agents/plugins/claude/claude.plugin.ts:704-719`
- Create: `src/agents/plugins/claude/__tests__/claude-resume-ownership.test.ts` (match the directory convention of the neighbouring plugin tests; check `ls src/agents/plugins/claude/__tests__ src/agents/plugins/__tests__` first)

**Interfaces:**
- Consumes: `resolveClaudeResumeSession(resumeId, sessionsDir?): ResumeSessionMatch` from Task 1.
- Produces: `ResumeOwnershipResult.nativeResumeId?: string` (doc comment: "Native agent session id the resume id resolved to; when set and different from the input id, the CLI passes it to the agent instead").

- [ ] **Step 1: Write the failing tests** (`claude-resume-ownership.test.ts`). Point the resolver at a temp dir by setting `process.env.CODEMIE_HOME` before the dynamic import (the repo's tests already isolate this way), write a `completed_cm-1.json` record, then call `new ClaudePlugin().resolveResumeOwnership({ resumeId, cwd: process.cwd(), env: process.env })`. Assertions:
  - `CodeMie id → owned true, nativeResumeId is the native id, fallbackResumeCommand uses the native id, auditData has nativeAgent 'claude', nativeResumeId and codemieSessionId`.
  - `native id → owned true, nativeResumeId equals the input`.
  - `unknown id → { supported: true, owned: false }`, `nativeResumeId` undefined, `fallbackResumeCommand` uses the input id.
  - `owned record without native id → owned true, nativeResumeId undefined`.

- [ ] **Step 2: Run to verify failure**

  Run: `npx vitest run --project unit src/agents/plugins/claude/__tests__/claude-resume-ownership.test.ts`
  Expected: FAIL (no `nativeResumeId`).

- [ ] **Step 3: Implement.** Add the optional field to `ResumeOwnershipResult`. In `ClaudePlugin.resolveResumeOwnership` call `resolveClaudeResumeSession(input.resumeId)` and return `{ supported: true, owned: match.owned, nativeResumeId: match.nativeId, fallbackResumeCommand: \`claude --resume ${match.nativeId ?? input.resumeId}\`, auditData: { nativeAgent: 'claude', nativeResumeId: match.nativeId ?? input.resumeId, ...(match.codemieSessionId && { codemieSessionId: match.codemieSessionId }) } }`. Keep the dynamic import.

- [ ] **Step 4: Run to verify pass**

  Run: `npx vitest run --project unit src/agents/plugins/claude/__tests__/claude-resume-ownership.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit** (only after user confirms git ops)

  ```bash
  git add src/agents/core/types.ts src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/claude/__tests__/claude-resume-ownership.test.ts
  git commit -m "fix(claude): expose the resolved native resume id from ownership check (EPMCDME-17189)"
  ```

---

### Task 3: Rewrite the resume ID in the AgentCLI ownership gate

**Files:**
- Modify: `src/agents/core/AgentCLI.ts:466-515` (ownership gate)
- Test: `src/agents/core/__tests__/AgentCLI-resume.test.ts`

**Interfaces:**
- Consumes: `ResumeOwnershipResult.nativeResumeId?: string` (Task 2); existing `RESUME_SESSION_ENV_KEY`, `buildResumeEnvOverride`.
- Produces: when the resolver returns a `nativeResumeId` different from `resumeId` and the id came from `options.resume`, then `options.resume` and `providerEnv[RESUME_SESSION_ENV_KEY]` both hold the sanitized native id before `collectPassThroughArgs` runs. Nothing is rewritten for the `extractNativeResumeId` (Codex positional) path.

- [ ] **Step 1: Write the failing tests** in the `handleRun resume ownership flow` describe, reusing its `createAdapter` / `run` mock pattern:
  - `rewrites --resume to the resolved native id` → resolver returns `{ supported: true, owned: true, nativeResumeId: 'native-1' }`, launch with `resume: 'cm-1'`; assert `run` was called with args containing `['--resume', 'native-1']` and not `'cm-1'`, and the env passed to `run` has `CODEMIE_RESUME_SESSION_ID === 'native-1'`.
  - `an owned resolved id does not prompt, audit-block, or set the external-resume origin` → no `promptExternalResume` call, env has no `CODEMIE_SESSION_ORIGIN=external-resume`.
  - `leaves --resume untouched when the resolver returns no nativeResumeId` or the same id.
  - `strips control characters from the resolved native id` → resolver returns `'native\u0007-1'`; `run` receives `'native-1'`.
  - `does not rewrite a native positional resume (extractNativeResumeId path)` → no `options.resume`, adapter's `extractNativeResumeId` returns an id, resolver returns a different `nativeResumeId`; `run` args unchanged.

- [ ] **Step 2: Run to verify failure**

  Run: `npx vitest run --project unit src/agents/core/__tests__/AgentCLI-resume.test.ts`
  Expected: FAIL on the rewrite tests; existing tests still pass.

- [ ] **Step 3: Implement in the gate.** After the `isExternal` block (still inside `if (resolveResumeOwnership && resumeId)`), if `options.resume` is set and `ownership?.nativeResumeId` is a non-empty string whose control-character-stripped value differs from `resumeId`: assign it to `options.resume` and `providerEnv[RESUME_SESSION_ENV_KEY]`, and `logger.info` one line naming both ids ("Resuming session <resumeId> as native session <native>"). No agent-name conditionals.

- [ ] **Step 4: Run to verify pass**

  Run: `npx vitest run --project unit src/agents/core/__tests__/AgentCLI-resume.test.ts src/agents/core/__tests__/session-ownership.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit** (only after user confirms git ops)

  ```bash
  git add src/agents/core/AgentCLI.ts src/agents/core/__tests__/AgentCLI-resume.test.ts
  git commit -m "fix(cli): resume with the native id resolved from a CodeMie session id (EPMCDME-17189)"
  ```

---

### Task 4: Docs and integration test

**Files:**
- Modify: `docs/COMMANDS.md:536-552` ("Resuming a Session (`--resume`)", including "Finding a session id")
- Create: `tests/integration/agent-resume-codemie-id.test.ts`

**Interfaces:**
- Consumes: helpers used by `tests/integration/agent-task-session.test.ts` (`pollForSession` from `tests/helpers/session-poll.ts`, SSO/JWT setup, `describe.runIf(process.env.SSO_AVAILABLE !== 'false')`). Copy its auth and setup structure.
- Produces: nothing downstream.

- [ ] **Step 1: Update `docs/COMMANDS.md`.** State that `--resume` accepts either the CodeMie session id shown by `codemie analytics`, `codemie log list-sessions` and `codemie log session`, or the agent's native id, and that CodeMie resolves the former to the latter. Keep the existing table; do not mention internals.

- [ ] **Step 2: Write the integration test** `agent-resume-codemie-id.test.ts` (name must match `agent-*.test.ts` so it runs in the `agent` project): spawn `bin/codemie-claude.js --task "<prompt with a uuid>" --permission-mode acceptEdits` via `spawnSync`, poll for the completed session with `pollForSession`, read the CodeMie id from the completed record, then spawn `codemie-claude --resume <codemie-id> --task "..."` and assert exit status 0, stdout/stderr does not contain `was not created through CodeMie`, and a second completed session record exists whose `correlation.agentSessionId` equals the first run's native id.

- [ ] **Step 3: Verify.** Typecheck and lint the new file: `npm run typecheck && npx eslint tests/integration/agent-resume-codemie-id.test.ts --max-warnings=0`. The test itself needs real SSO/JWT auth and network and is not part of `npm run ci`; run it only if credentials are available (`npx vitest run --project agent tests/integration/agent-resume-codemie-id.test.ts`), otherwise report it as written but not executed.

- [ ] **Step 4: Commit** (only after user confirms git ops)

  ```bash
  git add docs/COMMANDS.md tests/integration/agent-resume-codemie-id.test.ts
  git commit -m "docs(cli): document resume by CodeMie session id and add integration test (EPMCDME-17189)"
  ```
