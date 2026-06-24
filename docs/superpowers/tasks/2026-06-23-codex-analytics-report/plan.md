# Plan: Codex Analytics Report Parity

## Task 1 — Codex parse-time metrics & named invocations
Test-first: yes — `codex.analytics-extractors.test.ts` with `turn-spawn-skill.jsonl` fixture.

- `codex-named-invocations.ts`, `codex-metrics-extractor.ts`
- Wire into `codex.session.ts` `parseSessionFile` + subagent rollout linking

## Task 2 — Usage readers & cost series
Test-first: yes — extend `usage-readers.test.ts` with `turn-1.jsonl` / `turn-2.jsonl`.

- `extractCodexUsageRecords`, `readCodex` in `usage-readers.ts`

## Task 3 — Dispatch timeline
Test-first: yes — `codex.analytics-extractors.test.ts` + dispatch routing in enricher.

- `codex-dispatch-extractor.ts`, route in `dispatch-extractor.ts` and `cost-enricher.ts`

## Task 4 — Native loader & child dedup
Test-first: yes — `native-loader.test.ts` codex synthesis case.

- Add `codex` to `NATIVE_AGENTS`, `synthesizeCodexRawSession`, `collectCodexChildThreadIds`

## Task 5 — Cost enricher integration
Test-first: yes — `cost-enricher.test.ts` codex pricing case.

- Agent-aware dispatch enrichment; codex priced sessions from fixtures
