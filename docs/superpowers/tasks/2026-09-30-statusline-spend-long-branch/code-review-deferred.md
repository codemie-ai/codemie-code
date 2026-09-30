# Deferred from code review — 2026-09-30-statusline-spend-long-branch (2026-09-30)

- **Routed model segment can still precede cost unbounded** — `src/agents/plugins/claude/plugin/statusline.ts:627` — the `[model → actualModel]` segment (and the budget/reauthenticate segments) are uncapped and still render before the cost segment, so a long routed model id can still narrow the room left for spend. Pre-existing: segment order and the uncapped model/budget text predate this change, and the user-decided design capped only project (10) and branch (20).
