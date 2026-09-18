# Claude nested-session analytics correction

## Problem and scope

Claude session db7ad8f6-061d-4e9a-a7e9-b02b44b5d76a exposes three linked defects: the report omits descendants, treats background launch acknowledgements as completion, and prices Sonnet 5 with stale rates. Existing session usage deduplication already reconciles; nested trace totals must not be added to it. Correct the native Claude report path, Sessions timeline and detail view, JSON payload, and the shared pricing entries required for this case.

Research is recorded in technical-analysis.md. Numeric evidence is in session-reconciliation.json; reproduction-notes.md fixes the historical cutoff and provides the live CLI path.

## Design

Keep the flat session/dispatch representation and add stable identities, ancestry, lifecycle evidence and own/inclusive usage. Exact metadata and tool ownership link descendants regardless of directory layout. Invalid links remain unresolved. This fits existing consumers; a nested schema requires migration, while filesystem-only recursion cannot recover this hierarchy.

Use one captured transcript family for session facts, bounds, dispatches and deduplicated usage. Each owned response contributes once to session totals. Agent own allocations contain their records; inclusive allocations also contain reachable descendants and overlap across depths. Skill/command allocation stays within its owner transcript and evidenced scope, with estimated/unavailable values identified. Preserve current field semantics and add fields for new values.

Distinguish dispatch, acknowledgement, observed activity and authoritative completion. Deduplicate protocol notifications correlated by tool-use or task/agent ID, excluding quoted text. Async launch responses and end_turn do not establish subtree completion. Unknown completion remains visible. Session elapsed time covers observed root and descendant activity, independently of parallel work durations.

Extend the existing Sessions timeline with ancestry, complete counts, stable selection, lifecycle state and own/inclusive cost, tokens and timing details. All steps remain inspectable; progressive display may bound rendering but cannot silently truncate data. Legacy reports remain usable. Label native cost consistently as an API-equivalent estimate and preserve authoritative-source distinctions. Correct Sonnet 5 pricing and explicitly register verified Opus 5 rates using existing normalization and cache TTL behavior.

## Acceptance criteria

1. At historical cutoff 2026-09-15T10:32:10.546Z, all 37 agent calls appear once with correct parentage at depths 1/2/3 = 24/12/1; all 9 skill and 3 command calls remain represented. Nested isSidechain rows are read as their owning child's messages.
2. Flat physical storage does not limit logical ancestry. Missing/conflicting parents, cycles, absent/malformed metadata and duplicate/replayed records terminate safely, preserve valid usage, and expose uncertainty without invented relationships.
3. Session-owned usage reconciles to 528 unique responses and 61,193,817 tokens at that cutoff: input 1,326; output 772,215; cache reads 58,108,658; cache creation 2,311,618, including 569,974 one-hour tokens. The one-hour subset is not counted twice.
4. Every owned response belongs to one own-cost allocation. Own plus reachable descendants produces each agent's inclusive allocation; root own plus the disjoint top-level inclusive allocations equals session totals. Cross-session replay exclusion applies consistently to trace attribution. Unknown/unlinked allocations remain explicit.
5. Skill/command details cannot absorb unrelated concurrent descendant spend. Their attribution identifies the owning transcript and evidential scope, and marks estimated or unavailable values. Inclusive/overlapping allocations are never added into session totals.
6. Launch acknowledgement does not complete an async trace. Requirements-reader ends at its authoritative 08:41:15.052Z notification, yielding 412,438 ms from launch, rather than its 1,424 ms acknowledgement. Notification copies count once, including valid task-ID-only completion records.
7. Explicit completion/failure, incomplete observation and unknown lifecycle evidence remain distinguishable. The fourth slice-runner has no completion at cutoff and is not marked complete merely because it emitted end_turn while its descendant continued.
8. Historical session activity spans 7,271,252 ms and ends at 10:32:10.546Z, including child work after root inactivity. Timeline positions and selected timing details agree with those bounds; elapsed session time is never the sum of parallel durations.
9. One captured family is reused throughout each report run so growing files cannot give aggregation, series, dispatches and details different inputs. Historical validation aligns the cutoff; live validation reports its own snapshot and may legitimately include newer work.
10. Sonnet 5 input/output/cache-read/5m-write/1h-write rates per million are 2/10/0.2/2.5/4 USD; Opus 5 rates are 5/25/0.5/6.25/10. Historical API-equivalent total is $35.73558280, with root own $18.47146730 plus top-level inclusive $17.26411550. Existing $45.17095180 is reproducible only with the old configured rates.
11. Aggregate cost, model totals, session total and final cumulative-series value reconcile before display rounding. Per-step values match the same owned records and rate policy, with explicit own/inclusive labels. Native costs are labeled API-equivalent estimates rather than invoices.
12. Sessions exposes complete counts and inspectable ancestry, including sessions exceeding 60 dispatches. Clicking parent and descendant rows selects the correct stable trace and shows consistent cost, token, timing and lifecycle information without misleading completion or silent omissions.
13. HTML and JSON exports agree on identities, hierarchy, totals, attribution and timing. Existing public fields keep their semantics, new fields are additive, and legacy payloads/non-Claude consumers retain functional behavior without requiring the new metadata.
14. Focused executable validation covers nested concurrent agents, async acknowledgements and notifications, incomplete work, malformed ancestry, replay ownership, large dispatch sets and cache TTL pricing. Validate the real historical reconciliation and regenerate a current HTML/JSON report through the CLI, then inspect timeline and detail interactions in a browser with no console/runtime failures.
15. Original native logs and supplied report remain unchanged. Personal transcript bodies, credentials and generated private reports stay outside committed artifacts; corrected HTML/JSON is delivered in the designated visualization directory with a concise reconciliation result.

## Non-goals

- Fetching provider bills, allocating subscription charges, or adding external billing services.
- Rewriting source transcripts or editing the user's saved historical report.
- Changing provider execution, agent orchestration, remote metrics ingestion, or unrelated report navigation.
- Inferring missing ancestry, completion or exact skill costs from temporal coincidence.
- Introducing a breaking report schema, new dependencies, or broad analytics refactoring.

## Risks and validation boundaries

The source session is live, so the historical cutoff and a new snapshot are separate reference points. Incomplete metadata can limit precision; explicit unknowns are part of correctness. Native standard-token prices are API equivalents and exclude charges absent from the evidence. The review and validation stages must check additive contracts, rate consumers, and browser behavior as well as numerical reconciliation.
