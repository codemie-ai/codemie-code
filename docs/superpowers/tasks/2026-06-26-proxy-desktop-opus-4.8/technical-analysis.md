# Technical Analysis — proxy connect desktop: Opus model selection

## Task

`codemie proxy connect desktop` currently exposes **Opus 4.6 and Opus 4.7** in the
Claude Desktop model list. Change this so a single **Opus 4.8** is exposed when the
CodeMie gateway serves it, otherwise fall back to other opus models. Verify it works.

## Codebase Findings

- **Owner file:** `src/cli/commands/proxy/connectors/desktop.ts` (added in #390 —
  "provision managed MCP servers into Claude Desktop").
- **Curated list** — `PREFERRED_CLAUDE_MODELS` (desktop.ts:49-54):
  ```
  claude-sonnet-4-6
  claude-opus-4-7
  claude-opus-4-6
  claude-haiku-4-5
  ```
  This is the source of the two opus entries the user sees. Both 4-7 and 4-6 are
  listed, so when the gateway serves both, both appear in Desktop.
- **Discovery** — `fetchClaudeModels()` (desktop.ts:67-138) hits the local proxy
  `/v1/llm_models?include_all=true`, filters to `claude-*`, prefers non-`-vertex`.
- **Resolution** — `selectPreferredClaudeModels()` (desktop.ts:149-189) maps each
  preferred name to an available id: exact → dated `<name>-YYYYMMDD` (latest) →
  `<name>-vertex`. Entries with no match are dropped silently. **Preserves the
  preferred order** and currently emits one entry per matched preferred name (so
  two opus entries when both resolve).
- **Call site** — `writeDesktopConfig()` (desktop.ts:~428-440): fetch → select →
  map to `InferenceModelEntry[]` → written to Desktop config as `inferenceModels`.
- **Canonical id** — `claude-opus-4-8` is the correct id (env model map;
  commit 41e225b set default opus to `claude-opus-4-8`; the active CLI profile uses
  `"opusModel": "claude-opus-4-8"`).

## Required Behavior Change

Expose **at most one** opus model, choosing the highest-priority one the gateway
actually serves, in priority order `4-8 → 4-7 → 4-6`. The exact/dated/vertex
fallback machinery should still apply to each opus candidate.

## Risk Indicators

- Surface is small: one file plus its unit test. Low blast radius.
- Existing tests assert two opus entries (desktop.test.ts:169-176, 277-305) — they
  encode the OLD behavior and must be updated to the new one-opus contract.
- `selectPreferredClaudeModels` is a generic, exported, unit-tested helper. Baking
  "only one opus" into it would make a generic resolver assert opus-specific rules
  (smell). Prefer keeping it generic and collapsing opus at a dedicated, tested seam.
- No network call needed at test time — discovery is mockable (tests already do).

## Verification

- Unit: `npm test` on the desktop connector spec.
- Manual: run `codemie proxy connect desktop` against the gateway and confirm the
  Desktop model picker shows a single Opus (4.8 when available).
