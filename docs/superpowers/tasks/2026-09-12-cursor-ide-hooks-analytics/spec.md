# Spec: Cursor IDE Hooks + Analytics Ingestion

**Classification:** Architectural (cross-layer, touches a shared core contract, new external-integration surface). Canonical source: `/Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/plan.md` — a complete, already-approved 10-task plan. This spec distills its WHAT/WHY for downstream planning and acceptance review; it does not restate its task-by-task HOW.

## Goal

`codemie proxy connect --cursor-ide --analytics` writes `.cursor/hooks.json` wiring Cursor's full native hook surface (21 events) to `codemie hook --agent cursor-ide`. Every delivered event is normalized into the internal hook pipeline and captured verbatim to a project-local JSONL log, without ever blocking or slowing the user's action in Cursor.

## Architecture — three seams, no new patterns

1. **`--agent <name>` on `codemie hook`** (`src/cli/commands/hook.ts:1454-1457,133-164,1352-1374`) — lets a hook process CodeMie did not spawn identify its agent, since Cursor's `hooks.json` schema has no `env` key to inherit `CODEMIE_AGENT` through. Precedence: flag beats env; absent both, current throwing behavior is unchanged.
2. **`cursor-ide` agent plugin** (new `src/agents/plugins/cursor-ide/`, registered in `src/agents/registry.ts`) — supplies `metadata.hookConfig.eventNameMapping` (Cursor event name -> one of 14 internal names) and a `HookTransformer` mapping `conversation_id` -> `session_id`. `metadata.analyticsOnly = true` excludes it from `codemie install/list/uninstall/update` (the sole such gate, `types.ts:338`, `registry.ts:92-97`).
3. **`cursor-ide.ts` connector** (new, `src/cli/commands/proxy/connectors/`) — writes/merges `.cursor/hooks.json` at the detected project root.

No `if (agentName === 'cursor-ide')` branch is added anywhere in `hook.ts`; both seams 1 and 2 are consumed through existing `AgentRegistry` lookups (`applyHookTransformation`, `normalizeEventName`) with no call-site changes.

## Hard constraints

- **stdout is Cursor's response channel.** Nothing but the deliberate response object (or nothing) may reach it on the cursor-ide path — this includes `logger.debug()`'s and `logger.success()`'s `console.log` calls.
- **The cursor-ide path must never exit non-zero.** Three independent exit-2 sites must each be scoped to skip cursor-ide only: the `.action` body's pre-transform parse/validate checks, `validateHookEvent`'s `process.exitCode = 2` assignments, and `enforceAnalyticsAuthGate`'s `process.exit(2)` (`hook.ts:570`, reachable via `beforeSubmitPrompt` -> `UserPromptSubmit`). All other agents keep today's blocking behavior unchanged.
- `transcript_path` is nullable; every handler and `validateHookEvent` (via a new declarative `AgentHookConfig.transcriptOptional?`) must degrade cleanly with no transcript.
- `.cursor/hooks.json` is merged additively by Cursor from all config sources — the connector must upsert, never clobber, and back up on first modification.
- No token/cost data exists on any Cursor hook payload except `preCompact`.

## New data shapes

