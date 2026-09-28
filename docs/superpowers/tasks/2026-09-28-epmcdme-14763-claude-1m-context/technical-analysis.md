# Technical Analysis — EPMCDME-14763: 1M context window for Claude Code models

## Overview

CodeMie CLI requires users to hand-edit `~/.codemie/codemie-cli.config.json`, appending `[1m]` to
a Claude model id, to get the 1M context window in Claude Code. The ticket asks CodeMie to detect
1M-capable Claude models and apply the `[1m]` variant automatically, for any Claude model that
supports it (not hardcoded to Sonnet), without breaking models that don't support 1M.

Claude Code itself is the only thing that understands `[1m]`: it strips the suffix from the model
id before the request goes out and adds the header `anthropic-beta: context-1m-2025-08-07` instead
(confirmed against `code.claude.com` docs in a prior research pass this session). CodeMie's job is
narrower than "implement 1M" — it is to stop stripping/never-adding the suffix CodeMie itself
controls (profile config, tier env vars, the `/model` picker).

## Codebase Findings

### 1. Where `[1m]` is lost today (`src/agents/plugins/claude/claude.models.ts`)

`resolveClaudeModel(env, tier)` re-matches whatever model is configured against the live CodeMie
catalog (`fetchCatalog`). Catalog ids never carry `[1m]` (verified empirically — see "Live catalog
verification" below), so an exact-string match against `availableModels`/`modelIdentifiers()` always
fails for a `[1m]` id, and the model is treated as stale:

- **Main tier (`CODEMIE_MODEL`)**: survives only when `CODEMIE_MODEL_SOURCE` is `cli` or `env`
  (`EXPLICIT_MODEL_SOURCES`, line 21) — i.e. only when the user passed `--model X[1m]` or set the
  env var directly this run. A value with `[1m]` saved in a profile (`CODEMIE_MODEL_SOURCE` unset or
  `default`) is NOT explicit and gets re-resolved, at which point the suffix-less catalog match wins
  and 1M is lost (line 352, confirmed by the existing test at `claude.models.test.ts:93-105`).
- **Haiku/sonnet/opus tiers**: `EXPLICIT_MODEL_SOURCES` only ever gates the `model` tier
  (`tier === 'model'` check, line 352) — there is no `--haiku-model` flag, so these three tiers are
  *always* re-resolved against the catalog on every run, regardless of source. `[1m]` is stripped
  unconditionally (confirmed by `claude.models.test.ts:107-123`, which currently asserts this as
  correct "no regression" behavior for a plain suffix-less swap — it will need updating once tiers
  learn to preserve `[1m]`).

`modelIdentifiers(model)` (line 73) returns exactly `[deployment_name, base_name, label]` — a
catalog entry never has `[1m]` baked into any of these three fields (see verification below), so
matching a `[1m]`-suffixed `currentModel` against it will never succeed as-is. The suffix must be
stripped before comparison and reattached to the result afterward.

### 2. No context-window signal in the CodeMie catalog — verified against the live endpoint

The ticket assumes CodeMie can "detect when a selected Claude model supports 1m context." I fetched
the real `/v1/llm_models?include_all=true` response from a live CodeMie tenant (`codemie.lab.epam.com`)
using this machine's already-stored SSO credentials, via `fetchCodeMieLlmModels()` directly (no
mocks). The `LlmModel` shape returned (44 models) has **no context-window field whatsoever** — no
`context_window`, `max_input_tokens`, `max_tokens` (the `features.max_tokens` field is a boolean
"supports the max_tokens param" flag, not a token count), and no per-model `[1m]` variant exists as
a separate `deployment_name`/`base_name`. Every current Claude entry (`claude-sonnet-5`,
`claude-opus-4-7`, `claude-opus-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, etc.) has the
exact same `features` block regardless of generation. **`src/providers/core/types.ts`'s
`contextWindow?: number` field is unrelated** — it belongs to a different, generic provider-metadata
type (`ProviderModel`), not `LlmModel`, and nothing populates it for Claude.

**This rules out a purely data-driven capability check via the catalog CodeMie already fetches.**
Whatever decides "is this Claude model 1M-capable" has to be either (a) a version-pattern heuristic
in the CLI, mirroring the one that already exists for a related purpose, or (b) a backend/API change
to add a real field — out of scope for a CLI-only ticket in this repo.

I also queried the LiteLLM proxy's own `/v1/model/info` endpoint directly (the litellm-preview
tenant this session is configured against) — LiteLLM **does** carry accurate `max_input_tokens` per
deployment (e.g. `claude-sonnet-5` → `1000000`, `claude-sonnet-4-6` → `1000000`,
`claude-opus-4-5-20251101` → `200000`, `claude-haiku-4-5-20251001` → `200000`,
`claude-4-5-sonnet` → `200000`). That confirms a real signal *exists* upstream, but it is not
surfaced through CodeMie's own `/v1/llm_models` endpoint that `claude.models.ts` actually calls, and
a router alias (`claude-router-standard`, `claude-router-premium`) reports `max_input_tokens: null`
even on LiteLLM's own endpoint — a router can't declare 1M support up front because it dispatches to
whichever concrete deployment it picks per request. **Surfacing this properly is a backend change
(CodeMie's `/v1/llm_models` would need to forward LiteLLM's `max_input_tokens` per entry); this ticket,
scoped to "CodeMie CLI" per its Affected Areas, cannot do that.** The CLI-only remediation is a
version-pattern table.

### 3. A version-pattern table already exists for a sibling problem — reuse its shape

`src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` already solves a
structurally identical problem: deciding a Claude model's *capabilities* (thinking mode, effort,
sampling) from its id string, because the backend doesn't expose that either. Its
`MODEL_CAPABILITY_TABLE` is a `{pattern: RegExp, capabilities: ...}[]`, first-match-wins, with a
`DEFAULT_CAPABILITIES` fallback — and its comment block explicitly says "Every model-specific
decision reads from MODEL_CAPABILITY_TABLE; add/edit a row to change support." This is the
established, precedented pattern in this codebase for "the backend has no field for X, so the CLI
maintains a small version table" — anything new for 1M-capability detection should follow this same
shape (a table `claude.models.ts` owns, not a hardcoded `sonnet`-only check) to satisfy the ticket's
explicit "not hardcoded only to Sonnet" acceptance criterion and to avoid a third parallel place
capability logic lives.

The live LiteLLM data confirms the version boundary is real and consistent: **Opus 4.6+, Sonnet 4.6+
support 1M** (with the `[1m]` suffix — this is the "suffix-only" tier per the doc research done
earlier this session); **Opus 4.5 and Sonnet 4.5 and all Haiku do not** (200k only, no `[1m]`
variant). `claude-request-normalizer.plugin.ts`'s existing `MODEL_CAPABILITY_TABLE` regex boundaries
(`claude-opus-4-[7-9]`, `claude-sonnet-5`, `claude-haiku-(3-5|4-5)`) are *close* to this line but not
identical — it draws its line at "adaptive thinking," a different Anthropic-side capability, one
version later than the 1M line for Opus. A 1M table needs its own boundary, not reuse of that exact
table (which is also proxy-side code, wrong side of the process for `claude.models.ts` to import).

### 4. `buildModelPickerOptions()` (lines 299–335) offers no 1M rows

Built straight from the catalog via `isClaudeFamilyPickerEntry` + `rankModel`, one option per
catalog entry, `replaceBuiltInOptions: true` (set at `claude.plugin.ts:460`) — so Claude Code's own
built-in `[1m]` rows for native models are hidden too. Today there is no way to reach a 1M variant
from `/model` except typing `/model <id>[1m]` by hand. Any fix here needs to synthesize an
additional option per 1M-capable catalog entry (id + `[1m]`, distinct `label`), using the same
capability table from finding 3.

### 5. `default-agent-hooks.ts` and `claude.plugin.ts` — where the resolved value actually lands

`resolveClaudeModel`'s result is written to `env.CODEMIE_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`
(`claude.plugin.ts:404-419`). `default-agent-hooks.ts`'s `enrichArgs` then injects
`--model <CODEMIE_MODEL>` unconditionally when no `--model` flag is already present
(`default-agent-hooks.ts:73-77`) — so whatever suffix survives resolution reaches the Claude Code
CLI invocation via `--model`, which does take priority over `~/.claude/settings.json`. There is no
second place downstream that could re-strip a preserved suffix.

### 6. Test coverage already in place / needing extension

`src/agents/plugins/claude/__tests__/claude.models.test.ts` already has 5 tests around this exact
seam (`describe('resolveClaudeModel — explicit --model override')`):
- explicit `--model X[1m]` survives when absent from catalog (line 68) — proves the CLI-override
  short-circuit already protects this one path.
- same, no `[1m]` (line 81) — regression guard.
- **implicit (profile-sourced) `[1m]` gets silently healed away to a different model** (line 93) —
  this is the exact bug, currently asserted as today's (undesired) behavior; will need to flip once
  fixed, asserting the healed result keeps `[1m]` (or gets it re-derived) instead of losing it
  outright.
- tier vars (sonnet) are always re-resolved regardless of `CODEMIE_MODEL_SOURCE=cli` (line 107) —
  same, needs a parallel `[1m]`-preserving variant.
- a model present verbatim in the catalog is left untouched, `[1m]` or not (line 125) — this test's
  catalog entry (`model({ deployment_name: 'claude-sonnet-5[1m]' })`) is itself unrealistic per the
  live-catalog verification above (no real catalog entry carries `[1m]`); it is exercising a case
  that cannot occur in production and should not be relied on as coverage for the real fix.

### 7. Unverified risk carried over from earlier investigation (not resolved this pass)

`claude.plugin.ts:237-239` sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` for every provider except
`ai-run-sso`/`litellm` (`TOOL_SEARCH_VERIFIED_PROVIDERS`). Whether that variable also suppresses the
`anthropic-beta: context-1m-2025-08-07` header (as opposed to only the tool-search beta it's
documented against) is still unconfirmed — flagged as a risk to check while implementing, not
something this analysis pass had budget to verify against a live Bedrock/JWT/subscription session.

## Risk Indicators

- **No dynamic capability signal available from the CLI's own data source** (finding 2) — any fix is
  necessarily a maintained version table, which drifts as new Claude generations ship. This is an
  accepted, precedented cost in this codebase (finding 3), not a blocker.
- **Routers can't be resolved to a capability up front** (finding 2) — `claude-router-premium[1m]`-
  style aliases must be handled by policy (e.g. always allow `[1m]` to pass through for a router,
  since the underlying deployment decision happens per-request and CodeMie can't know it in advance)
  rather than by table lookup.
- **Two independent code paths need the same table** (tier resolution in `claude.models.ts`, picker
  building in the same file) — must share one source, not duplicate the pattern list.
- **One existing test (finding 6, line 125) encodes an unrealistic catalog shape** and should not be
  treated as a spec for the real fix.
- Ticket explicitly requires **not hardcoding to Sonnet only** — the fix must be a table over the
  Claude family, not a single regex.

## Summary

- CodeMie's own model catalog carries zero context-window metadata for any model (verified against
  a live tenant) — there is no field to read; a version-pattern capability table is the only
  CLI-only path, and one already exists in this codebase for a sibling problem
  (`claude-request-normalizer.plugin.ts`'s `MODEL_CAPABILITY_TABLE`) to follow the shape of.
- The bug is in `claude.models.ts`: `[1m]` never survives catalog re-matching because
  `modelIdentifiers()`/`availableModels` never contain the suffix; fix = strip `[1m]` before matching,
  decide 1M support from a new capability table, reattach if eligible.
- Three seams need the fix: `resolveClaudeModel`'s main-tier auto-heal path, the haiku/sonnet/opus
  tier paths (currently unconditional), and `buildModelPickerOptions()` (currently offers no 1M rows
  at all).
- LiteLLM itself already has accurate `max_input_tokens` per deployment, but CodeMie's own
  `/v1/llm_models` doesn't forward it — a real fix at the data layer is a backend change, out of
  scope here; note it as a follow-up, not something to attempt in this CLI-only ticket.
- Router aliases (`claude-router-premium[1m]`) can't be capability-checked by table; treat them as
  always-eligible to keep `[1m]` rather than trying to resolve their underlying deployment.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` interaction with the 1M header remains unverified; flag,
  don't block on it.
