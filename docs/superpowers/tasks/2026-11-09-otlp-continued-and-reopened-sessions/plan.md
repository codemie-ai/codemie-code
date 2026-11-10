# EPMCDME-16992 + EPMCDME-16993 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (sdlc-light runs inline TDD). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A continued Claude Code session reports only its own history (16992), and reopening a session without activity no longer emits lifecycle/summary events stamped at open time (16993).

**Architecture:** In the `claude-code-otlp` plugin, resolve the parent session's message uuids once per continued session (by finding the sibling transcript that holds a `continued-in` record naming it) and exclude them from both the incremental usage path (`deriveMainEvents`) and the full-file summary (`buildFullAccumulator`). The same "own lines" notion gives an activity signal: a session marked reopened by a `resume` SessionStart suppresses its start/env, Stop and SessionEnd lifecycle events until a pass reads real own lines.

**Tech Stack:** TypeScript ESM (`.js` import suffix, `@/` alias), Vitest, Node >= 20.

**Spec:** none (sdlc-light). Requirements: Jira EPMCDME-16992, EPMCDME-16993; research: `technical-analysis.md` in this directory.

## Global Constraints

- Plugin dir `P/` = `src/agents/plugins/claude-code-otlp/`. CLI-side only; no spool/daemon/backend changes.
- Resolvers return `''`/empty on failure and never throw; one `if` per event in `evaluate()`; handlers return `ForwardDecision` and never send; commit-after-send via `finalize`.
- Never acquire `acquireParseStateLock` twice in one pass.
- New `TranscriptParseState` fields are optional; a state without them behaves exactly as today. State load keeps its never-throw fallback.
- Do not change `transitionGate` / `resume_unknown` / evidence-frozen-at-first-hook behavior.
- Use `logger.debug()`, `path.join`, `getCodemiePath()`; no `console.log`, no `any`.
- Repo policy (AGENTS.md): tests only on explicit user request. The `Test-first` lines below are the sdlc-light TDD contract; execute them only with the user's go-ahead (see handoff).

## Review Focus

- C has zero own counted lines (only copied + synthetic): no usage events, no summary with P's timestamps, SessionEnd still forwarded.
- C's file also contains lines whose uuid is in P but P's file is missing/unreadable: behave as today (no exclusion), no throw.
- Parent file has `continued-in` for several children: only lines of the file naming this session are used, and a different child's id never matches.
- Parse-state file deleted/corrupt for C after own work: P's lines still excluded on re-read; own lines recounted with identical event ids.
- Reopen where the user later sends a prompt: lifecycle events resume forwarding in that same reopen; a second `resume` re-arms suppression.
- Brand-new `startup` session closed with no prompt: Stop/SessionEnd still forwarded (suppression applies only to reopened sessions).

---

### Task 1: Parse-state fields

**Files:**
- Modify: `P/transcript/parse-state.ts` (`TranscriptParseState` ~52-98, `createParseState` ~103-115)
- Test: `P/transcript/__tests__/parse-state.test.ts`

**Interfaces:**
- Produces on `TranscriptParseState` (all optional): `inheritedUuids?: string[]` (uuids copied from the parent), `inheritedResolved?: boolean` (parent lookup done), `reopened?: boolean` (a `resume` SessionStart was suppressed), `reopenActive?: boolean` (a pass since that resume read own lines).

Test-first: yes — a state JSON saved without the new fields loads with them `undefined`, and a state saved with them round-trips unchanged.

