# Cursor IDE Hooks + Analytics Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `codemie proxy connect --cursor-ide --analytics` writes `.cursor/hooks.json` wiring Cursor's full native hook surface (21 events) to `codemie hook --agent cursor-ide`; every delivered event is normalized into the internal hook pipeline and captured verbatim to a project-local JSONL log, without ever blocking or slowing the user's action in Cursor.

**Architecture:** Three seams, no new architectural patterns: (1) `--agent <name>` on `codemie hook`; (2) a registered `cursor-ide` agent plugin supplying `hookConfig.eventNameMapping` and a `HookTransformer`; (3) a `cursor-ide.ts` connector in the existing per-target dispatch writing/merging `.cursor/hooks.json`. No `if (agentName === 'cursor-ide')` branch anywhere — both seams 1 and 2 are consumed through existing `AgentRegistry` lookups (`applyHookTransformation`, `normalizeEventName`) with no call-site changes.

**Tech Stack:** TypeScript, Commander, chalk, Vitest. No new dependencies.

**Spec:** `docs/superpowers/tasks/2026-09-12-cursor-ide-hooks-analytics/spec.md` (distills `/Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/plan.md`, the original 10-task human-authored plan and canonical design record — full precedent detail, mapping tables, and file/line references live there and are not re-derived here).

Commit per task using the repository's existing convention (Conventional Commits per `.ai-run/guides/standards/git-workflow.md`).

Per AGENTS.md rule 2 (this repo): no new test authoring unless the user explicitly asks. Every task below carries a `Test-first: no` line noting TDD is optional per that rule; where an existing test must be updated to stay green (Task 7), that is fixing/updating a pre-existing test, not authoring a new one, and stays in scope.

## Global Constraints

- **stdout is Cursor's response channel.** Nothing but the deliberate response object (or nothing) may reach it on the cursor-ide path — includes `logger.debug()`'s and `logger.success()`'s `console.log` calls (`src/utils/logger.ts:308`, `:317-319`).
- **The cursor-ide path must never exit non-zero.** Three exit-2 sites must each be scoped to skip cursor-ide only: `.action` body's pre-transform parse/validate checks, `validateHookEvent`'s `process.exitCode = 2` assignments, `enforceAnalyticsAuthGate`'s `process.exit(2)` (`hook.ts:570`). All other agents keep today's blocking behavior unchanged.
- `transcript_path` is nullable; every handler and `validateHookEvent` (via new `AgentHookConfig.transcriptOptional?`) must degrade cleanly with no transcript.
- `.cursor/hooks.json` is merged additively by Cursor from all config sources — the connector must upsert, never clobber, and back up on first modification.
- No token/cost data exists on any Cursor hook payload except `preCompact`.
- Canonical agent name is `cursor-ide` everywhere (flag, `--agent` value, `metadata.name`, metrics `agent` field).

---

### Task 1: Add `--agent <name>` to `codemie hook`

**Files:**
- Modify: `src/cli/commands/hook.ts:1454-1457` (`createHookCommand`), `:133-164` (`initializeLoggerContext`), `:1352-1374` (`initializeHookContext`)

**Interfaces:**
- Produces: `codemie hook --agent <name>` CLI flag, resolved agent name threaded into `initializeHookContext`. Precedence: flag beats `CODEMIE_AGENT` env; absent both, current throwing behavior unchanged.
- Consumed by: Task 8's generated `hooks.json` command string.

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert `--agent cursor-ide` resolves `agentName` with no `CODEMIE_AGENT` set.

- [ ] Step 1: Add `.option('--agent <name>', 'Agent name for hook attribution (overrides CODEMIE_AGENT)')` to `createHookCommand()`.
- [ ] Step 2: Split `initializeLoggerContext`'s two fused responsibilities — agent-name resolution (flag, then env, then throw) and session-id resolution (env, then payload-derived per Task 3) — and thread the resolved agent name into `initializeHookContext`.
- [ ] Step 3: Verify `echo '{...}' | CODEMIE_AGENT=claude codemie hook` is byte-for-byte unchanged in behavior (manual check, not an automated test).

---

### Task 2: Transform before validate; stop exiting 2 for cursor-ide

