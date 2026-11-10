# Spec — EPMCDME-16647 QA fix: first-session OTLP endpoint loss on daemon respawn

## Problem

The merged fix (CLI 0.16.5/0.16.6) rewrites `~/.claude/settings.json`'s OTLP endpoint during the
`SessionStart` hook (`refreshClaudeCodeOtlpEndpoint` via `ensureOtlpProxy`,
`src/cli/commands/proxy/otlp-cold-start.ts:131-177`,
`src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts:74-100`). QA found that this runs
*after* Claude Code's own process has already read settings.json and initialized its native OTel
exporter, so the very first session after a proxy-daemon port respawn still exports native
telemetry to the dead port — only the *next* session picks up the rewrite
(`technical-analysis.md:22-29`).

## Approach

Call the existing `ensureOtlpProxy('claude-code-otlp')` primitive — unchanged — from the claude
plugin's pre-spawn `beforeRun` lifecycle hook
(`src/agents/plugins/claude/claude.plugin.ts:240`), which is provider-agnostic and shared by both
`codemie-claude` and `claude-acp` (`ClaudeAcpPluginMetadata` spreads `ClaudePluginMetadata`,
inheriting `lifecycle.beforeRun`; `claude-acp.plugin.ts:16-18`). This runs strictly before
`BaseAgentAdapter.runSession` spawns the child (`BaseAgentAdapter.ts:924`), so when the call lands
it rewrites `~/.claude/settings.json` *before* Claude Code's own process reads it — fixing the
gap for the launching session itself, not just the next one.

The call is gated: only fire it when `claude-code-otlp` is already connected, i.e. CodeMie already
owns the `OTEL_EXPORTER_OTLP_*` keys in `~/.claude/settings.json` (the same ownership check
`readOwnedOtlpEnv`/`isCodemieOwnedEnvValue` already performs internally,
`claude-code-otlp-endpoint.ts:16-27`). A new small exported check is needed since that function is
currently private to the connector module:

```ts
// src/cli/commands/proxy/connectors/claude-code-otlp-endpoint.ts
export async function isClaudeCodeOtlpConnected(): Promise<boolean>;
```

Without this gate, every managed claude/claude-acp launch would start the proxy daemon as a side
effect, including for users who never ran `codemie proxy connect --claude-code-otlp`.

Injecting `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` directly into the spawned
child's process env — the ticket's originally suggested direction — is not viable: this codebase
already found, for the structurally identical `ANTHROPIC_BASE_URL` case (EPMCDME-10988), that
Claude Code's settings.json `env` block overrides spawn-time process env for any key it declares,
and `claude-code-otlp` already declares both OTEL keys there once connected
(`technical-analysis.md:91-98`). Rewriting settings.json itself, earlier, is the only lever that
can work for the managed path.

The existing `SessionStart`-hook rewrite is left in place unchanged — it remains the correction
path for native launches and a safety net for a respawn that happens mid-session.

## Non-goals

- Fixing the first-session gap for native (unmanaged) `claude` launches. User decision: out of
  scope for this fix; that path keeps today's known "fixed from the second session onward"
  behavior, since there is no CodeMie-owned pre-spawn moment when the user runs `claude` directly
  (`technical-analysis.md:87, 106`).
- Any new standing/background infrastructure (e.g. a watchdog) to pre-correct native launches.
- Injecting OTEL env vars directly into the spawned child's process environment.
- A generic, cross-adapter "resolve+inject OTLP endpoint pre-spawn" mechanism on
  `BaseAgentAdapter` — no other OTLP adapter plugin shares this native-env-export problem today
  (`copilot-chat-otlp`/`copilot-cli-otlp` are hooks-only, `technical-analysis.md:189`), so a generic
  mechanism would be new infrastructure for a single consumer.
- Changing `ensureOtlpProxy`'s or `refreshClaudeCodeOtlpEndpoint`'s existing contract (ownership
  guard, non-blocking-on-failure, idempotency) — both are reused as-is.
- Removing or altering the existing `SessionStart` hook-time rewrite.

## Acceptance Criteria

1. A managed `codemie-claude`/`claude-acp` launch, with `claude-code-otlp` already connected and
   the daemon having respawned on a new port since the endpoint was last written, has the correct
   endpoint written to `~/.claude/settings.json` before the Claude Code process/SDK starts — the
   first session after the respawn exports native OTel telemetry correctly.
2. When `claude-code-otlp` was never connected, a managed launch does not start or otherwise touch
   the proxy daemon as a side effect of this change; launch behavior/latency is unchanged.
3. A pre-spawn daemon-start or endpoint-refresh failure never blocks or fails the launch, per
   `ensureOtlpProxy`'s existing non-blocking contract.
4. The existing `SessionStart` hook-time rewrite still runs and still covers native launches and
   mid-session respawns.
5. Native (unmanaged) `claude` launches are unchanged — still "fixed from the second session
   onward" as today.

## Decisions

- Call `ensureOtlpProxy` from the claude plugin's pre-spawn `beforeRun` hook over building a new
  standalone pre-spawn mechanism — `beforeRun` is the exact provider-agnostic, pre-`spawn()` seam
  the research found already mutating env.
- Keep using `ensureOtlpProxy`'s settings.json rewrite over injecting OTEL env vars into the
  spawned child's process env — settings.json's own `env` block wins over spawn-time process env
  for this variable family (EPMCDME-10988 precedent), so direct injection would be silently
  discarded whenever `claude-code-otlp` is connected.
- Gate the pre-spawn call on `claude-code-otlp` already being connected over calling it
  unconditionally — unconditional calls would start the proxy daemon for every managed launch,
  including users who never connected OTLP.
- Scope the fix to the claude plugin's `beforeRun` over a new generic `BaseAgentAdapter`-level
  mechanism — no other OTLP adapter plugin has this native-env-export problem today, so a generic
  mechanism would have a single consumer.
- Fix pre-spawn timing for managed launches (`codemie-claude`, `claude-acp`) only; leave native
  (unmanaged) `claude` launches on today's hook-time-only behavior, with no new background
  infrastructure for that path. — user
- Leave the existing `SessionStart` hook-time rewrite in place unchanged — it is still needed for
  native launches and as a mid-session respawn safety net.

## Open Risks

- The ACP launch path (`claude-agent-acp`, wrapping the Claude Agent SDK) may not read
  `~/.claude/settings.json` at its own startup the same way the native `claude` CLI does; this is
  unverified in the technical analysis. If the SDK consumes OTel config differently, the pre-spawn
  settings.json write may not take effect for `claude-acp` specifically even though `beforeRun`
  fires for it.
- No automated test can prove the actual timing fix (Claude Code's own OTel SDK init vs. its
  settings.json read) — confirmation rests on production/manual verification, as it did for the
  QA finding that opened this ticket.
- The pre-spawn call adds `ensureOtlpProxy`'s cold-start latency (daemon spawn, when not already
  live) to every connected managed launch, not only the first one after a respawn — bounded, and
  already incurred elsewhere during a session (every hook event calls `ensureOtlpProxy` too,
  `OtlpAgentAdapter.ts:118`), but this is the first time it sits on the launch's critical path.