- [ ] **Step 1:** Write the two parse-state tests above; run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/parse-state.test.ts`, expect FAIL (fields unknown to type/round-trip).
- [ ] **Step 2:** Add the four optional fields with doc comments; make sure load/save pass unknown-to-old-version fields through. Do not set them in `createParseState`.
- [ ] **Step 3:** Re-run the file, expect PASS.
- [ ] **Step 4:** Commit `feat(analytics): add continuation/reopen fields to otlp parse state (EPMCDME-16992, EPMCDME-16993)`.

### Task 2: Resolve inherited uuids of a continued session

**Files:**
- Create: `P/transcript/continuation.ts`
- Test: `P/transcript/__tests__/continuation.test.ts`

**Interfaces:**
- Produces: `resolveInheritedUuids(transcriptPath: string, sessionId: string): Promise<string[] | null>` — scans sibling `*.jsonl` in `dirname(transcriptPath)` (excluding the file itself and `subagents/`), most recently modified first, capped at 200 files. A cheap substring pre-filter (`continued-in` and `sessionId` both present) precedes JSON parsing; a file qualifies only if it has a parsed record `{type:'continued-in', continuedInSessionId: sessionId}`. Returns the uuids of its counted lines (`isCountedTranscriptLine`), `[]` when the directory was scanned and no parent exists, `null` when the directory is unreadable.
- Consumes: `isCountedTranscriptLine` from `@/agents/plugins/claude/session/transcript-lines.js`.

Test-first: yes — temp dir with `P.jsonl` (two assistant lines with uuids `u1`,`u2` and a `continued-in` record naming `C`) and `C.jsonl`: `resolveInheritedUuids(C path, 'C')` returns `['u1','u2']`; a third file naming a different child `D` is ignored; with no parent returns `[]`; with a missing directory returns `null`.

- [ ] **Step 1:** Write the four tests; run, expect FAIL (module missing).
- [ ] **Step 2:** Implement `resolveInheritedUuids` per the interface; read files as streams or whole-file with the substring check first; never throw.
- [ ] **Step 3:** Run, expect PASS.
- [ ] **Step 4:** Commit `feat(analytics): resolve parent uuids of continued claude sessions (EPMCDME-16992)`.

### Task 3: Exclude inherited lines from usage events and summary

**Files:**
- Modify: `P/transcript/orchestrator.ts` — `deriveMainEvents` (~545-639), `buildFullAccumulator` (~362-468)
- Test: `P/transcript/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: `resolveInheritedUuids` (Task 2); state fields (Task 1).
- Produces: `async function ensureInherited(state: TranscriptParseState, sessionId: string, transcriptPath: string): Promise<ReadonlySet<string>>` (orchestrator-internal): when `!state.inheritedResolved && state.mainOffset === 0`, calls the resolver; on a non-null result sets `state.inheritedUuids` (empty array allowed) and `state.inheritedResolved = true`; returns the set from `state.inheritedUuids ?? []`.
- `buildFullAccumulator(transcriptPath, final, extra, pass, excluded: ReadonlySet<string>)` drops, before every pass of its computation (tool results, models, tool calls, turns, compactions, title, branch, timestamps), each line whose `uuid` is in `excluded`; the raw-line model pass is filtered the same way.

Behavior:
- `deriveMainEvents` calls `ensureInherited`, seeds `seenUuids` with the inherited set so copied lines produce no usage request and no `branchCounts`, and passes the set on.
- When `excluded.size > 0` and the filtered full-file parse has no counted lines, the `agent.session.summary` event is not pushed (usage events and lifecycle hooks are unaffected).
- `startedAt` of the summary is the first timestamp among remaining (own) lines.

Test-first: yes — fixture dir with P (3 usage-bearing assistant lines + `continued-in` naming C) and C (those 3 lines copied with `sessionId` rewritten, plus 1 own prompt and 1 own assistant line with distinct uuids): `SessionEnd` pass for C yields exactly 1 `agent.usage.request` (the own one), a final summary with 1 turn, the own model count and `started_at` equal to the first own line timestamp; a second C fixture with no own lines yields no usage events and no summary; a C whose parent file is absent behaves as before (all lines counted).

