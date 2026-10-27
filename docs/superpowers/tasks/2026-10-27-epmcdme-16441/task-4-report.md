DONE

commit: uncommitted (orchestrator commits)

Changed paths:
- src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts

Change: added BACKEND_DROP_REASONS set and warnOnBackendDrop(); on response.ok for the hooks stream only, the body is read via response.text() and JSON.parse'd; when `reason` is one of cli_analytics_disabled / project_context_required / project_context_conflict, logger.warn with sanitizeLogArgs({sessionId, stream, reason, dropped}). Whole thing in try/catch (non-JSON, missing .text(), etc. = silent). Result stays 'ok'; spool deletion unchanged.

Not done: OTLP streams (/logs,/metrics,/traces) are posted as application/x-protobuf, so responses are protobuf; protobuf decoding skipped as instructed. Hooks endpoint is NDJSON in, JSON out.

Verification: npm run typecheck + eslint on forwarder.ts: EXIT=0 (log: docs/superpowers/tasks/2026-10-27-epmcdme-16441/test.local.log).

Stale tests (not edited, not run): possibly mocks of fetch in src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/{forwarder,tick-processor,project-interleave}.test.ts whose ok responses lack .text(); harmless since parsing is wrapped, but a warn would not be asserted anywhere.

Renamed symbols: none.
