# Reproduction and validation entry points

The original report and raw logs are read-only references. Write generated private report files into /Users/Vadym_Vlasenko/.codex/visualizations/2026/09/15/01a0a4a0-b943-79e0-8109-48c55d232de9/.

After building source (npm run build), the user-facing route is:

node bin/codemie.js analytics --report --report-format both --include-external --session db7ad8f6-061d-4e9a-a7e9-b02b44b5d76a --report-output /Users/Vadym_Vlasenko/.codex/visualizations/2026/09/15/01a0a4a0-b943-79e0-8109-48c55d232de9/claude-session-corrected.html

This reads the live growing transcript family. Do not compare its final total directly against the historical supplied HTML without aligning the cutoff. The original report embeds window.__ANALYTICS__ as JSON in its first script element; target session is selected by sessionId. Last costSeries.t is 1789468330546 = 2026-09-15T10:32:10.546Z. Report generatedAt is 2026-09-15T10:32:22.610Z. At either cutoff, its 528 unique usage records yield 61,193,817 tokens. Official standard-rate estimate is $35.73558280; old configured-rate estimate is $45.17095180. This is not a provider invoice.

For deterministic historical validation, parse native JSONL into a temporary in-memory/sanitized snapshot and exclude records after cutoff before calculating. Preserve Agent/Skill tool IDs and timestamps, toolUseResult.isAsync/status/agentId, task-notification IDs/status/timestamps, message.id/requestId/usage, and metadata.parentAgentId/spawnDepth/toolUseId. Remove private prompt/result text. Restrict notifications to root protocol events, not arbitrary quoted text. Some completed notifications have only task-id. Ignore duplicated enqueue/remove/user/attachment copies after choosing the authoritative event.

Callable composition after build:
- ClaudeSessionAdapter(ClaudePluginMetadata).parseSessionFile(nativePath, sessionId)
- synthesizeRawSession('claude', descriptor, parsed) from analytics/native-loader
- enrichCosts([raw], injected EnricherDeps with parseNative returning the same snapshot)
- AnalyticsAggregator.aggregate([raw], true, new Set([sessionId]))
- buildPayload(analytics, index, summary, {generatedAt,rangeLabel:'all',projectFilter:'all'})
- generateReport(payload, outputHtml) and generateReportJson(payload, outputJson) from report/report-generator

Injecting the same ParsedSession into cost enrichment avoids the current two-read live timing gap and makes exact snapshot assertions meaningful. generateSessionReport currently cannot opt into native-external sessions, so the explicit composition or CLI --include-external is the useful route for this example.

The reference report shows only 28 dispatches (24 agent, 1 skill, 3 command). Historical raw evidence contains 37 agent calls and 9 skill calls, plus those 3 commands. Children all live flat under <sessionId>/subagents; logical depth is metadata and exact tool ID ownership, not directory nesting. Every explicit parent matches one owning transcript. Existing raw dataset has now grown beyond the cutoff.

Use session-reconciliation.json for exact own/inclusive costs, token breakdown and span evidence for each historical agent. Requirements-reader completion at 08:41:15.052Z minus launch 08:34:22.614Z = 412,438 ms; launch acknowledgement was only 1,424 ms. The fourth slice-runner has no completion notification at cutoff and waits for a descendant implementation agent, so its end_turn does not mean its subtree is complete. Its own cost is $2.53014825 at old rates; its inclusive historical subtree cost is $5.75871715. Reconciled official values are also in the JSON.

Browser verification should open the newly generated local report, select the target Sessions row, inspect nested ancestors/descendants and step details, and validate that selection, duration, cost, token, own/inclusive labels and export agree. Capture evidence only in the designated runner evidence area; the root agent consumes the runner's text verdict.