- [ ] **Step 1:** Add the fixture builder and the three tests; run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts -t "continued"`, expect FAIL.
- [ ] **Step 2:** Implement `ensureInherited`; seed `seenUuids`; thread `excluded` into `buildFullAccumulator`; skip the summary per the rule above.
- [ ] **Step 3:** Run the new tests then the whole orchestrator file, expect PASS (existing tests unchanged).
- [ ] **Step 4:** Commit `fix(analytics): do not re-report parent history in continued claude sessions (EPMCDME-16992)`.

### Task 4: Suppress lifecycle events for a no-activity reopen

**Files:**
- Modify: `P/transcript/orchestrator.ts` (`openSessionStartPass` ~696-733, `openMainTranscriptPass` ~1016-1046, `openSessionEndPass` ~1403-1457, `deriveMainEvents`), `P/claude-code-otlp.plugin.ts` (`onSessionStart` 391-420, `onStopEvent` 422-432, `onSessionEndEvent` 479-504)
- Test: `P/transcript/__tests__/orchestrator.test.ts`, `P/__tests__/claude-code-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: Task 3 own-lines logic.
- Produces:
  - `openSessionStartPass(sessionId, gitHeadStart, sessionEnvFields, source?: string)` result gains `reopened: boolean` — true when `source === 'resume'` and the loaded state already has `sessionStartedAt`; in that case the pass sets `state.reopened = true`, `state.reopenActive = false` and keeps first-write-wins values (no overwrite of `gitHeadStart`/`sessionStartedAt`).
  - `deriveMainEvents` records whether this pass read own activity: at least one newly read counted line (after exclusion) that is not an assistant line with a synthetic model (`isSyntheticModel`). If so and `state.reopened`, set `state.reopenActive = true`.
  - `openMainTranscriptPass` and `openSessionEndPass` results gain `suppressLifecycle: boolean` = `state.reopened === true && state.reopenActive !== true` after the pass. When true, `events` is `[]` (no usage, no summary).
- Plugin: `onSessionStart` passes `hookInput.source` and returns `{ decision: 'forward', payload: [], finalize: pass.finalize }` when `pass.reopened`. `onStopEvent` and `onSessionEndEvent` return `payload: []` (with `finalize`; no `retryOnce` needed) when `pass.suppressLifecycle`, so the Stop/SessionEnd hook event, `agent.git.snapshot` and git-head fields are not sent.

Test-first: yes — (a) orchestrator: state with `sessionStartedAt` set, `openSessionStartPass(..., 'resume')` reports `reopened: true` and leaves `sessionStartedAt`/`gitHeadStart` unchanged; a following Stop pass over an unchanged transcript reports `suppressLifecycle: true` with no events; after appending one user+assistant line the next Stop reports `suppressLifecycle: false` with a usage event and summary, and a later SessionEnd still forwards. (b) plugin: `SessionStart` with `source: 'resume'` and prior state yields an empty payload; with `source: 'startup'` yields `[start, env]`; a new `startup` session whose first Stop/SessionEnd sees no lines still forwards the lifecycle event; a second `resume` re-arms suppression.

- [ ] **Step 1:** Write the orchestrator and plugin tests above; run both files with `-t "reopen"`, expect FAIL.
- [ ] **Step 2:** Implement the orchestrator changes (activity flag, `reopened`, `suppressLifecycle`), reusing the single parse-state lock per pass.
- [ ] **Step 3:** Implement the plugin handler changes.
- [ ] **Step 4:** Run both files plus `claude-code-otlp.transitions.test.ts` and `src/cli/commands/__tests__/hook.session-delivery.test.ts`, expect PASS (the resume gate must be unchanged).
- [ ] **Step 5:** Commit `fix(analytics): do not forward lifecycle events for a reopened session without activity (EPMCDME-16993)`.

### Task 5: Docs

**Files:**
- Modify: `docs/ARCHITECTURE-OTLP-PLUGIN.md` (s6 file table row for `transcript/` and the SessionStart/Stop/SessionEnd paragraph)

Test-first: no — documentation only.

- [ ] **Step 1:** Add the `continuation.ts` row; document that continued sessions exclude parent-copied uuids (parent found via `continued-in`), and that a `resume` SessionStart is not forwarded and Stop/SessionEnd are suppressed until a pass reads own lines. State the known limits: copied subagent files and backend session binding are not handled client-side.
- [ ] **Step 2:** Run the full gate `npm run lint && npm run typecheck && npm run build`, expect zero warnings/errors.
- [ ] **Step 3:** Commit `docs(analytics): document continued and reopened session handling (EPMCDME-16992, EPMCDME-16993)`.
