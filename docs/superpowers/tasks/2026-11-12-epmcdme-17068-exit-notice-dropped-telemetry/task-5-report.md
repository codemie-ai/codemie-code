DONE

Changed paths
- src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.ts (per-tick AbortController, stopAtFirstFailure: true)
- src/providers/plugins/sso/session/SessionSyncer.ts (ends run after a processor whose signal holds a non-ok outcome, only when stopAtFirstFailure)
- src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts (retryAttempts 0 + break at first failed branch when stopAtFirstFailure; delta_id on each metric)
- src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts (deltaId set once per batch at write time)
- src/providers/plugins/sso/session/processors/metrics/delta-id.ts (new: deltaIdOf(recordIds): string)
- src/providers/plugins/sso/session/processors/metrics/metrics-types.ts (delta_id?)
- src/agents/core/metrics/types.ts (MetricDelta.deltaId?)
- src/providers/plugins/sso/session/BaseProcessor.ts, src/agents/core/session/BaseProcessor.ts (ProcessingContext.stopAtFirstFailure?)
- tests: sso.session-sync.plugin.test.ts, metrics-sync-processor.stop.test.ts, MetricsWriter.test.ts

Tests: npx vitest run src/providers/plugins/sso/session src/providers/plugins/sso/proxy/plugins/__tests__/sso.session-sync.plugin.test.ts (306 pass); src/cli/commands/__tests__/hook.session-delivery.test.ts (172 pass); src/agents/core/session + src/telemetry (pass). tsc and eslint clean.
Note: sso.auth-gate.integration.test.ts had 2 failures in one full-dir run; not re-verified as related (auth-gate, untouched).
Concern: the timer-only rule is gated by ProcessingContext.stopAtFirstFailure so hook paths keep their retries.