```ts
// JSONL log record — one line per delivered event, appended to
// <projectRoot>/.codemie/logs/cursor-hook-events.jsonl
interface CursorEventLogRecord {
  received_at: string;
  hook_event_name: string;      // Cursor-native name
  internal_event_name: string;  // resolved via eventNameMapping
  session_id: string;
  conversation_id: string;
  payload: unknown;             // sanitized, size-capped raw event
}

// .cursor/hooks.json per-event entry written by the connector
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

## Behavior notes

- 21 Cursor events map onto 7 new + 7 existing internal names (full table: `plan.md:140-165`). None may fall through `routeHookEvent`'s `default:` branch, whose silent log-and-ignore (`hook.ts:703-705`) would otherwise hide a mapping gap.
- Response matrix: permission-capable events (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `subagentStart`) emit `{"permission":"allow"}`; `beforeSubmitPrompt` emits `{"continue":true}`; every other event emits nothing. Always exit 0, including from the catch path.
- Event log and connector share one new `resolveProjectRoot()` helper (`src/utils/project-root.ts`, walk up for `.git`, fall back to `cwd()`) so the two file locations can never diverge, since `resolveLocalTargetPath` (`paths.ts:106`) is CWD-relative only.
- Raw payloads (full file content, shell commands, edit diffs) are sanitized via `sanitizeLogArgs()` and size-capped with explicit truncation markers before persisting; capture failures are swallowed and never block or delay the hook.
- Connector upsert is keyed by a `hook --agent cursor-ide` command substring (idempotent across binary-path changes), preserves foreign entries and `version`, and backs up to `.cursor/hooks.json.codemie-backup` on first modification (`codex-desktop.ts` precedent, not `vscode-claude-code.ts`'s no-backup precedent).
- `--analytics` gates the connector; `--cursor-ide` alone stays a no-op (already in place); `--analytics` without `--cursor-ide` warns and changes nothing else. cursor-ide never touches `resolveSsoProxyConfig` or daemon lifecycle and appears in `printSummary` as its own `TargetResult`.
- `codemie proxy disconnect --cursor-ide` removes only codemie-authored entries, drops emptied event keys, and restores the backup if codemie's entries were the file's only content.

## Acceptance criteria

- `echo '<payload>' | codemie hook --agent cursor-ide` succeeds with no `CODEMIE_AGENT`/`CODEMIE_SESSION_ID` in the environment.
- `codemie proxy connect --cursor-ide --analytics` writes `.cursor/hooks.json` at the project root with all 21 event keys pointing at an absolute-path-resolved `codemie hook --agent cursor-ide`.
- Re-running is idempotent: no duplicate entries, `version` preserved, foreign entries preserved, backup written on first modification only.
- `--cursor-ide` without `--analytics` explains the requirement and exits 0 without writing anything.
- `--analytics` without `--cursor-ide` warns and does not alter other targets.
- cursor-ide never calls `resolveSsoProxyConfig`/daemon lifecycle; appears in `printSummary` as its own `TargetResult`.
- All 21 Cursor events route to a real handler; none hits `routeHookEvent`'s `default:`.
- `conversation_id` becomes both the internal `session_id` and the CodeMie session id.
- **Primary AC:** every delivered event appends one JSON line (shape above) to `<project>/.codemie/logs/cursor-hook-events.jsonl`.
- Response matrix (above) holds; exit code is always 0.
- An induced internal error (malformed payload, unwritable log path, missing profile config, stale analytics auth) still allows the action and exits 0.
- `CODEMIE_DEBUG=true codemie hook --agent cursor-ide` writes no log text to stdout.
- `npm run lint`, `npm run typecheck`, `npm run build` pass.

## Non-goals (out of scope for this run — plan.md's follow-up backlog)

- Backend metrics mapping: building `ToolUsageAttributes`/`SessionLifecycleAttributes` deltas from Cursor events and flushing to `/v1/metrics`. `--analytics` installs the hooks and captures the JSONL log only; no new data reaches the metrics backend this run.
- Revisiting `copilot-cli`'s lossy `PreToolUse`/`PostToolUse` mapping now that real internal events exist.
- `~/.cursor/hooks.json` (user-level) as an opt-in alternative to the project-level file.
- Documenting the token/cost gap in analytics output for Cursor sessions.
- New test authoring (per AGENTS.md rule 2) beyond updating the two existing proxy tests that assert the current `--cursor-ide`-alone short-circuit.

## Known regressions to update, not avoid

- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:247-259` and `connect-wiring.test.ts:47,52-62` assert today's `--cursor-ide`-alone short-circuit and must be updated once the real per-target runner replaces it.

## Open risks

- `hook.ts` has no dedicated unit test file; the transform-before-validate reordering and the three exit-2 scoping sites are the highest-risk, least-covered part of this change — a missed site silently reintroduces blocking behavior for Cursor only, with no automated signal.
- `normalizeEventName`'s silent fallback (unmapped event names route to `default:` and are logged, not errored) makes 21-event mapping completeness a correctness property with no fail-loud check.
- Raw-payload sanitization/size-capping for full-file-content and shell-command payloads has no prior in-repo precedent at this scale; sufficiency is unverified until manual e2e (plan.md Task 10).
