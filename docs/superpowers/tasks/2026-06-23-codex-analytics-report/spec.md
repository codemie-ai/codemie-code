# Spec: Codex Analytics Report Parity

## Goal

`codemie analytics --report` must treat plain local Codex CLI sessions (`~/.codex/sessions/.../rollout-*.jsonl`) with the same depth as Claude Code: discovery, cost/pricing, per-turn series, dispatch timeline (agents/skills), and invocation charts.

## Requirements

1. **Native discovery** — Include `codex` in native session scanning; dedupe tracked CodeMie sessions and child sub-agent rollout files.
2. **Parse-time metrics** — Tools, file ops (`apply_patch`), skill/agent/command invocation counts on `ParsedSession.metrics`.
3. **Token & cost** — Read `token_count` events; session total from final `total_token_usage`; per-turn series from `last_token_usage`; price via existing `pricing.json`.
4. **Dispatch timeline** — `spawn_agent` + `collab_waiting_end` durations; skill point events from `exec_command` → `SKILL.md` paths; sub-agent cost from linked child rollouts.
5. **Report compatibility** — No UI changes; populate existing `ReportSessionRecord` fields (`tokens`, `costUSD`, `costSeries`, `dispatches`, invocation arrays).

## Non-goals

- Changing Codex metrics processor sync path (CodeMie-tracked sessions).
- OpenCode or other agents.

## Acceptance

- `codemie analytics --report` shows priced Codex sessions with coverage, cost series, dispatch Gantt, and skills/agents charts when local rollouts exist.
- Unit tests cover usage readers, dispatch extractor, native synthesis, and cost enricher for Codex fixtures.
