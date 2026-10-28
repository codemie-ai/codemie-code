# T2 findings: `claude -p` end-of-session loss (code reading only)

Paths relative to the codemie-code repository root. Nothing here measured from prod; items marked "inferred" are not verified.

## 1. Trace of a headless run

Hook delivery (OTLP path; `codemie hook --agent claude-code-otlp`, src/cli/commands/hook.ts:1541 -> OtlpAgentAdapter):
- Hooks are installed with `timeout: 30` for every event except PostCompact (src/cli/commands/proxy/connectors/claude-code-otlp.ts:228, 240, 584). SessionEnd is synchronous.
- SessionEnd handler does transcript parse + two git resolutions BEFORE any send (src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:277-285), then returns `retryOnce: true` (l.300).
- Send: src/agents/plugins/utils.ts:6 `FORWARD_TIMEOUT_MS = 3_000`, abort via AbortController (l.37). OtlpAgentAdapter.ts:118-121: one resend of the same bytes if not accepted. So worst case is ~3s + 3s of send after the handler's own work. Both failures return false; finalize(false) leaves the parse-state cursor uncommitted, but no later hook exists in a `-p` run to re-derive it (comment at plugin.ts:295 says the same).
- Whether Claude Code in `-p` mode lets the SessionEnd hook finish before the process exits: not determinable from this repo (inferred, not measured: Claude Code applies its own, shorter SessionEnd hook timeout and may kill the hook at exit; hook.ts:251-253 states "Claude Code kills the hook process quickly at exit" for the legacy path, which is a prior observation in a comment, not a measurement). The configured 30s is probably not the effective limit at exit. If the hook is killed, nothing is written to the spool at all (the spool write happens only via the daemon POST).
- src/cli/commands/hook.ts handleSessionEnd (l.225) and its 2000 ms sync budget (l.251-297) belong to the legacy non-OTLP session-sync path; they do not apply to claude-code-otlp events.

What survives if SessionEnd is lost:
- `Stop` (fires at the end of the turn, in `-p` once) runs the same full transcript pass with commit-after-send (plugin.ts:220-230, uses openMainTranscriptPass). Transcript-derived events (usage, summary stats per orchestrator.ts "every Stop/SessionEnd") are therefore normally already in the spool before SessionEnd. Cost is expected to be collected via Stop; lost are `agent.session.end` and `agent.git.snapshot` (commits and HEAD end), plus anything appended to the transcript between Stop and exit. (inferred from code, not measured.)
- Whether the backend needs `agent.session.end` to treat the session as complete or to compute duration: backend question, not answered here.

## 2. Does the sweep close a session without agent.session.end?

No. src/providers/plugins/sso/proxy/plugins/otlp-spool/sweep.ts is garbage collection only: it deletes a session's spool/status files when all streams are drained and the session was idle for OTLP_ABANDONED_SESSION_GRACE_MINUTES (60, spool-config.ts:74) measured from the last spool-file write (sweep.ts:55-70; endedAt path uses 15 min). It never forwards anything and never synthesizes an event. Delivered data is not lost by it (drained precondition). Forwarding of an unended session is governed by completeness-gate.ts: hooks+OTEL -> send; hooks-only -> hooks-only-force after OTLP_SEND_MAX_ATTEMPTS (3) ticks of 2 min (~6 min), so a session without SessionEnd is still forwarded; OTEL-only -> skip (invariant, untouched). `markSessionEnded` (session-status.ts:124) is called only when a forwarded event has type `agent.session.end` (forwarder.ts:198), i.e. an unended session just stays "abandoned" until GC; nothing "closes" it on the backend.

## 3. Decision: no fix in this task

The suggested fix (sweep closes sessions lacking agent.session.end) does not fit in two files:
- The sweep runs in the proxy daemon with no hook context. A synthesized `agent.session.end` needs agent-owned common fields (platform, version, entrypoint), event_id, timestamps and the pinned project; ARCHITECTURE-OTLP-PLUGIN.md forbids the forwarder/daemon from calling back into the adapter or enriching events, and the sweep runs only after streams are drained and would have to write a new spool record and re-trigger forwarding (spool-io, forwarder, sweep, adapter and event-id builder), plus guarding against a late genuine SessionEnd producing a duplicate with a different event_id.
- Without the backend contract for what a missing `agent.session.end` costs (completeness, duration, git snapshot), a synthetic event could be wrong. Needs backend confirmation first.
- Cheaper partial mitigations (raise forward timeout, drop retryOnce delay) do not address the likely actual cause (hook killed by Claude Code at exit, before/during the send) and are unmeasured.

Existing tests: none edited; none stale (no code changed).

## 4. Ready-to-file ticket draft

Title: claude -p (headless) sessions can lose agent.session.end and agent.git.snapshot when SessionEnd hook is cut off at exit

Relates to: EPMCDME-16441 (pattern P3)

Evidence:
- SessionEnd handler does transcript parse + git lookups before the send (claude-code-otlp.plugin.ts:277-285); send aborts at 3s with one resend (agents/plugins/utils.ts:6,37; core/OtlpAgentAdapter.ts:118-121). If the process is killed or the send fails, no later hook retries (plugin.ts:295).
- Sweep (otlp-spool/sweep.ts) is GC only; it never closes or forwards an unended session. Hooks-only sessions are force-forwarded after ~6 min (completeness-gate.ts, spool-config.ts), so data from Stop is delivered, but `agent.session.end`/`agent.git.snapshot` are absent.
- Not measured: the effective SessionEnd hook deadline in `claude -p`; production frequency; backend behavior for sessions with no `agent.session.end`.

To do: (1) measure on a real `claude -p` run with CODEMIE_DEBUG whether the SessionEnd hook reaches the spool; (2) backend: confirm what a missing agent.session.end affects; (3) if it matters, design a minimal-latency SessionEnd path (spool write before git/transcript work, or emit end marker from Stop in headless mode) or a daemon-side close that goes through the adapter contract. Out of scope: OTEL-only never-send invariant (completeness-gate.ts), which must stay.
Likely size: more than two files (adapter, spool/forwarder, possibly daemon sweep), hence separate ticket.
