```json
[
  {
    "kind": "spec",
    "item": "Design: retain a flat, additive session/dispatch representation with stable identities, ancestry, lifecycle and own/inclusive usage.",
    "status": "pass",
    "notes": "cost/types.ts:42-65 and report/types.ts:50-63 add optional fields; projectDispatch preserves the flat dispatch list."
  },
  {
    "kind": "spec",
    "item": "Design: exact metadata and tool ownership link descendants regardless of storage order; invalid links remain unresolved.",
    "status": "fail",
    "notes": "claude-trace.ts:77-83 selects the first transcript containing a tool ID; :111-114 resolves the first duplicate metadata link while only later links become conflicts."
  },
  {
    "kind": "spec",
    "item": "Design: reuse one captured transcript family for session facts, bounds, dispatches and deduplicated usage.",
    "status": "pass",
    "notes": "native-loader.ts:425 attaches INTERNAL_PARSED_FAMILY; cost-enricher.ts:109-116 reuses it; native-loader.test.ts adds a one-parse growing-file fixture."
  },
  {
    "kind": "spec",
    "item": "Design: own usage belongs to its transcript and inclusive usage adds only reachable descendants without adding overlaps to session totals.",
    "status": "fail",
    "notes": "usage-readers.ts:159-163 scans children in discovery order and :118 permanently keeps the first encountered owner, so inherited child history can become a grandchild own allocation."
  },
  {
    "kind": "spec",
    "item": "Design: skill/command attribution stays within its owner and evidenced scope, with estimated or unavailable values identified.",
    "status": "pass",
    "notes": "cost-enricher.ts:308-315 restricts windows to byOwner records and labels owner-window attribution; zero-duration command estimates remain unavailable."
  },
  {
    "kind": "spec",
    "item": "Design: distinguish dispatch, acknowledgement, observation and authoritative completion, correlate protocol notifications by tool/task identity, and exclude quoted text.",
    "status": "fail",
    "notes": "claude-trace.ts:148-158 excludes quoted message text, but :192 requires a linked transcript for task-only matching; dispatch-extractor.ts:101 labels every non-async tool_result completed."
  },
  {
    "kind": "spec",
    "item": "Design: async acknowledgements and end_turn alone do not establish subtree completion; unknown completion remains visible.",
    "status": "pass",
    "notes": "dispatch-extractor.ts:95-101 separates async acknowledgement; claude-trace.ts:193-209 uses authoritative completion or observed descendant bounds and never reads end_turn."
  },
  {
    "kind": "spec",
    "item": "Design: session elapsed time covers observed root/descendant activity independently of parallel work durations.",
    "status": "pass",
    "notes": "native-loader.ts:341-350 computes the timestamp envelope; payload-builder.ts:94-97 projects the captured bounds."
  },
  {
    "kind": "spec",
    "item": "Design: extend Sessions with complete inspectable ancestry, stable selection, lifecycle and own/inclusive timing/cost details; retain legacy usability.",
    "status": "pending-stage-7",
    "notes": "client/app.js:1033-1236 constructs all entries and identity-based selection with legacy fallbacks; browser interaction evidence belongs to Stage 7."
  },
  {
    "kind": "spec",
    "item": "Design: identify native costs as API-equivalent estimates, preserve authoritative-source distinctions, and correct Sonnet 5/Opus 5 using existing normalization/cache TTL.",
    "status": "pass",
    "notes": "pricing.json:25-38 contains the required rates; cost-enricher.ts and otel-loader.ts add source provenance; pricing and calculator fixtures cover normalized names and cache TTL."
  },
  {
    "kind": "spec",
    "item": "AC1: historical cutoff contains 37 unique agent calls at depths 24/12/1, 9 skill calls and 3 commands; child isSidechain rows are owned messages.",
    "status": "pending-stage-7",
    "notes": "dispatch-extractor.ts:63-112 scans all owners without sidechain exclusion or truncation; exact historical counts and depth reconciliation require Stage 7 execution."
  },
  {
    "kind": "spec",
    "item": "AC2: flat storage, malformed/missing/conflicting parents, cycles and duplicate/replayed records preserve valid usage and expose uncertainty without invented relationships.",
    "status": "fail",
    "notes": "claude-trace.ts:77-83 and :111-126 use discovery-order first wins for tool owners and duplicate tool-to-agent metadata, allowing an arbitrary child to remain resolved/exact."
  },
  {
    "kind": "spec",
    "item": "AC3: historical owned usage reconciles to 528 responses and 61,193,817 tokens with the specified category totals and no double-counted 1h subset.",
    "status": "pending-stage-7",
    "notes": "usage-readers.ts:173-188 retains TTL subset semantics; numeric historical reconciliation is exclusively Stage 7 evidence."
  },
  {
    "kind": "spec",
    "item": "AC4: each owned response belongs to its correct own allocation; inclusive descendants and root allocations reconcile; replay exclusion is consistent and unknown allocations explicit.",
    "status": "fail",
    "notes": "usage-readers.ts:159-163 and :118 can claim a parent response for a grandchild encountered first; cost-enricher.ts:324-328 exposes the resulting wrong own allocation as exact."
  },
  {
    "kind": "spec",
    "item": "AC5: skill/command details cannot absorb unrelated concurrent descendants; owner/scope and estimated/unavailable attribution are explicit and overlaps do not affect totals.",
    "status": "pass",
    "notes": "cost-enricher.ts:308-315 uses only accepted records for the dispatch owner and labels attribution; nested cost fixtures cover overlapping root/child skills."
  },
  {
    "kind": "spec",
    "item": "AC6: acknowledgement does not complete async work; requirements-reader uses its 412,438 ms notification; notification copies and valid task-ID-only records are handled.",
    "status": "fail",
    "notes": "claude-trace.ts:192 ignores a task-ID-only notification when the acknowledgement has agentId but its transcript is absent; the 412,438 ms linked-transcript fixture otherwise implements the historical case."
  },
  {
    "kind": "spec",
    "item": "AC7: explicit completion/failure, incomplete observation and unknown evidence remain distinguishable; fourth slice-runner stays incomplete at cutoff.",
    "status": "fail",
    "notes": "dispatch-extractor.ts:90-102 ignores tool_result.is_error and failure statuses, then forces non-async results to completed; end_turn-only incompleteness is implemented and fixture-covered."
  },
  {
    "kind": "spec",
    "item": "AC8: historical activity spans 7,271,252 ms through 10:32:10.546Z, including children, and timeline/detail bounds agree without summing parallel durations.",
    "status": "pending-stage-7",
    "notes": "native-loader.ts:341-350 computes family bounds and client/app.js:1151-1236 consumes them; exact historical span and browser agreement need Stage 7."
  },
  {
    "kind": "spec",
    "item": "AC9: each report reuses one family capture; historical validation aligns cutoff while live validation exposes its own snapshot.",
    "status": "pending-stage-7",
    "notes": "INTERNAL_PARSED_FAMILY reuse and capturedAt projection are implemented and fixture-covered; historical/live CLI evidence remains Stage 7 work."
  },
  {
    "kind": "spec",
    "item": "AC10: Sonnet 5 rates are 2/10/0.2/2.5/4 and Opus 5 rates 5/25/0.5/6.25/10; historical total/root/top-level values reconcile to the specified amounts.",
    "status": "pending-stage-7",
    "notes": "pricing.json adds the exact five-rate entries; pricing.test.ts and cost-calculator.test.ts add normalization/TTL fixtures; real $35.73558280 reconciliation awaits Stage 7."
  },
  {
    "kind": "spec",
    "item": "AC11: aggregates, models, session and cumulative endpoint reconcile before rounding; per-step values use the same correctly owned records/rates and own/inclusive estimate labels.",
    "status": "fail",
    "notes": "Rounding is deferred and model/series pricing is shared, but first-discovered replay ownership in usage-readers.ts:159-187 causes per-step own values to belong to the wrong transcript."
  },
  {
    "kind": "spec",
    "item": "AC12: Sessions exposes all counts and inspectable ancestry beyond 60 dispatches; parent/descendant selection shows stable, consistent details without omissions.",
    "status": "pending-stage-7",
    "notes": "No Claude dispatch slice remains; payload and export fixtures include 80 steps; client/app.js builds and selects every entry, pending browser verification."
  },
  {
    "kind": "spec",
    "item": "AC13: HTML/JSON agree on identities, hierarchy, totals, attribution and timing; public changes are additive and legacy/non-Claude consumers remain functional.",
    "status": "pending-stage-7",
    "notes": "projectDispatch/projectSnapshot allowlist optional fields, and report-generator.test.ts compares identical exports; legacy fallback/browser execution is owned by Stage 7."
  },
  {
    "kind": "spec",
    "item": "AC14: focused executable validation covers nesting, async notifications, incomplete work, malformed ancestry, replay, large sets and TTL; real reconciliation and current CLI/browser verification succeed.",
    "status": "pending-stage-7",
    "notes": "Changed fixture suites cover each listed category; tests, historical run, live CLI regeneration and browser/console evidence were intentionally not executed by this lens."
  },
  {
    "kind": "spec",
    "item": "AC15: original logs/report remain unchanged; private bodies/credentials/generated reports stay outside committed artifacts; corrected reports are delivered in the visualization directory with reconciliation.",
    "status": "pending-stage-7",
    "notes": "Frozen diff changes only source and sanitized fixture code; symbol-backed captures and allowlisted dispatch exports exclude new private bodies; report delivery/preservation evidence belongs to Stage 7."
  },
  {
    "kind": "spec",
    "item": "Non-goal: do not fetch provider bills, allocate subscription charges or add external billing services.",
    "status": "pass",
    "notes": "Rates remain local pricing.json data; cost computation uses native token records or existing source-reported telemetry only."
  },
  {
    "kind": "spec",
    "item": "Non-goal: do not rewrite source transcripts or edit the saved historical report.",
    "status": "pass",
    "notes": "Frozen diff introduces read-only native parsing/capture changes and report projection; no transcript or historical-report write path is added."
  },
  {
    "kind": "spec",
    "item": "Non-goal: do not change provider execution, orchestration, remote metrics ingestion or unrelated report navigation.",
    "status": "pass",
    "notes": "Changes are confined to session metadata, analytics extraction/cost/reporting, pricing and fixtures; otel-loader only adds provenance to existing cost data."
  },
  {
    "kind": "spec",
    "item": "Non-goal: do not infer missing ancestry, completion or exact skill costs from temporal coincidence.",
    "status": "pass",
    "notes": "Ancestry uses tool IDs/metadata, lifecycle uses typed protocol evidence, and time-window skill estimates are expressly labeled estimated rather than exact."
  },
  {
    "kind": "spec",
    "item": "Non-goal: do not introduce a breaking schema, dependencies or broad analytics refactoring.",
    "status": "pass",
    "notes": "No package manifests change; existing durationMs/costUSD/tokens fields remain and new report/dispatch fields are optional."
  }
]
```