**Files:**
- Modify: `src/cli/commands/hook.ts:1461-1512` (`.action` body), `:1307-1345` (`validateHookEvent`)
- Modify: `src/agents/core/types.ts:652-667` (`AgentHookConfig`)

**Why:** `session_id` is validated at `hook.ts:1479` and again at `:1308`, both before `applyHookTransformation` (`:1499`) runs. Cursor sends `conversation_id`, not `session_id`, so the payload is rejected with `process.exit(2)` before any transformer can map it.

**Interfaces:**
- New order: parse -> resolve agent -> transform -> derive session id -> validate -> normalize -> route.
- Produces: `AgentHookConfig.transcriptOptional?: boolean`.

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert a payload with `conversation_id` and no `session_id` routes successfully for `cursor-ide`.

- [ ] Step 1: Delete the pre-transform duplicate `session_id`/`hook_event_name` checks at `:1479-1489`; `validateHookEvent` already covers both fields.
- [ ] Step 2: Move `applyHookTransformation` ahead of validation; reorder `initializeHookContext`'s `logger.setSessionId` call to run after the transform, using the transform-derived session id (Task 3 Step 5).
- [ ] Step 3: Scope the JSON-parse-failure exit code: for `cursor-ide` (known pre-stdin via Task 1's `--agent` flag), fail without exiting 2; for every other agent, keep the current `process.exit(2)` unchanged.
- [ ] Step 4: Add `transcriptOptional` to `AgentHookConfig`; honor it in `validateHookEvent`. Scope `validateHookEvent`'s three `process.exitCode = 2` assignments (`:1315`, `:1326`, `:1342`) the same way as Step 3 — for `cursor-ide`, degrade to a non-blocking failure instead.
- [ ] Step 5: Confirm no regression for Claude, Gemini, Kimi, Copilot — all four rely on this ordering and the exit-2 behavior staying intact for them.

---

### Task 3: `cursor-ide` agent plugin and hook transformer

**Files:**
- Create: `src/agents/plugins/cursor-ide/cursor-ide.constants.ts`, `cursor-ide.plugin.ts`, `cursor-ide.hook-transformer.ts`, `cursor-ide.types.ts`
- Modify: `src/agents/registry.ts:35-45` (register the plugin)
- Modify: `src/agents/core/types.ts:675-687` (`BaseHookEvent`)

**Interfaces:**
- Produces: `CursorIdePlugin` exposing `metadata.hookConfig.eventNameMapping` (Task 4's table) and `getHookTransformer()`; `CursorIdeHookEvent extends BaseHookEvent`.
- Consumed by: `applyHookTransformation` (`hook.ts:1382-1403`) and `normalizeEventName` (`hook.ts:615-651`) via existing registry lookups — no call-site changes.

**Transformer mapping** (verbatim from source plan, `plan.md:108-117`): `session_id` = `conversation_id` (fallback `session_id`, then `generation_id`); `transcript_path` = `transcript_path ?? ''`; `permission_mode` = `'default'`; `cwd` = `cwd ?? workspace_roots[0] ?? process.cwd()`; `hook_event_name` left as the Cursor-native name (not renamed by the transformer).

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would cover `conversation_id` -> `session_id` and null `transcript_path` handling.

- [ ] Step 1: Add constants — `CURSOR_IDE_AGENT_NAME = 'cursor-ide'`, display name, client type; set `metadata.analyticsOnly = true` (the sole gate excluding it from `codemie install/list/uninstall/update`, `types.ts:338`, `registry.ts:92-97` — leaving `cliCommand` unset is not sufficient on its own).
- [ ] Step 2: Add `CursorIdeHookEvent` type; add only `tool_name`, `tool_input`, `tool_output`, `tool_use_id` to shared `BaseHookEvent`, keeping Cursor-only fields in the plugin's own type.
- [ ] Step 3: Implement the transformer per the mapping above (`HookTransformer`, `types.ts:622-634`).
- [ ] Step 4: Write plugin metadata with `hookConfig` and `getHookTransformer()`; register in `src/agents/registry.ts`; confirm `AgentRegistry.getAgent('cursor-ide')` resolves.
- [ ] Step 5: Derive the CodeMie session id from the transformed `session_id` when `CODEMIE_SESSION_ID` is absent (pairs with Task 1 Step 2).

---

### Task 4: Extend the internal event surface to cover all 21 Cursor events

**Files:**
- Modify: `src/agents/core/types.ts:640-647` (`InternalHookEventName`), `:653-658` (doc comment)
- Modify: `src/cli/commands/hook.ts:663-739` (`routeHookEvent` switch), new handlers near `:600-605`

**New internal event names:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `AgentResponse`, `AgentThought`, `WorkspaceOpen`. Full 21-event mapping table: spec.md "Behavior notes" / source `plan.md:140-165`. None may fall through to `default:` (`hook.ts:703-705`).

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert each of the 21 Cursor event names routes to a non-default branch.

- [ ] Step 1: Extend `InternalHookEventName` with the 7 new names; update its doc comment and `AgentHookConfig`'s JSDoc listing valid mapping values together (per the analysis's noted convention that these two must stay in sync).
- [ ] Step 2: Add the 7 new handlers, observational only this run (debug-log and hand off to Task 6's capture); keep allocation-light, no awaited network I/O — these fire on the agent's hot path.
- [ ] Step 3: Add the corresponding switch cases in `routeHookEvent`; confirm no existing agent's routing changes.
- [ ] Step 4: Verify the post-switch transcript-marker block at `:711-725` stays inert for cursor-ide (already guarded by `event.transcript_path &&`).

---

### Task 5: Cursor stdout response contract

**Files:**
- Create: `src/agents/plugins/cursor-ide/cursor-ide.response.ts`
- Modify: `src/cli/commands/hook.ts:1461-1551` (`.action` body's success and catch paths)

**Interfaces:**
- Produces: `writeCursorResponse(cursorEventName: string): void`, applied only when the resolved agent is `cursor-ide`.
- Response matrix: `preToolUse`/`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`beforeTabFileRead`/`subagentStart` emit `{"permission":"allow"}`; `beforeSubmitPrompt` emits `{"continue":true}`; every other event emits nothing; always exit 0, including from the `catch` at `:1526-1550` (currently sets `process.exitCode = 1`).

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert a thrown internal error still yields allow + exit 0.

- [ ] Step 1: Implement the response writer per the matrix above.
- [ ] Step 2: Wire it into both the success and catch paths of the `.action` body, gated on `agentName === 'cursor-ide'`.
- [ ] Step 3: Audit stdout purity and every exit-2 site: confirm `logger.debug()`'s and `logger.success()`'s `console.log` (`src/utils/logger.ts:308`, `:317-319`) cannot reach stdout for `cursor-ide` (redirect to stderr or suppress on this path); confirm all three exit-2 sites from Task 2 are neutralized for `cursor-ide`, including `enforceAnalyticsAuthGate`'s `process.exit(2)` at `hook.ts:570` (reached via `handleUserPromptSubmit` at `:500` for `beforeSubmitPrompt` -> `UserPromptSubmit`) — a stale/missing analytics auth token must degrade to allow, not block.
- [ ] Step 4: Manual check — with `CODEMIE_DEBUG=true`, pipe a payload, assert stdout is exactly the response object or empty.

---

### Task 6: Raw event capture to the project folder (primary AC)

**Files:**
- Create: `src/agents/plugins/cursor-ide/cursor-ide.event-log.ts`
- Create: `src/utils/project-root.ts` (`resolveProjectRoot(startDir = process.cwd()): string`)
- Modify: `.gitignore`

**Why shared helper:** `resolveLocalTargetPath('.codemie')` (`src/utils/paths.ts:106`) is CWD-relative, not project-root-detecting. Both this task's log path and Task 8's connector path must resolve project root identically so the two locations can never diverge.

```ts
// src/utils/project-root.ts
function resolveProjectRoot(startDir = process.cwd()): string {
  // walk up from startDir looking for a `.git` entry; fall back to startDir if none found
}
```

```ts
// JSONL record shape, one line per delivered event
interface CursorEventLogRecord {
  received_at: string;
  hook_event_name: string;      // Cursor-native name
  internal_event_name: string;  // resolved via eventNameMapping
  session_id: string;
  conversation_id: string;
  payload: unknown;             // sanitized, size-capped raw event
}
```

**Interfaces:**
- Produces: `appendCursorEventLog(payload, cursorEventName, internalEventName, sessionId): Promise<void>`, called from the routing path for every event.
- Path: `resolveProjectRoot()` + `.codemie/logs/cursor-hook-events.jsonl`.

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert one line is appended per event with the required keys.

- [ ] Step 1: Implement `resolveProjectRoot()` (walk up for `.git`, fall back to `cwd()`).
- [ ] Step 2: Implement the appender on top of it: create parent directories on demand, append-only (never rewrite).
- [ ] Step 3: Apply `sanitizeLogArgs()` (`src/utils/security.ts`) to every record; cap per-record size and truncate oversized `content`/`output` fields with an explicit truncation marker.
- [ ] Step 4: Swallow all failures (unwritable path, read-only workspace) — capture must never break a hook or delay the agent.
- [ ] Step 5: Gate behind `CODEMIE_CURSOR_HOOK_TRACE` (default on for this release), with a size cap and rotation.
- [ ] Step 6: Add `.codemie/logs/` to `.gitignore` (check first whether the existing bare `.codemie`/`/.cursor/` ignore lines already cover it, per the technical analysis's note, to avoid a redundant duplicate line).

---

### Task 7: `--analytics` flag on `codemie proxy connect`

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:38` (`UnifiedConnectOptions`), `:292-301` (option chain), `:302-317` (action body)
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:65-73` (`ConnectOptions`), `:266-282` (`TARGET_LIST`), `:593-714` (`connectTargets`)
- Update (existing tests, not new authoring): `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:247-259`, `connect-wiring.test.ts:47,52-62` — both currently assert the `--cursor-ide`-alone short-circuit this task replaces; update their assertions to match the new per-target runner so the suite stays green.

**Gating:** `--cursor-ide --analytics` runs the Task 8 connector; `--cursor-ide` alone stays the existing no-op (do not touch); `--analytics` without `--cursor-ide` warns it applies only to `--cursor-ide`, mirroring the existing `--insiders`/`--model` warnings at `:608-616`.

**Daemon:** cursor-ide requires none — run the connector before daemon lifecycle; if cursor-ide is the only target, print the summary and return without `resolveSsoProxyConfig`/`ensureDaemon`. It is already absent from `deriveDaemonIdentity` (`:99-107`) — keep it that way.

Test-first: no — TDD optional per AGENTS.md rule 2; the two existing tests listed above must still be updated (not newly authored) so the suite stays green — that update is in scope regardless of TDD choice.

- [ ] Step 1: Add the `--analytics` option and `ConnectOptions.analytics` field.
- [ ] Step 2: Replace the short-circuit at `:600-603` with a real `runCursorIde(...)` returning a `TargetResult` (`:379-383`) so the target appears in `printSummary`.
- [ ] Step 3: Register it in the per-target dispatch at `:689-700`, plus its own pre-daemon path when it is the sole target.
- [ ] Step 4: Update `TARGET_LIST` help text, dropping "analytics only for now".
- [ ] Step 5: Update `connect-orchestrator.test.ts:247-259` and `connect-wiring.test.ts:47,52-62` to assert the new gating behavior instead of the old short-circuit.

---

### Task 8: `cursor-ide.ts` connector writing `.cursor/hooks.json`

**Files:**
- Create: `src/cli/commands/proxy/connectors/cursor-ide.ts`

**Precedent:** mirror `vscode-claude-code.ts` (read/merge/atomic-write, `{written, path}` shape) and `codex-desktop.ts` (backup: `BACKUP_SUFFIX = '.codemie-backup'`, `backupIfUnmanaged`).

```ts
// .cursor/hooks.json per-event entry
interface CursorIdeHookEntry {
  command: string; // "<resolveCodemieBinary()> hook --agent cursor-ide"
  timeout: 10;
  failClosed: false;
}

// Connector result
interface WriteCursorIdeHooksResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  events: string[];
}
```

**Interfaces:**
- Produces: `writeCursorIdeHooksConfig({ projectRoot, force }): Promise<WriteCursorIdeHooksResult>` and a `writeCursorIdeHooksConfigAtPath(configPath, ...)` test seam, mirroring `vscode-claude-code.ts:137,181`.
- Target: `<projectRoot>/.cursor/hooks.json`, `projectRoot` resolved via Task 6's `resolveProjectRoot()` (`src/utils/project-root.ts`) — the same helper Task 6 uses, so the two file locations can never diverge.

**File shape:** `version: 1`; one entry per event key of the form above; no `matcher`, no per-event argv. `failClosed: false` explicitly so analytics can never block the agent. `timeout: 10` matches Claude's `hooks.json`.

**Merge semantics:** preserve `version` if present (else set `1`); preserve every foreign hook entry under every key; upsert exactly one codemie entry per event key identified by a `hook --agent cursor-ide` substring (idempotent across binary-path changes); never delete a user entry; backup to `.cursor/hooks.json.codemie-backup` on first modification; atomic write via `writeAtomically` from `./vscode.js` (`vscode.ts:204`).

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing tests would cover fresh write, merge-with-foreign-entries, and idempotent re-run.

- [ ] Step 1: Implement path resolution (via `resolveProjectRoot()`) and the read-merge-write cycle.
- [ ] Step 2: Implement backup-before-modify and atomic write per the merge semantics above.
- [ ] Step 3: Resolve the command binary via `resolveCodemieBinary()` (`src/utils/hook-command.ts:28`) for PATH-independent absolute resolution, including the Windows `node <script>` form.
- [ ] Step 4: Emit post-write guidance from the runner (workspace must be trusted; Cursor hot-reloads `hooks.json`, restart is the documented fallback; transcripts must be enabled for `transcript_path` to be non-null; cloud agents skip `sessionStart`/`sessionEnd`/MCP/Tab/`workspaceOpen` hooks).

---

### Task 9: `codemie proxy disconnect --cursor-ide`

**Files:**
- Modify: `src/cli/commands/proxy/disconnect-orchestrator.ts:14-16` (`DisconnectTargets`, currently only `codexDesktop`)
- Modify: `src/cli/commands/proxy/index.ts` (disconnect option wiring)

**Why:** every other file-writing connector is reversible; without this, `.cursor/hooks.json` is a one-way write.

Test-first: no — TDD optional per AGENTS.md rule 2; if written, failing test would assert disconnect removes only codemie-authored entries.

- [ ] Step 1: Add the `cursorIde` target and `--cursor-ide` flag to disconnect.
- [ ] Step 2: Remove only entries matching the `hook --agent cursor-ide` command substring; drop an event key entirely once its entry list is empty; restore the `.codemie-backup` file when codemie's entries were the file's only content.

---

## Negative-constraint pass

- **stdout-purity** (spec.md Hard constraints) — honored by Task 5 (response writer + stdout audit of `logger.debug`/`logger.success`). No task writes additional stdout on the cursor-ide path.
- **cursor-ide path must never exit non-zero** — honored by Task 2 (Steps 3-4, scope the three exit-2 sites) and Task 5 (Step 3, re-confirms all three, including `enforceAnalyticsAuthGate`). No task reintroduces a blocking exit for cursor-ide.
- **No `if (agentName === 'cursor-ide')` branches in `hook.ts`** — honored by Task 3 (registry-based `eventNameMapping`/`getHookTransformer()` lookups) and Task 1 (flag threaded generically). Tasks 2 and 5 scope behavior by checking the *resolved agent name* only where the spec's own constraints require agent-specific gating (exit-code scoping, response contract) — this mirrors the spec's own explicit exceptions, not a routing branch, and no task adds a routing `if` in `routeHookEvent`/`normalizeEventName`.
- **`transcript_path` nullability** — honored by Task 2 (Step 4, `transcriptOptional` on `AgentHookConfig`) and Task 3 (transformer sets `transcript_path ?? ''`).
- **Upsert, never clobber `.cursor/hooks.json`** — honored by Task 8's merge semantics (preserve `version`, preserve foreign entries, substring-keyed upsert) and Task 9 (removes only codemie-authored entries).
- **No backend metrics mapping this run** (spec.md Non-goals) — no task in this plan touches `metrics-api-client`/`ToolUsageAttributes`/`SessionLifecycleAttributes`; Task 6 writes only the local JSONL log, confirming the non-goal is honored.
- **No new test authoring beyond fixing the 2 existing tests** (spec.md Non-goals) — every task's `Test-first` line is `no`; Task 7 is the only task touching test files, and it updates pre-existing assertions rather than adding new test files.
- **`~/.cursor/hooks.json` (user-level) out of scope** — no task targets a user-level path; Task 8 targets `<projectRoot>/.cursor/hooks.json` only.
