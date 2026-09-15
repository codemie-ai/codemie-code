# Technical Research

**Task**: Implement Cursor IDE OTLP Hook Forwarding (hook -> proxy leg)
**Generated**: 2026-09-15T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Implement Cursor IDE OTLP Hook Forwarding (hook -> proxy leg): bypass shared hook pipeline for cursor-ide via new AgentHookConfig.otlpIngestion flag, fire-and-forget forward raw events to local proxy daemon over new /v1/otlp/hook-events route, remove superseded captureEvent/cursor-ide.event-log.ts capture mechanism and dead cursor-ide code (hook-transformer, types, event-name-mapping, transcriptOptional), change cursor-ide daemon lifecycle to always ensure a daemon exists, add new proxy plugin appending events to ~/.codemie/logs/hook-events.jsonl. NOTE: this implementation has ALREADY BEEN WRITTEN and committed (commit 20db1b2 on branch EPMCDME-14834/cursor-ide-otlp-integration) by a prior agent run that skipped the normal research/spec/plan stages. Your job is to research the codebase as it stands now (hooks, proxy plugins, daemon-manager, cursor-ide plugin) to produce the technical-analysis.md this flow needs to retroactively run complexity assessment and code review against the existing diff.

---

## 2. Codebase Findings

### Existing Implementations (post-commit `20db1b2` state)