```markdown
- Design exact-link rule and AC2: Resolve duplicate/conflicting tool-to-agent evidence as a whole rather than accepting the first filesystem entry. In claude-trace.ts:111-126, two transcripts claiming the same toolUseId leave the first resolved and attached to the parent, while only the second becomes conflict; cost-enricher.ts:324-328 then labels the first allocation exact. Also, claude-trace.ts:77-83 chooses the first transcript containing a replayed tool call, so a descendant encountered before its true owner can override explicit parent metadata. Preserve uncertainty or use corroborated canonical ownership independently of discovery order.
- Design own-allocation rule, AC4 and AC11: Assign replayed responses to the evidenced original transcript before pricing per-step usage. usage-readers.ts:159-163 visits subagents in directory discovery order, and appendDedupedRecord at :118 permanently retains the first owner. If a grandchild is discovered before its parent and contains a replay of a parent response, that response is allocated to the grandchild and exposed as exact by cost-enricher.ts:324-328 even though the session total still reconciles. The current replay fixture only exercises root-first inheritance and does not cover reversed descendant order.
- Design lifecycle correlation and AC6: Match task-only completion using the exact agent/task ID already recorded in the launch acknowledgement even when a child transcript could not be loaded. normalizeClaudeTrace at claude-trace.ts:189-197 requires a linked index agent for its taskId comparison; an async result with agentId plus a matching task-ID-only completed notification stays unknown when parsed.subagents is empty. Separate authoritative lifecycle identity from transcript availability and retain explicit taskId mappings where present.
- Design lifecycle distinctions and AC7: Preserve an explicit tool_result failure instead of marking it completed. dispatch-extractor.ts:90-102 checks only async launch metadata and assigns completed to every remaining result, ignoring is_error and failure status; payload-builder invocationStats then increments successCount. Carry failure evidence into failed status and completion timing, while retaining the existing incomplete handling for end_turn-only descendants.
```
