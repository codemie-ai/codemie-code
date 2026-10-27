DONE (findings only)
commit: uncommitted (orchestrator commits)
changed paths: none - findings only (new file: docs/superpowers/tasks/2026-10-27-epmcdme-16441/findings-T2.md)
verification: n/a (no code changed)
stale tests: none
conclusion:
- Cost is likely already collected via Stop; SessionEnd loss costs agent.session.end and agent.git.snapshot (inferred, not measured). Effective SessionEnd deadline in `claude -p` cannot be determined from code.
- The sweep is GC only (drained + idle 60 min); it does not close sessions, so the proposed sweep fix would need a synthetic event through the adapter: more than two files.
- Ticket draft with evidence is in findings-T2.md; OTEL-only invariant untouched.
