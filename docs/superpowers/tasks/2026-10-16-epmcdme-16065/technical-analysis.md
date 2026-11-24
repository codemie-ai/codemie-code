# Technical Research

**Task**: otlp sessionstart analytics session-env (EPMCDME-16065)
**Generated**: 2026-10-16
**Research path**: filesystem

---

## 1. Original Context

**EPMCDME-16065**: [CLI Analytics] agent.session.env from SessionStart has empty effort/permission_mode (and empty model on resume) and overwrites the last good snapshot

- **Type:** Sub-Bug
- **Status:** In Progress

## Precondition

- **Environment:** local backend http://localhost:8080 (API 0.16.0), Docker. Backend codemie main @ 080fda7a2, UI codemie-ui main @ e0ded3b3 (http://localhost:5173). Storage PostgreSQL.
- **Platform:** macOS 26.6.2 (arm64), Node v24.1.0
- **CodeMie CLI / proxy daemon:** 0.15.8, local build of codemie-code PR #634 (branch EPMCDME-15301/add-modifications-to-existing-fields-and-new-synthetic-events @ 717a509), profile local
- **Agent:** Claude Code 2.1.287, plain claude, connected with `codemie proxy connect --claude-code-otlp --profile local --force`

## Description

Claude Code's SessionStart payload carries no permission_mode or effort for any source, and on source=resume it sends model "". onSessionStart builds agent.session.env from that payload (effort is hard-coded to an empty string), sends it, and stores it as the session's env baseline (lastSessionEnvFields). On compact and resume this replaces a correct earlier snapshot with empty values.

## Steps to reproduce

1. Start claude, press Shift+Tab to switch to accept edits, send "reply ok".
2. Run /compact, then send "reply ok".
3. /exit, then run `claude -c` and send "reply ok".
4. Read the agent.session.env records in `~/.codemie/proxy/otlp-spool/SESSION_ID.hooks.ndjson` (field hookEvent).

Isolated run, no Claude Code: pipe SessionStart (startup), then PostModelSwitch (permission_mode acceptEdits, effort high), then SessionStart (compact), then SessionStart (resume, model "") to `codemie hook --agent claude-code-otlp`. Read lastSessionEnvFields from `~/.codemie/analytics/state/SESSION_ID.json` after each.

## Expected result

- SessionStart env reports the session's real effort and permission mode, or leaves them out instead of sending empty strings.
- A compact/resume SessionStart keeps the known effort, permission mode and model when the payload doesn't carry them, rather than resetting them.
- One agent.session.env per real change; no duplicate on the first Stop.

## Actual result

Isolated run, session e6b29e84-7cae-4e0d-af42-7fc10ad63ff7 (snapshot after each hook):

| Hook | configured_model | effort | permission_mode |
|---|---|---|---|
| SessionStart startup | claude-sonnet-5-5 | "" | "" |
| PostModelSwitch | claude-opus-5-5 | high | acceptEdits |
| SessionStart compact | claude-opus-5-5 | **""** | **""** |
| SessionStart resume | **""** | **""** | **""** |

All four were sent as agent.session.env, so the server's latest env for the session ends up with empty model, effort and permission mode.

- **Live session e71dabd7-f7d8-48c0-b529-bf59b5ac86f1:** Before compaction the session ran on acceptEdits / effort high (Stops at 11:24:02 and 11:24:25). Both post-compaction env events (11:25:02, 11:26:19) have effort="" and permission_mode="". After `claude -c` (11:31:42) the env event has configured_model="", effort="", permission_mode="".
- **Live session 3c0dc31a-a9b4-476c-a63a-2b557d669388:** the SessionStart env has permission_mode="" although the session ran in auto.
- **Duplicate env event:** in session ac1a6627-2e1e-4043-b3a2-98d8095d8ceb, SessionStart sent env with effort="", and the first Stop sent a second env with effort=high (11:36:56 to 11:37:10).

## Notes

- EPMCDME-16064 currently hides most of this. The Stop-side env check usually loses the lock, so the empty values are rarely corrected, and the duplicate event appears only when the env pass wins. Once 16064 is fixed, every session will send the duplicate on its first Stop unless this is fixed too.
- Related to EPMCDME-16063 (same handler, openSessionStartPass, also resets git start state on compact/resume), but a different field set.

---

## 2. Codebase Findings

### Critical finding: the described code does not exist in this checkout

