# Plan — proxy connect desktop: single Opus (prefer 4.8)

## Clarification assumptions

- **Plain reading adopted (not asked — trivially reversible):** expose **exactly
  one** opus model in the Claude Desktop list, chosen by priority
  `claude-opus-4-8 → claude-opus-4-7 → claude-opus-4-6`. When 4.8 is absent from the
  gateway, the single highest-priority available opus is shown (not several). If the
  user actually wants "4.8 only, else all remaining opus", that's a one-line change.

## Goal

`codemie proxy connect desktop` currently lists Opus 4.6 **and** 4.7. After this
change it lists a single Opus — 4.8 when the CodeMie gateway serves it, otherwise
the next-best available opus — while sonnet/haiku entries are unchanged.

## Design (confirmed with advisor)

Keep `selectPreferredClaudeModels()` generic (resolve-each). Add `claude-opus-4-8`
at the head of the opus group in `PREFERRED_CLAUDE_MODELS`, then collapse to one
opus at a dedicated, tested seam — a new exported `selectDesktopClaudeModels()` that
the connector calls instead of `selectPreferredClaudeModels()`.

Rationale: the generic resolver's unit tests mock catalogs without 4-8, so adding
4-8 to the default preferred list leaves them green; only the connector-level tests
change. Baking "one opus" into the generic resolver would needlessly break its
contract test.

## Tasks

### Task 1 — Collapse to a single opus via `selectDesktopClaudeModels`
- **Test-first: yes** — new `describe('selectDesktopClaudeModels')`:
  - 4.8 present (exact) → opus list is exactly `[claude-opus-4-8]`; 4-7/4-6 absent.
  - 4.8 absent, 4-7 + 4-6 present → single opus `claude-opus-4-7`.
  - only 4-6 present → single opus `claude-opus-4-6` (or its dated variant).
  - 4.8 present only as dated `claude-opus-4-8-YYYYMMDD` → that dated id, still one.
  - sonnet + haiku preserved around the single opus, order preserved.
- Add `claude-opus-4-8` to `PREFERRED_CLAUDE_MODELS` ahead of `4-7`/`4-6`.
- Implement `selectDesktopClaudeModels(available, preferred?)`: call
  `selectPreferredClaudeModels`, then keep only the first `^claude-opus-` id.
- Update the `PREFERRED_CLAUDE_MODELS` doc comment to note one-opus collapse + order.

### Task 2 — Route the connector through the new seam
- **Test-first: yes** — update the two `writeDesktopConfig` expectations
  (desktop.test.ts:280-285, 298-303) to drop the second opus line, leaving:
  `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`.
- In `writeDesktopConfig()`, swap `selectPreferredClaudeModels(discoveredModels)`
  for `selectDesktopClaudeModels(discoveredModels)`.

## Verification

- `npm test` for the desktop connector spec (RED→GREEN per task).
- `npm run lint` + `npm run typecheck` on the touched file.
- Manual (handed to user — needs live gateway/SSO/Desktop): run
  `codemie proxy connect desktop`, confirm one Opus appears (4.8 when the gateway
  serves it). A fallback opus instead of 4.8 means the gateway lacks 4.8, not a bug.

## Out of scope

- `setup.ts` / `parsers.ts` opus references — profile-default model tiers, unrelated
  to the Desktop curated list.
