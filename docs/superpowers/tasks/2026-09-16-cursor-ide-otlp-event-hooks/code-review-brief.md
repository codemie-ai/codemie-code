# Code review (check round) — 2026-09-16-cursor-ide-otlp-event-hooks (2026-09-16)

**request-changes** · confidence: medium · 3 resolved · 12 unresolved · 0 superseded
Coverage: targeted verifier ✓ (all 15 prior blocking findings graded)

## Look here first (still unresolved)

- `src/agents/plugins/cursor-ide/cursor-ide.response.ts:26` — [security] analytics-only hook still always answers "allow" for permission-gating events — CR-003
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:124` — [security] persisted payload still unsanitized on disk, out of scope per plan constraints — CR-013
- `src/cli/commands/proxy/connectors/cursor-ide.ts:76` — [security] hooks.json ownership still decided by a raw substring match — CR-009
- `src/cli/commands/hook.ts:1613` — [other] forwardOtlpEvent still awaited before writeAgentStdoutResponse, blocking sync hooks — CR-006
- `src/cli/commands/hook.ts:1615` — [other] double stdout-write risk on logger.close() failure remains — CR-007

## Also flagged (still unresolved)

- `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts:20` — [other] forwarder/plugin contract still untested — CR-001
- `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts:46` — [other] gatewayKey presence still unchecked — CR-002
- `src/cli/commands/hook.ts:1603` — [other] malformed-JSON branch still skips stdout response — CR-004
- `src/cli/commands/hook.ts:1612` — [other] OTLP bypass branch still untested — CR-005
- `src/cli/commands/proxy/connect-orchestrator.ts:110` — [other] no --cursor-ide priority warning added — CR-008
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:124` — [infra] hook-events.jsonl still unrotated, out of scope per plan constraints — CR-012
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:169` — [infra] backend push failures still silently dropped, out of scope per plan constraints — CR-015

## Confirmed fixed this round

- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:103` — CR-010 agentName now validated against AgentRegistry.getAgentNames()
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:123` — CR-011 mkdir/appendFile now use 0o700/0o600 modes
- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:159` — CR-014 non-object parsed payload now guarded before spread

Full detail in `code-review-check.json`. commit-format ✓ · code-quality ✓ · security (audit) — carried forward from prior round, unchanged this round.