The ticket's precondition names an uncommitted local build: "local build of codemie-code PR #634 (branch EPMCDME-15301/add-modifications-to-existing-fields-and-new-synthetic-events @ 717a509)". That branch/PR is **not present** in this repository (not on `main`, not on the current `EPMCDME-16065` branch, not fetchable from `origin` — `git branch -a` lists no `EPMCDME-15301` ref, `gh` is unavailable to query PR #634 directly). A full search confirms none of the symbols the ticket names exist anywhere in `src/`:
- `onSessionStart`, `openSessionStartPass`, `lastSessionEnvFields`, `agent.session.env`, `PostModelSwitch`, `permission_mode`, `configured_model` — zero matches in `src/agents/plugins/claude-code-otlp/` or elsewhere (the only unrelated hits are an old, unrelated LangGraph-era "SessionStart hook" feature on `origin/feat/hooks-system`, a different subsystem entirely — `src/hooks/executor.ts`'s agent-lifecycle hooks, not the OTLP ingestion adapter).
- `docs/ARCHITECTURE-OTLP-PLUGIN.md:174` (the living architecture doc for this exact adapter) states as current fact: *"`evaluate()` branches on `UserPromptSubmit` (auth gate), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse), and `SubagentStop` (subagent-scoped transcript parse); everything else falls through to the raw passthrough."* `SessionStart` is not branched on at all today — it falls through `evaluate()`'s trailing `return { decision: 'forward', payload: [hookInput] }` in `claude-code-otlp.plugin.ts:96`, with no enrichment, no state read/write, no `agent.session.env` synthesis.

Implementing a fix therefore means **building** the SessionStart handler and its env-snapshot persistence (presumably re-landing/adapting the PR #634 work), not patching an existing bug in a few lines. Section 6 covers the implications; this section documents the exact scaffolding that work must plug into.

### Existing Implementations (the scaffolding a SessionStart handler would use)

- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — `ClaudeCodeOtlpPlugin extends OtlpAgentAdapter`. `evaluate()` (lines 76-97) dispatches by `hook_event_name`; `HOOK_EVENT_TYPE_MAP` (lines 29-42) already maps `SessionStart` → `'agent.session.start'` and includes no `'agent.session.env'` entry at all. Existing per-event handlers follow the pattern `onXEvent(hookInput) -> Promise<ClaudeForwardDecision>` (e.g. `onStopEvent`, `onPreCompactEvent`, `onSubagentStopEvent`).
- `src/agents/core/OtlpAgentAdapter.ts` — abstract base (`processOtlpEvent`) that parses, allowlist-gates, calls `evaluate()`, resolves common fields (git/story/identity/project/version) and agent fields in parallel, builds one event per `payload` entry via `buildEvent()`, and sends the batch to the spool. `ForwardDecision` supports an optional `finalize(accepted)` for handlers that hold a cursor/lock to commit only after a successful send, and `retryOnce` for one resend.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts` — the only module with persisted per-session state today. Exports `openMainTranscriptPass` (Stop/PreCompact/StopFailure), `openSubagentPass`, `openSessionEndPass`. `MainTranscriptTrigger = 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure'` (line 57) — **no `'SessionStart'` member**; there is no `openSessionStartPass` export anywhere in the file (723 lines) or the directory.
- `src/agents/plugins/claude-code-otlp/transcript/parse-state.ts` — the actual state-persistence mechanism the ticket's `~/.codemie/analytics/state/SESSION_ID.json` path refers to (`getParseStatePath` → `getCodemiePath('analytics', 'state', `${sessionId}.json`)`). Today's `TranscriptParseState` shape (`mainOffset`, `subagentOffsets`, `openRequests`, `activeSkill`, `branchCounts`) carries **no `lastSessionEnvFields` field** — that field does not exist in the persisted schema. Load/save is lock-guarded (`acquireParseStateLock`/`withParseStateLock`) with a commit-after-send discipline: callers load+mutate in memory and only `saveParseState` after a successful spool send (mirrors the base class's `finalize(accepted)` contract).
- `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts` — pure, stateless signal extractors (`collectCompactions`, `countTurns`, `collectClientVersions`, `latestTitle`) operating on transcript lines already parsed; no git/env-snapshot persistence here (git branch is read fresh per pass via `TranscriptLine.gitBranch`, not carried forward as "last known" state — relevant to the related EPMCDME-16063 note about git state reset on compact/resume: there is currently no persisted git-state field to reset, because none exists).
- `src/agents/plugins/claude-code-otlp/claude-agent-sdk-hooks.d.ts` — the SDK's hook-payload type contract (vendored `.d.ts`), confirms the ticket's root-cause claim at the type level:
  - `BaseHookInput.effort?: { level: string }` (line 161) — doc comment: *"Present for hooks that fire within a tool-use context (PreToolUse, PostToolUse, Stop, SubagentStop, etc.) ...; absent for session-lifecycle hooks and models without effort support."* `SessionStart` is explicitly a session-lifecycle hook, so Claude Code **never** sends `effort` on it — this is an SDK-level contract, not a CodeMie-side defect in populating it.
  - `BaseHookInput.permission_mode?: string` (line 149) is optional and present on every hook type, including `SessionStart`, but Claude Code's own runtime evidently leaves it empty on some/most `SessionStart` sources (per the ticket's live evidence).
  - `SessionStartHookInput` (line 529): `source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'`, `model?: string` — confirms `model` is optional/can arrive as `""` on `source: 'resume'`.
  - `PostModelSwitchHookInput` (line 350): `from_model`, `to_model`, `requested_model`, `source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume'` — `permission_mode`/`effort` on this event come only from the shared `BaseHookInput` fields, not from PostModelSwitch-specific ones.

### Architecture and Layers Affected

- **Agent/adapter layer** (`src/agents/plugins/claude-code-otlp/`): the `ClaudeCodeOtlpPlugin.evaluate()` dispatch table needs a new `SessionStart` branch/handler, per `docs/ARCHITECTURE-OTLP-PLUGIN.md`'s mandated one-handler-per-event, no-`switch` convention.
- **Transcript/state layer** (`src/agents/plugins/claude-code-otlp/transcript/`): wherever the env snapshot is persisted (`parse-state.ts`'s `TranscriptParseState`, or a new sibling module) must extend the schema and go through the same lock-guarded commit-after-send pattern as `orchestrator.ts`.
- **Base adapter layer** (`src/agents/core/OtlpAgentAdapter.ts`): any new event type (`agent.session.env`) flows through the existing `buildEvent`/spool-forward path unchanged — `HOOK_EVENT_TYPE_MAP` or an explicit `type` field on the built payload record is how a handler controls the final `type`.
- **Spool/forwarder layer** (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`): transports already-built events; not expected to need changes for this fix (per the OTLP architecture doc, "forwarder only transports").

### Integration Points

- Claude Code (external, native hook payloads via stdin to `codemie hook --agent claude-code-otlp`) — the sole source of `SessionStart`/`PostModelSwitch` payloads; CodeMie has no control over what Claude Code chooses to populate (confirmed by the `.d.ts` doc comments above).
- `~/.codemie/analytics/state/<sessionId>.json` — per-session persisted parse state (today: transcript offsets/open-requests only).
- `~/.codemie/proxy/otlp-spool/<sessionId>.hooks.ndjson` — the daemon-side spool file the ticket inspects for repro evidence; written by `forwardOtlpEventsToSpool`/the proxy's `otlp-spool` plugin, not by the adapter directly.
- `EPMCDME-16064` (Stop-side env check) — referenced by the ticket as a separate, currently-masking bug on the Stop path; no Stop-side "env check"/dedup logic matching that description was found in this checkout either (`onStopEvent` in `claude-code-otlp.plugin.ts` only opens a transcript pass; no env-field diffing).
- `EPMCDME-16063` (same handler resetting git start state) — no persisted "git start state" field exists today (confirmed above); both 16063 and 16065 describe behavior of code from the unmerged PR #634 branch.

### Patterns and Conventions

- Dispatch: `evaluate()` is a flat if-chain, one `onXEvent` method per branch, each returning a full `ForwardDecision` — documented explicitly in `docs/ARCHITECTURE-OTLP-PLUGIN.md` §3 as mandatory, "no switch".
- Commit-after-send: any handler owning persisted state returns `finalize(accepted)` so state is only written once the spool confirms acceptance (see `orchestrator.ts` module doc, lines 1-25, and `parse-state.ts`'s lock primitives).
- "Never throws" discipline: transcript/state-reading code degrades to an empty pass rather than ever failing or blocking the hook (`EMPTY_PASS` sentinel in `orchestrator.ts`).
- Per-session lock file (`acquireParseStateLock`) guards concurrent hook processes touching the same `sessionId.json` — any new `lastSessionEnvFields`-style field would need to go through the same lock to avoid races with transcript passes writing the same file concurrently (if co-located in the same state file) or its own dedicated lock if kept separate.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — living doc, current (dated "update when the dispatch pattern changes"); confirms `SessionStart` is unhandled today (§ above) and defines the exact contract a new handler must follow (§3, "The dispatch pattern every evaluate() follows"; §4, numbered steps for adding a new event to an existing adapter).
- `.ai-run/guides/integration/external-integrations.md:283` — points to `docs/ARCHITECTURE-OTLP-PLUGIN.md` as the authority for this adapter and names `claude-code-otlp` as "the current reference implementation"; also documents an unrelated `onSessionStart` on the `codex` plugin (`src/agents/plugins/codex/codex.plugin.ts`) — a different, LangGraph-era native-agent lifecycle hook, not an OTLP ingestion handler. Do not conflate the two when implementing this fix.
- No guide in `.ai-run/guides/` covers `agent.session.env` or the `lastSessionEnvFields` concept specifically — it is presumably introduced by the unmerged PR #634.

### Architectural Decisions

- `OtlpAgentAdapter.ts`'s header comment records the deliberate decision that event-building happens in the short-lived hook process (not the long-lived daemon), because the daemon's environment is frozen at spawn time.
- `parse-state.ts`'s header comment records the deliberate choice of atomic rename + pid-liveness-based (not age-based) lock reclamation, relevant if the fix extends this same file's schema.

### Derived Conventions

- New persisted fields on `TranscriptParseState` (or an analogous sibling state) should default via `{ ...createParseState(), ...parsed }` spread merging in `loadParseState`, so old state files missing the new field do not break — this is the existing forward-compatible loading pattern.
- New hook-event types added to `HOOK_EVENT_TYPE_MAP` follow the `PascalCase hook name -> 'agent.noun.verb'` naming already used for all 12 mapped events.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — covers `evaluate()` dispatch for the currently-implemented branches (Stop, PreCompact, StopFailure, SessionEnd, SubagentStop, UserPromptSubmit) and the raw-passthrough fallthrough; by construction it has no `SessionStart`/`PostModelSwitch`/env-snapshot test, since none of that exists yet.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/parse-state.test.ts` — covers load/save/lock behavior for today's `TranscriptParseState` shape only.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — covers the Stop/PreCompact/SessionEnd passes; `fixtures/` holds sample transcript lines usable as a model for new SessionStart-related fixtures.

### Testing Framework and Patterns

Vitest, per `.ai-run/guides/testing/testing-patterns.md` (not re-read in full here; repo-wide convention). Existing adapter tests construct a `HookInput`-shaped fixture object and assert on the returned `ForwardDecision`; `parse-state.test.ts` exercises real temp-dir file I/O for load/save/lock races.

### Coverage Gaps

- Zero coverage for `SessionStart` or `PostModelSwitch` handling (none exists to cover).
- Zero coverage for any env-snapshot merge/preserve-on-missing-field logic (none exists).
- Zero coverage for cross-hook dedup (the "no duplicate agent.session.env on first Stop" requirement) — would need a new test exercising two consecutive hook invocations against the same persisted state.

---

## 5. Configuration and Environment

### Environment Variables

No feature-specific env vars found for this domain; `process.env.CLAUDE_CODE_ENTRYPOINT` is read in `resolveAgentFields()` (unrelated to effort/permission_mode).

### Configuration Files

- `~/.codemie/analytics/state/<sessionId>.json` (via `getCodemiePath('analytics', 'state', ...)` in `src/utils/paths.ts`) — the state file the fix would extend.
- `~/.codemie/proxy/otlp-spool/` (`spool-paths.ts`) — daemon-side spool, read-only from the adapter's perspective.

### Feature Flags and Deployment Concerns

None found specific to this feature; allowlist gating (`isProjectTracked`/`readAllowlistState` in `claude-code-otlp.allowlist.ts`) governs whether any hook for a project is processed at all, unrelated to this bug.

---

## 6. Risk Indicators

- **Primary risk: the feature branch this bug lives in is not available in this repository.** Any fix must first establish what PR #634 / `EPMCDME-15301` actually implemented (onSessionStart, openSessionStartPass, the `effort: ''` hard-code, `lastSessionEnvFields`) — either by pulling that branch if it becomes reachable, or by re-implementing the SessionStart-env feature from scratch following the patterns in Section 2, informed by the ticket's exact description. Treat the ticket's described lines (`onSessionStart`, `openSessionStartPass`, hard-coded `effort: ''`) as the spec for what to build/fix, not as a located defect to patch.
- Speculative: a correct fix likely needs the SessionStart handler to read the previously persisted env snapshot and fill in `effort`/`permission_mode`/`model` only when the new payload's value is non-empty (merge-not-replace), mirroring the existing `OVERRIDABLE_FIELD_KEYS` "own non-empty value wins" pattern already used in `OtlpAgentAdapter.mergeCommonFields` for `git_branch`/`story_id` — that existing merge primitive is a strong candidate for reuse or adaptation, rather than inventing a new merge rule.
- Speculative: deduplicating "one agent.session.env per real change" (no duplicate on first Stop) implies the persisted snapshot must be comparable field-by-field against a freshly computed one, and the comparison/dedup must live in a place both the SessionStart path and the Stop-side check (EPMCDME-16064) can share, or the two will re-drift.
- `effort` is architecturally absent from Claude Code's own `SessionStart` payload (confirmed via the vendored SDK `.d.ts`, not CodeMie's own choice) — any fix that tries to make SessionStart itself report real-time effort is working against the upstream contract; preserving a last-known value (rather than sourcing it fresh from SessionStart) looks structurally necessary, not optional.
- EPMCDME-16063 and EPMCDME-16064 are explicitly coupled to this same, currently-nonexistent handler; a fix landed here without awareness of those two tickets risks re-diverging from them immediately (per the ticket's own "Notes" section, 16064 fixed first will surface the duplicate-event bug on every session unless 16065 is fixed too).
- No test fixtures or test file currently models a `SessionStart`/`PostModelSwitch` sequence; new tests will need new fixtures from scratch (no existing pattern to copy verbatim, though `orchestrator.test.ts`/`parse-state.test.ts` give close structural templates).

---

## 7. Summary for Complexity Assessment

The ticket describes a bug in a `SessionStart` handler (`onSessionStart`/`openSessionStartPass`), an `agent.session.env` event, and a persisted `lastSessionEnvFields` snapshot — none of which exist in this repository checkout. The ticket's own precondition names the source: an unmerged branch, `EPMCDME-15301` / PR #634, built on top of this adapter but not present here (confirmed by exhaustive grep and by `docs/ARCHITECTURE-OTLP-PLUGIN.md`, which states as current fact that `SessionStart` falls through to raw passthrough today). This changes the nature of the work from "locate and patch a defect" to "implement (or re-implement, if the branch can be recovered) a SessionStart-env feature correctly from the start" — informed by the ticket's precise description of the wrong behavior to avoid.

The surrounding scaffolding is well-established and directly reusable: the `OtlpAgentAdapter` base class's dispatch/build/send/commit-after-send flow, the `orchestrator.ts`/`parse-state.ts` lock-guarded persisted-state pattern, and the `mergeCommonFields`"own non-empty value wins" merge primitive are all precedents a SessionStart-env implementation would naturally extend rather than invent. The vendored Claude Code SDK type definitions (`claude-agent-sdk-hooks.d.ts`) independently corroborate the ticket's root-cause claims at the contract level: `effort` is documented as absent from session-lifecycle hooks by design, and `model`/`permission_mode` are optional fields Claude Code is free to omit.

Risk is concentrated in two places: (1) the missing-branch gap, which means the actual defect lines cannot be inspected, only inferred from the ticket's narrative and the SDK contract, and (2) the explicit coupling to two sibling tickets (EPMCDME-16063's git-state reset, EPMCDME-16064's Stop-side dedup) touching the same not-yet-existent handler, which raises the chance of a fix here re-diverging from either unless sequenced deliberately. Test coverage for this exact area is necessarily zero today, since the code under test does not exist.

---

## 9. Correction — PR #634 located, exact root cause confirmed

Section 2's "missing branch" finding is superseded. The user located the branch at
`refs/pull/634/head` on `origin` (`git fetch origin pull/634/head:pr-634`); it is reachable even
though it has no matching local/remote branch name. The task branch `EPMCDME-16065` has been reset
onto `pr-634`'s head (`609da8e6`) so the real code is now present on disk.

**Exact root cause**, confirmed by reading the real files:

- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:538-561` (`openSessionStartPass`)
  unconditionally does `state.lastSessionEnvFields = sessionEnvFields;` on **every** `SessionStart`
  fire — startup, compact, and resume alike. There is no merge against the prior snapshot, unlike
  the sibling `gitHeadStart`/`sessionStartedAt` fields two lines above, which use an explicit
  first-write-wins guard (`if (!state.gitHeadStart) { ... }`). This is the "last good snapshot
  overwritten" bug.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:152-173` (`onSessionStart`) builds
  `sessionEnvFields` fresh from the hook payload on every fire (`model`/`permissionMode` read
  straight off `hookInput`, both `''` on compact/resume per the ticket), then sends it as
  `agent.session.env` (`buildSessionEnvEvent`) **before/independent of** whatever
  `openSessionStartPass` does to persisted state. So even a persisted-state-only fix would leave the
  actually-sent event still carrying empty strings — the merge needs to happen before the event is
  built, not only before it's persisted.
- `src/agents/plugins/claude-code-otlp/event-fields/session-env-fields.ts:221-223`
  (`resolveSessionEnvFields`) hardcodes `effort: ''` with a comment confirming this is intentional:
  Claude Code's `SessionStart` payload never carries `effort` at all (confirmed independently by the
  vendored SDK types, `claude-agent-sdk-hooks.d.ts:161`). So for `effort` specifically, "prefer the
  payload, fall back to last" is wrong — `SessionStart` must always carry the last known value
  forward, never its own payload.
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:611-649`
  (`openSessionEnvCheckPass`, the `Stop`/`PostModelSwitch`/etc. path) already implements the correct
  pattern this ticket needs: its cheap path (`!input.full`) does
  `candidate = { ...last!, ...volatile }` — merge onto the last snapshot — and it skips emitting
  when `sessionEnvFieldsEqual(last, candidate)`. `openSessionStartPass` has no equivalent of either
  half of that.
- Existing test `orchestrator.test.ts:1265` ("a later SessionStart fire ... does not overwrite the
  real session start") proves the *git/timestamp* fields are already correctly guarded — there is no
  equivalent test for `lastSessionEnvFields`, confirming the env-fields overwrite was never covered
  and is the actual gap.

**Fix shape implied by the above** (for the plan, not yet implemented):
1. `openSessionStartPass` needs to see the prior `state.lastSessionEnvFields` *before* overwriting
   it, and return the merged/corrected fields to the caller (its return shape currently has no slot
   for this — `openSessionEnvCheckPass`'s `SessionEnvCheckResult.sessionEnvFields` is the precedent
   to extend it with).
2. `onSessionStart` in the plugin must build/send `buildSessionEnvEvent` from that merged result, not
   from the raw `resolveSessionEnvFields(...)` output it currently uses directly.
3. Merge rule: `effort` always carries forward `last.effort` (SessionStart payload never has it);
   `permission_mode`/`configured_model` prefer the new payload's value when non-empty, else fall back
   to `last`'s value — mirroring `mergeCommonFields`'s "own non-empty value wins" primitive already
   used elsewhere in `OtlpAgentAdapter.ts`.
4. No change needed to `openSessionEnvCheckPass` itself — once `openSessionStartPass` stops emitting
   empty effort/permission_mode, the Stop-side "duplicate event" symptom the ticket describes (a
   second, corrected `agent.session.env` on the first `Stop`) resolves as a side effect, since
   `sessionEnvFieldsEqual` will find no real diff anymore.

Risk Indicators in Section 6 that assumed the branch was unrecoverable are stale; the "re-implement
from scratch" item no longer applies — this is now a located, patchable defect in ~15-25 lines across
two files, plus one new/extended test in `orchestrator.test.ts` and one in
`claude-code-otlp.plugin.test.ts`.

---

## 8. External References

None named by the task as a path/URL to read directly. The ticket does reference two sibling Jira tickets (EPMCDME-16063, EPMCDME-16064) and a GitHub PR (#634, branch `EPMCDME-15301/add-modifications-to-existing-fields-and-new-synthetic-events` @ `717a509`) as context/precondition, but these are external trackers/branches, not local files or URLs this agent could fetch; the PR branch was confirmed unavailable in this repository (see Section 2's "Critical finding"). No Jira/GitHub API access tool was available in this environment to retrieve their content directly.