- `src/agents/core/types.ts:659-715` - `AgentHookConfig` interface. `captureEvent` and `transcriptOptional` fields removed; new `otlpIngestion?: boolean` field added, documented alongside `eventNameMapping`, `neverBlockingExit`, `writeStdoutResponse`.
- `src/cli/commands/hook.ts` - shared hook CLI command (`createHookCommand`) and pipeline:
  - `agentOtlpIngestion(agentName)` (renamed/repurposed from the old `agentTranscriptOptional`) looks up `metadata.hookConfig.otlpIngestion` via `AgentRegistry.getAgent`.
  - Inside the command's action, right after `event = JSON.parse(input)` and after the JSON-parse-failure blocking-error check, a new bypass block calls `forwardOtlpEvent(input, agentName)`, then `writeAgentStdoutResponse(agentName, event.hook_event_name)`, then `logger.close()` and returns - `applyHookTransformation`/`initializeHookContext`/`validateHookEvent`/`normalizeAndLogEvent`/`routeHookEvent` never run for an agent with `otlpIngestion: true`.
  - `routeHookEvent`'s switch lost 7 cases (`SubagentStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `AgentResponse`, `AgentThought`, `WorkspaceOpen`) and their handler functions, plus the `captureAgentEvent` call at the top of the try block.
  - `validateHookEvent` lost the `agentTranscriptOptional(agentName) ||` branch; transcript-optional is now hardcoded to `SessionStart`/`SessionEnd` only.
  - Three doc comments were left referencing deleted code: `hook.ts:637-639` ("hands off to the per-agent raw event capture (see appendCursorEventLog)" - orphaned, sits above `handlePreCompact`, no longer above any capture-related function), `hook.ts:1414-1420` (a full doc-comment block for the now-deleted `captureAgentEvent` function, left dangling directly above the `validateHookEvent` doc comment), `hook.ts:1432-1433` (`validateHookEvent`'s own doc comment still says `` `neverBlockingExit`/`transcriptOptional` hook-config flags`` — `transcriptOptional` no longer exists).
  - The `switch (normalizedEventName) {` line (`hook.ts` inside `routeHookEvent`) lost its leading indentation relative to the surrounding `try` block during the case-removal edit (cosmetic only - `npx eslint` on this file with the repo's config passes clean, and `npx tsc --noEmit` is clean repo-wide).
- `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts` (new) - `forwardOtlpEvent(rawInput, agentName)`: calls `readState()`/`isProcessAlive()` from `daemon-manager.ts`; if no daemon state or dead pid, logs at debug and returns; otherwise POSTs `{ agentName, timestamp, raw: rawInput }` JSON to `${state.url}/v1/otlp/hook-events` with `Authorization: Bearer ${state.gatewayKey}`, a manual `AbortController` + `setTimeout(1500)`, and a catch-all that logs at debug and never throws.
- `src/agents/plugins/cursor-ide/cursor-ide.plugin.ts` - `CursorIdePluginMetadata.hookConfig` now: `neverBlockingExit: true`, `writeStdoutResponse: writeCursorResponse`, `otlpIngestion: true`. Removed: `eventNameMapping: CURSOR_IDE_EVENT_NAME_MAPPING` (the 21-event table), `transcriptOptional: true`, `captureEvent: appendCursorEventLog`. `CursorIdePlugin` no longer overrides `getHookTransformer()` (removed along with its `hookTransformer` field and the `CursorIdeHookTransformer`/`HookTransformer` imports).
- Deleted in this commit: `src/agents/plugins/cursor-ide/cursor-ide.event-log.ts` (`appendCursorEventLog`, `isCursorHookTraceEnabled`, `CODEMIE_CURSOR_HOOK_TRACE` env gate, project-local `.codemie/logs/cursor-hook-events.jsonl` writer), `src/agents/plugins/cursor-ide/cursor-ide.hook-transformer.ts` (`CursorIdeHookTransformer`), `src/agents/plugins/cursor-ide/cursor-ide.types.ts` (`CursorIdeHookEvent`).
- `src/cli/commands/proxy/connect-orchestrator.ts`:
  - `EffectiveClientType` union gained `'cursor-ide'`; `DaemonIdentity.spawnOptions` gained `{ clientType: 'cursor-ide' }`; `deriveDaemonIdentity` now returns `cursor-ide` identity when `targets.cursorIde` is set and no higher-priority target (`claude-desktop`/`codex-desktop`) is present.
  - `connectTargets`: the previous early-return block (`if (targets.cursorIde) { cursorIdeResult = await runCursorIde(...); if (!otherTargets) { printSummary(...); return; } }`, called before `resolveSsoProxyConfig`/`ensureDaemon`) was deleted and replaced with only a comment: `// cursor-ide now runs as part of the unified daemon lifecycle`. **No call to `runCursorIde`/`writeCursorIdeHooksConfig` was added anywhere in the per-target dispatch block** (`connect-orchestrator.ts:752-764`, which lists `targets.claudeDesktop`/`targets.vscode`/`targets.vscodeClaudeCode`/`targets.codexDesktop` but no `targets.cursorIde` branch). `runCursorIde` (private function, `connect-orchestrator.ts:611`) and its test-only re-export `runCursorIdeForTest` (`:636`) are now reachable only from that test export - grep confirms no other call site in `src/`. Confirmed by `grep -rn "writeCursorIdeHooksConfig\|runCursorIdeForTest\|runCursorIde" src` - matches only the import, the definition, the internal call inside the now-orphaned function, and the test-only export.
  - `.cursor/hooks.json` is therefore never written by `codemie proxy connect --cursor-ide --analytics` post-commit; the daemon-ensure/identity/OTLP-route plumbing all runs, but the one thing that actually wires Cursor's native hooks up to `codemie hook --agent cursor-ide` in the first place is now dead code.
  - The stale docstring/comment at `runCursorIde`'s definition (`:605-609`, "Unlike every other target, cursor-ide needs no daemon: hooks POST directly to `/v1/metrics`...") was **not** updated, despite the plan's own text (`plan.md:157`) flagging it as stale and calling for an update as part of this change.
- `src/cli/commands/proxy/connectors/cursor-ide.ts` - `CURSOR_IDE_HOOK_EVENTS` (21-event list) kept, with its doc comment changed from "kept in sync with `CURSOR_IDE_EVENT_NAME_MAPPING`" to "used to wire all events into `.cursor/hooks.json`". The list itself (the string literals) was not touched, only the comment - `writeCursorIdeHooksConfig`/`writeCursorIdeHooksConfigAtPath` (which consume this constant) are otherwise unchanged.
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts` (new) - `OtlpIngestPlugin` (`id: '@codemie/proxy-otlp-ingest'`, `priority = 10`) / `OtlpIngestInterceptor.handleRequest`: matches `POST /v1/otlp/hook-events`; requires `ctx.metadata.gatewayKeyValidated` (401 if not set - relies on `GatewayKeyPlugin`, priority 7, having run first and set that flag); parses `ctx.requestBody` as JSON, validates `agentName`/`timestamp`/`raw` are all present (400 otherwise); appends the payload as one JSON line to `getCodemiePath('logs', 'hook-events.jsonl')` (creating the directory if needed); responds `202 Accepted`; returns `true` (fully owned, no upstream forwarding). All error paths (empty body, bad JSON, missing fields, unexpected exceptions) return `true` with an appropriate status code rather than falling through.
- `src/providers/plugins/sso/proxy/plugins/index.ts` - `OtlpIngestPlugin` imported, registered (`registerCorePlugins()`, comment says "Priority 10 - OTLP hook event ingestion"), and re-exported.

### Architecture and Layers Affected

- **Hook CLI layer** (`src/cli/commands/hook.ts`): the shared `codemie hook` command gained a per-agent bypass branch that fully short-circuits the existing transform -> validate -> normalize -> route pipeline for any agent declaring `hookConfig.otlpIngestion`.
- **Agent plugin layer** (`src/agents/plugins/cursor-ide/`): metadata-only declarative change (`otlpIngestion: true` replacing three removed fields) plus one new small forwarder module; the plugin no longer implements a `HookTransformer`.
- **Agent core types** (`src/agents/core/types.ts`): the `AgentHookConfig` contract other agent plugins also implement (`gemini`, `kimi`, `copilot-cli` still use `eventNameMapping`; no other agent used `transcriptOptional` or `captureEvent`).
- **Proxy connect-orchestrator layer** (`src/cli/commands/proxy/connect-orchestrator.ts`): daemon-identity derivation and the always-ensure-a-daemon invariant for `cursor-ide`; this is also where the missing dispatch-call regression lives.
- **Proxy plugin layer** (`src/providers/plugins/sso/proxy/plugins/`): one new `ProxyPlugin`/`ProxyInterceptor` pair registered into the same priority-sorted pipeline as the other ~15 core plugins (auth, sanitizers, normalizers, logging, session-sync).

### Integration Points

- `forwardOtlpEvent` (agent layer) depends on `readState()`/`isProcessAlive()`/`DaemonState` from `src/cli/commands/proxy/daemon-manager.ts` (cross-layer import: agent plugin code importing from the CLI/proxy command tree, matching the existing pattern of `hook.ts` already living under `src/cli/commands/`).
- `forwardOtlpEvent` uses plain global `fetch` with `AbortController`/`setTimeout(1500)` (no new dependency; Node >=20 ships `fetch`), not the repo's own `ProxyHTTPClient` (`src/providers/plugins/sso/proxy/proxy-http-client.ts`), which the plan (`plan.md:136`) explicitly reasoned is shaped for the proxy's own forwarding/retry semantics rather than a one-shot hook-side POST.
- `OtlpIngestPlugin` depends on `ctx.metadata.gatewayKeyValidated`, set exclusively by `GatewayKeyPlugin` (priority 7); `ctx.requestBody` (a `Buffer | null` populated by the raw-HTTP dispatcher in `sso.proxy.ts`); `getCodemiePath` (`src/utils/paths.ts`) for `~/.codemie/logs/hook-events.jsonl` (or under `CODEMIE_HOME` if set); `sanitizeLogArgs` (`src/utils/security.ts`) for its own warn/debug/error logging (not applied to the appended JSONL line itself - the raw Cursor payload is written to disk unsanitized, as the plan explicitly calls out as an accepted, deliberate tradeoff).
- Priority collision (not a functional bug, confirmed inert): `OtlpIngestPlugin` is registered at `priority = 10`, identical to `SSOAuthPlugin` and `JWTAuthPlugin` (both also `priority = 10`, "must run first" per their own doc comments). All three implement different interceptor hooks for different purposes (`SSOAuthPlugin`/`JWTAuthPlugin` only implement `onRequest` to inject auth headers before forwarding upstream; only `OtlpIngestPlugin` implements `handleRequest` for the specific `/v1/otlp/hook-events` route), so the tie has no observed behavioral effect today, but ties in `PluginRegistry.getEnabledPluginsSorted()`'s stable sort are resolved purely by `Map` insertion order, which is an implicit, undocumented dependency rather than an explicit one.
- `connect-orchestrator.ts`'s `deriveDaemonIdentity` gives `cursor-ide` lower priority than `claude-desktop`/`vscode-claude-code` and `codex-desktop`; combined with `--cursor-ide --analytics` plus another target, the shared daemon's identity/telemetry mode is whichever higher-priority target wins - the OTLP route itself is always present regardless of identity, since `OtlpIngestPlugin` is a core plugin unconditionally registered by `registerCorePlugins()`.

### Patterns and Conventions

- Declarative per-agent hook config: boolean flags on `AgentHookConfig` (`neverBlockingExit`, `otlpIngestion`) looked up via small `agentXxx(agentName)` helper functions in `hook.ts` that wrap `AgentRegistry.getAgent(agentName)` in a try/catch returning `false` on any failure - `agentOtlpIngestion` follows this exact shape.
- Proxy plugins: `ProxyPlugin` (metadata: `id`/`name`/`version`/`priority`, `createInterceptor(context)`) + `ProxyInterceptor` (`handleRequest`/`onRequest`/lifecycle hooks), registered via `getPluginRegistry().register(new XPlugin())` in `plugins/index.ts`, sorted ascending by `priority` at `initialize()` time. `handleRequest` returning `true` means "fully handled, stop the raw-HTTP dispatcher"; `false` falls through to the next plugin/eventual upstream forward.
- Fire-and-forget network calls from a short-lived CLI process: try/catch wrapping the whole call, `AbortSignal`/timeout, debug-level (not warn/error) logging on failure, explicit comments asserting "never throws."
- Test-only re-exports: internal, non-exported functions get a `export const xxxForTest = xxx;` alias so unit tests can reach them without widening the real public surface (`runCursorIdeForTest`, matching `runCodexDesktopForTest` immediately above it).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/integration/external-integrations.md`, `.ai-run/guides/integration/exposed-api.md` exist and cover the plugin/proxy architecture generally, but per `AGENTS.md` itself, neither `external-integrations.md` nor `docs/AGENTS.md` is guaranteed current for every agent plugin (explicitly called out for Pi; cursor-ide is not called out either way, so treat as unconfirmed rather than assume coverage).
- No guide specifically documents the hook-pipeline bypass pattern (`otlpIngestion`) or the OTLP-ingest proxy route - both are new as of this commit.

### Architectural Decisions

- `plan.md` (repo root, committed in the same commit as the implementation) is the design record for this change: states the problem (cursor-ide's `captureEvent` mechanism and the shared pipeline's per-event analytics side effects are both wrong for cursor-ide), the chosen architecture (full pipeline bypass rather than a branch inside `routeHookEvent`), explicit scope boundaries (hook -> proxy leg only; no backend/OTLP-collector delivery; no defined record schema; no sanitization/truncation of the forwarded payload; no session-id derivation; no local fallback if the daemon POST fails), and an explicit list of "Open implementation details" including "Confirm removing the 7 dead handler functions/switch cases... doesn't affect any other agent" and "Confirm no other code references `CODEMIE_CURSOR_HOOK_TRACE` or `.codemie/logs/cursor-hook-events.jsonl`... before deleting" - both confirmed clean in this research pass (see Section 2's grep results: only historical docs under `docs/superpowers/tasks/2026-09-12-.../` reference the deleted symbols, no live code or other guides do).
- `plan.md` explicitly documents the daemon-lifecycle change's intended shape (§4: "remove the early-return fast path... goes through the same `resolveSsoProxyConfig` -> `ensureDaemon` flow as every other target... `runCursorIde` (writing `.cursor/hooks.json`) still runs - its own logic doesn't change, only when it's called relative to daemon setup"). The shipped diff does not match this: `runCursorIde` is no longer called at all (see Section 2, Integration Points and connect-orchestrator findings) - the plan's own intent was not fully carried through to the diff.
- `plan.md` §4 also explicitly instructs updating `runCursorIde`'s stale docstring and the inline comment at the old early-return site once the daemon-need premise changes; the shipped diff updated neither (the `:605-609` docstring is untouched; the `:664-666` comment block was left dangling with only a trailing one-line note added, not rewritten).

### Derived Conventions

- Removing a declarative `AgentHookConfig` field requires: removing the field from the interface, removing/renaming its lookup helper in `hook.ts`, removing every setter in the owning agent plugin(s), and removing its read site(s) in the pipeline (`validateHookEvent`, `routeHookEvent`, etc.) - this commit did that consistently for `transcriptOptional` and `captureEvent`, but left three doc comments referencing the removed symbols/functions unedited (Section 2).
- Adding a proxy plugin requires: implementing `ProxyPlugin`/`ProxyInterceptor` in its own file under `plugins/`, importing and `registry.register(...)`-ing it in `plugins/index.ts` with a priority comment, and re-exporting the class - followed correctly for `OtlpIngestPlugin`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` has one cursor-ide-specific test: `'--cursor-ide alone (without --analytics) explains --analytics is required and does no daemon/profile work'` (`:247-259`) - asserts `ConfigLoader.load`/`checkStatus`/`spawnDaemon` are not called and a specific warning is printed. This exercises the `!analytics` early-return guard (`connect-orchestrator.ts:656-661`), which is unrelated to and unaffected by this commit's daemon-lifecycle change. **No test exercises `--cursor-ide --analytics`** (the actually-changed path), so the missing `runCursorIde` dispatch call (Section 2) has no failing test to surface it.
- `src/providers/plugins/sso/proxy/plugins/__tests__/gateway-key.plugin.test.ts` covers the `GatewayKeyPlugin` that `OtlpIngestPlugin` depends on for `gatewayKeyValidated`, but there is no test file for `otlp-ingest.plugin.ts` itself.
- No test file exists for `cursor-ide.plugin.ts`, `cursor-ide.otlp-forwarder.ts`, or the `agentOtlpIngestion`/OTLP-bypass branch in `hook.ts` (`hook-routing-contract.test.ts`, `hook.lock.test.ts`, `hook.session-origin.test.ts` exist for `hook.ts` generally but none reference `otlpIngestion`, `forwardOtlpEvent`, or `cursor-ide`).
- `src/providers/plugins/sso/proxy/plugins/__tests__/` has co-located test files for most other core plugins (`endpoint-blocker`, `gateway-key`, `request-sanitizer`, `sso.session-sync`, the request-normalizers, the encrypted-content-sanitizers) - `otlp-ingest.plugin.ts` is the one core plugin in that directory without a matching test.

### Testing Framework and Patterns

- Vitest, per `vitest.config.ts`'s `unit` project (`src/**/*.test.ts`/`*.spec.ts`, co-located with source, `globals: true`, `environment: 'node'`, isolated `CODEMIE_HOME` per test-process pid) and the `cli` project (`tests/integration/**/*.test.ts`, excluding `agent-*.test.ts`).
- Proxy-plugin tests (per existing files in `plugins/__tests__/`) construct a `PluginContext`, call `createInterceptor`, and invoke `handleRequest` directly with mocked `ProxyContext`/`res`/`ProxyHTTPClient`, asserting status codes and `res.end` payloads - this is the established seam `otlp-ingest.plugin.ts` would use if tested.
- `connect-orchestrator.test.ts` mocks `daemon-manager.ts` (`checkStatus`, `spawnDaemon`) and `ConfigLoader`, then asserts on `console.log` calls and which mocked functions were/weren't invoked - the established seam for verifying `runCursorIde`/`writeCursorIdeHooksConfig` dispatch, not currently exercised for the `--analytics` path.

### Coverage Gaps

- No test asserts that `codemie proxy connect --cursor-ide --analytics` still writes `.cursor/hooks.json` (i.e., that `runCursorIde`/`writeCursorIdeHooksConfig` is actually invoked) - this is the gap that let the missing-dispatch-call regression (Section 2) ship untested.
- No test for `agentOtlpIngestion()` or the hook.ts bypass branch (forward-and-exit-early behavior, interaction with `writeAgentStdoutResponse`, confirming the shared pipeline is skipped).
- No test for `forwardOtlpEvent()` (no-daemon-state case, dead-pid case, non-2xx response, timeout/abort case).
- No test for `OtlpIngestPlugin`/`OtlpIngestInterceptor` (route matching, unauthenticated-request 401, missing-body 400, missing-field 400, malformed-JSON 400, successful-append 202, unexpected-exception 500).
- No test for `deriveDaemonIdentity`'s new `cursor-ide` branch or for the priority ordering (`claude-desktop` > `codex-desktop` > `cursor-ide` > default).

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_CURSOR_HOOK_TRACE` (the gate for the now-deleted `cursor-ide.event-log.ts` capture) is fully removed from live code; grep confirms no remaining reference outside historical docs under `docs/superpowers/tasks/2026-09-12-.../`.
- `CODEMIE_HOME` (existing, general) determines where `getCodemiePath('logs', 'hook-events.jsonl')` resolves, via `getCodemieHome()` in `src/utils/paths.ts`.

### Configuration Files

- No project-local `.codemie/logs/cursor-hook-events.jsonl` output path exists anymore (deleted along with `cursor-ide.event-log.ts`); the new sink is the global `~/.codemie/logs/hook-events.jsonl` (or under `CODEMIE_HOME`), appended to by `OtlpIngestPlugin`.
- `~/.codemie/proxy-daemon.json` (`DaemonState`, written by `spawnDaemon`/`writeState` in `daemon-manager.ts`) is what `forwardOtlpEvent` reads via `readState()` to get `url`/`gatewayKey`/`pid`.
- `.cursor/hooks.json` (project-local, written by `writeCursorIdeHooksConfig`/`writeCursorIdeHooksConfigAtPath` in `connectors/cursor-ide.ts`) is the file that wires Cursor's 21 native hook events to `codemie hook --agent cursor-ide` - per Section 2, this file is no longer written by `codemie proxy connect --cursor-ide --analytics` post-commit.

### Feature Flags and Deployment Concerns

- `otlpIngestion` itself functions as a per-agent feature flag on `AgentHookConfig`, currently set only by `cursor-ide.plugin.ts`.
- The daemon lifecycle change makes `--cursor-ide --analytics` require a valid resolved SSO/JWT profile (`resolveSsoProxyConfig` -> `ensureDaemon`) where previously it required none - a `codemie proxy connect --cursor-ide --analytics` run with no configured profile now fails differently (via the shared `resolveSsoProxyConfig`/`ConfigurationError` path) than it did before this commit (where it succeeded standalone with no profile dependency at all).

---

## 6. Risk Indicators

- **Speculative-free, directly observed regression**: `codemie proxy connect --cursor-ide --analytics` no longer writes `.cursor/hooks.json`. The early-return fast path that called `runCursorIde()` was deleted and replaced with a comment claiming cursor-ide "now runs as part of the unified daemon lifecycle," but no call to `runCursorIde`/`writeCursorIdeHooksConfig` was added to the per-target dispatch block (`connect-orchestrator.ts:752-764`). `runCursorIde` and its test-only export `runCursorIdeForTest` are unreachable from any production code path. This breaks the feature end-to-end: the daemon and OTLP route exist, but Cursor is never actually configured to call `codemie hook --agent cursor-ide` in the first place on a fresh `connect`. No existing test exercises `--cursor-ide --analytics` to catch this.
- Stale documentation left in the diff, directly contradicting current code: `runCursorIde`'s docstring (`connect-orchestrator.ts:605-609`, "cursor-ide needs no daemon... hooks POST directly to `/v1/metrics`") and the comment block at the old early-return site (`:664-666`) both still describe the pre-commit behavior; `hook.ts:637-639` and `hook.ts:1414-1420` reference the deleted `appendCursorEventLog`/`captureAgentEvent`. `plan.md` itself flagged both `connect-orchestrator.ts` comments as needing an update as part of this deliverable (plan.md:157) - that instruction wasn't followed.
- No automated test coverage at all for any of the five new/changed production behaviors: the `hook.ts` OTLP bypass branch, `agentOtlpIngestion()`, `forwardOtlpEvent()`, `OtlpIngestPlugin`/`OtlpIngestInterceptor`, and the `deriveDaemonIdentity`/dispatch changes in `connect-orchestrator.ts`. `otlp-ingest.plugin.ts` is the only core proxy plugin under `plugins/` without a co-located test file.
- Unsanitized raw payload written to a global, per-user file: `OtlpIngestPlugin` appends the client-submitted `raw` string verbatim to `~/.codemie/logs/hook-events.jsonl` with no truncation/sanitization (unlike the deleted `cursor-ide.event-log.ts`, which truncated large fields and ran `sanitizeLogArgs` on the payload before writing). This is an explicit, plan-documented tradeoff (plan.md's Non-goals section), not an oversight, but it is a durable-storage exposure surface worth flagging: any secret/PII a tool's stdout/stderr/file-diff happened to contain in a Cursor hook payload is now durably persisted, globally, unsanitized, on every machine running the daemon.
- `OtlpIngestPlugin` priority (10) collides with `SSOAuthPlugin`/`JWTAuthPlugin` (both also 10); currently inert (no two priority-10 plugins implement the same interceptor hook for the same route) but an implicit ordering dependency resolved only by `Map` insertion order in `PluginRegistry`, not by an explicit priority value - fragile if a future priority-10 plugin also implements `handleRequest`.
- No local fallback if the daemon POST fails (dead daemon, network error, non-2xx) - the event is dropped with no record anywhere, a deliberate, plan-documented tradeoff versus the removed `cursor-ide.event-log.ts` (which always wrote locally regardless of proxy state). Confirms a functional gap in reliability that was accepted, not missed - flagged here only as a downstream-consumer risk (any code hoping to reconstruct a complete session's hook-event stream from `hook-events.jsonl` cannot assume completeness).
- `--cursor-ide --analytics` now has a hard dependency on a resolvable SSO/JWT profile (`resolveSsoProxyConfig`) that it did not have before this commit; combined with the dispatch-call regression above, a user with no configured profile now gets a `ConfigurationError` from the shared proxy-connect flow instead of the pre-commit standalone-success path, further reducing this target's independence from the rest of the daemon lifecycle.

---

## 7. Summary for Complexity Assessment

This change touches four architectural layers in a single commit with no separate research/spec/plan review: the shared hook CLI pipeline (`hook.ts` - new bypass branch, removed dead handler functions/switch cases, removed a declarative capture mechanism and its read site), the cursor-ide agent plugin (metadata rewrite, transformer/types/event-mapping/capture-file deletions, one new small forwarder module), the proxy connect-orchestrator (daemon-identity union extended, an early-return fast path removed with an intended-but-not-delivered replacement in the per-target dispatch block), and the proxy plugin pipeline (one new core plugin following the established `ProxyPlugin`/`ProxyInterceptor` pattern, registered at a priority that ties with two existing plugins). `npx tsc --noEmit` and `npx eslint` on the touched files both pass clean, so the change is internally type-safe and lint-clean; the risks are functional/behavioral and testing-coverage risks, not build risks.

The most consequential finding is a real, directly-observed functional regression: the commit's intended behavior (per its own `plan.md`, written in the same commit) was for `runCursorIde`/`writeCursorIdeHooksConfig` to keep running, just later in the sequence relative to the new daemon-ensure step. The shipped diff instead deleted the only call site without adding a replacement, so `.cursor/hooks.json` is never written by `codemie proxy connect --cursor-ide --analytics` anymore - the daemon and OTLP-ingest route this deliverable was built to enable exist and are reachable, but Cursor is never wired up to call them on a fresh connect. This has no test coverage to catch it: the one existing cursor-ide test in `connect-orchestrator.test.ts` only exercises the unrelated "`--analytics` missing" guard, not the `--cursor-ide --analytics` path this commit changed.

Beyond that regression, the commit leaves several stale doc comments describing pre-commit behavior (two in `connect-orchestrator.ts`, two in `hook.ts`) despite `plan.md` explicitly calling out the `connect-orchestrator.ts` ones for update, and ships zero new tests for any of its five new/changed behaviors (hook bypass, forwarder, proxy plugin, daemon-identity branch, dispatch change) even though the repo has an established, directly-applicable test pattern for each (co-located plugin tests, `connect-orchestrator.test.ts`'s mock-and-assert pattern). Combined, this is a case where the individual mechanisms (declarative hook-config flag, fire-and-forget forwarder, priority-sorted proxy plugin) are each simple and match existing conventions well, but the integration between them was not fully wired through, and nothing in the current test suite would have caught it.

---

## 8. External References

None named by the task. The task references the prior commit (`20db1b2` on this same branch) as the subject of research, which is an internal git commit in this repository rather than an external file/URL - it was read directly via `git show 20db1b2` and is fully reflected in Section 2 above, not treated as an external reference requiring separate resolution.
