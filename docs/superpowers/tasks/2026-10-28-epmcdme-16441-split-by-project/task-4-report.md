DONE
commit: 2b86df90
paths:
src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts
src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/forwarder.test.ts
src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/backend-drop-contract.test.ts
test_command: npx vitest run --project unit src/providers/plugins/sso/proxy/plugins/otlp-spool
notes:
- Exported: `BACKEND_DROP_REASONS` (was module-private, same three strings; comment names backend `cli_analytics_project_gate.py` REASON_* and `postgres/ingestor.py`). Nothing renamed or removed.
- `warnOnBackendDrop` gained a 4th `project` parameter, passed from `send`; throttle key is `${sessionId}:${project.toLowerCase()}:${reason}`; warn fields include `project`; 60 s interval and fire-and-forget unchanged.
- RED seen first: `BACKEND_DROP_REASONS is not iterable`, missing `project` field, one warning instead of two for projects A/B. GREEN: forwarder + contract tests 79/79; whole otlp-spool dir 196/196 (9 files). Pre-commit hooks passed.
- Contract test hard-codes shapes (hooks JSON body, hand-encoded protobuf partial_success for logs/metrics/traces, JSON partialSuccess), driven through forwardSession for all three reasons and an unknown reason (no warning).
- forwarder.test.ts: existing throttle test renamed to per session/project/reason; new `backend drop warnings` block (A and B same reason warn twice with project; repeat within 60 s warns for neither; case-variant spellings share one key).
- Note: the unknown-reason negative cases pass before the implementation too (they assert absence); the positive cases carry the RED.
