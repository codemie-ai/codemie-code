DONE

Commit sha: none - findings task
Changed paths: /Users/vponkratina/work/ai/codemie-code/docs/superpowers/tasks/2026-10-27-epmcdme-16441/findings-F2.md, task-F2-report.md (same dir)
Test command: none - tests not requested
Summary:
- 200 body: /event-hooks discard = {"accepted":0,"dropped":N,"reason":...} (ingestor.py:379-381); OTLP discard = Export*ServiceResponse partial_success.rejected_* = N + error_message = reason; accepted = {} / empty.
- Gate reasons cli_analytics_disabled / project_context_required / project_context_conflict, always 200; 413 at 5,242,880 bytes before gate; no server-side discard logging found.
- Subagent totals count only under a strict no-own-usage/no-OTel rule and dashboards read cost_daily (inferred, not measured from prod); 6 backend ticket drafts listed. Checkout 48fa31b56 may differ from deployed.
