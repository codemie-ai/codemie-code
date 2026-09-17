# Claude Model Auto-Update

## Problem

Claude model identifiers are hardcoded in two independent places in the codebase, and neither is
ever refreshed automatically:

1. **CodeMie-proxied Claude** (`src/agents/plugins/claude/claude.plugin.ts`) — `ClaudePluginMetadata
   .recommendedModels` is a static, hand-maintained array (`['claude-sonnet-4-6', 'claude-4-opus',
   'gpt-4.1']`). Every agent other than Claude in this family — Codex, Kimi, Copilot CLI, Pi — already
   has a dynamic `resolve<Agent>Model` function that fetches the live CodeMie model catalog and picks
   the best current match; Claude is the outlier still relying on a static list.
2. **anthropic-subscription** (`src/providers/plugins/anthropic-subscription/anthropic-subscription
   .template.ts`) — a second, fully independent hardcoded set: `ANTHROPIC_SUBSCRIPTION_DEFAULT_HAIKU
   _MODEL`, `ANTHROPIC_SUBSCRIPTION_DEFAULT_OPUS_MODEL`, and a static `ANTHROPIC_SUBSCRIPTION_MODEL
   _ALIASES` lookup table, forced onto every Claude run via `exportEnvVars(config)`.

Result: users on either path can be stuck on a stale, superseded model (e.g. Sonnet 4.7 still listed
after Sonnet 5 shipped) until someone manually edits the hardcoded source.

## Goals

- CodeMie-proxied Claude usage always resolves to a current, compatible model per tier (default,
  haiku, sonnet, opus) without requiring a manual code change — mirroring the existing Codex/Kimi/
  Copilot pattern exactly.
- A user's explicit model choice (CLI flag, env var, project/global config) is never silently
  overridden by the auto-resolver.
- anthropic-subscription (native Anthropic auth, no CodeMie proxy) stops forcing its own
  independently-hardcoded model list onto the `claude` CLI — that path has no CodeMie catalog to
  query, so the right fix is to stop overriding and let the `claude` CLI's own built-in defaults
  (which the CLI vendor keeps current) take over.
- No changes to `BaseAgentAdapter` or any other agent's plugin — this is Claude-plugin-local plus one
  provider-template change.

## Non-Goals

- No change to how Codex, Kimi, Copilot, Pi, or OpenCode resolve models.
- No new user-facing command or config UI — resolution is transparent, matching how Codex/Kimi/
  Copilot behave today.
- No attempt to unify the two hardcoded sources under one mechanism — they solve different problems
  (one has a catalog to query, the other doesn't) and are fixed independently.

## Design

### 1. CodeMie-proxied Claude: runtime resolver

New file `src/agents/plugins/claude/claude.models.ts`, following the established
`resolve<Agent>Model` convention (`codex-models.ts`, `kimi.models.ts`, `copilot-cli.models.ts`):

- Exports `resolveClaudeModel(env, tier)` where `tier` is one of `model | haiku | sonnet | opus`.
- Fetches the live CodeMie model catalog via the existing shared client
  (`fetchCodeMieLlmModels`/`fetchCodeMieModels` in `src/providers/plugins/sso/sso.http-client.ts`),
  the same client every other dynamic resolver already uses. The catalog fetch is TTL-cached (cache
  keyed by credential/base-URL, short TTL e.g. on the order of the session or a few hours — exact TTL
  value and cache storage mechanism are an implementation detail for the plan) so a normal CLI
  invocation does not pay a network round-trip on every run.
- Filters the catalog to entries compatible with the requested tier, using a naming-pattern predicate
  per tier (entries containing `haiku` / `sonnet` / `opus`; the bare `model` tier uses the general
  Claude-compatible filter, matching how `recommendedModels` was previously scoped).
- Ranks compatible candidates with the same rank/compare approach the other resolvers use (version-
  aware comparison, descending score then id) and selects the top-ranked entry per tier.
- On fetch failure (network/auth error): falls back silently to whichever model is currently
  configured for that tier, logged at `logger.debug` (not warn/error) — a catalog fetch failure must
  never block a CLI run.
- If the fetch succeeds but no compatible model exists for a tier **and** there is no valid current
  fallback: throws `ConfigurationError` (from `src/utils/errors.ts`, per repo convention — never a
  generic `Error`) naming the tier.
- `ClaudePluginMetadata.recommendedModels` stops being read as the source of truth for tier
  resolution; it becomes the resolver's last-resort static fallback constant (used only if both the
  live fetch and the "currently configured" fallback are unavailable, e.g. first-ever run with no
  network).

### 2. Explicit-override protection

Model resolution must never clobber a model the user deliberately chose. This reuses the existing
`modelSource` / `CODEMIE_MODEL_SOURCE` convention (`default | global | project | env | cli`) that
`resolveCopilotModel`'s `assertExplicitCopilotModelAllowed` already relies on:

- The live-catalog resolution path runs **only** when the tier's `modelSource` is `default` (nothing
  explicit set at any config layer), or when the previously-resolved/cached model for that tier is no
  longer present in the live catalog (stale/retired) even though a source claims it was explicit —
  a retired model id can't be honored regardless of how it was set.
- When `modelSource` is `global`, `project`, `env`, or `cli`, the resolver leaves the configured value
  untouched — identical behavior to Copilot today.
- Each tier (`model`, `haiku`, `sonnet`, `opus`) is resolved independently — a user can pin `opus`
  explicitly while `sonnet` still auto-updates.

### 3. Wiring

`resolveClaudeModel` is invoked from `ClaudePlugin`'s `beforeRun` lifecycle hook — the same hook
point `anthropic-subscription`'s provider template already uses today for its own model
normalization — running after `transformEnvVars` has projected the generic `CODEMIE_*` vars but
before the process launches. No change to `BaseAgentAdapter.transformEnvVars` or `run()`; the shared
lifecycle contract other agents depend on is untouched.

### 4. anthropic-subscription: stop overriding

In `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts`:

- Remove `ANTHROPIC_SUBSCRIPTION_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SUBSCRIPTION_DEFAULT_OPUS_MODEL`,
  and the `ANTHROPIC_SUBSCRIPTION_MODEL_ALIASES` table entirely.
- `exportEnvVars(config)` stops normalizing/overriding `CODEMIE_MODEL` / `CODEMIE_HAIKU_MODEL` /
  `CODEMIE_OPUS_MODEL` — it no longer forces those values, so no `ANTHROPIC_MODEL` /
  `ANTHROPIC_DEFAULT_*_MODEL` env var is set by this provider path at all. The `claude` CLI binary's
  own built-in defaults apply, which the CLI vendor (not this codebase) keeps current.
- Verify (implementation-time check, not a design assumption) that `ConfigLoader
  .exportProviderEnvVars`'s "always emit even as `''`" behavior (`src/utils/config.ts:1403`, tied to
  ticket EPMCDME-12779, meant to overwrite stale shell values) does not reintroduce an empty-string
  override for this provider — if it does, the anthropic-subscription template needs to explicitly
  decline to emit these keys rather than emitting them empty.

## Error Handling

| Condition | Behavior |
|---|---|
| Catalog fetch fails (network/auth) | Fall back silently to the currently configured model for that tier; `logger.debug`, never block the run |
| Catalog fetch succeeds, no compatible model for a tier, no valid fallback | Throw `ConfigurationError` naming the tier |
| Tier has an explicit `modelSource` (global/project/env/cli) | Resolver does not touch it, regardless of catalog freshness |
| Previously-resolved model no longer in the live catalog | Re-resolve even if the tier appeared "explicit" — a retired model id is never honored |

## Testing

Per this repo's policy, tests are written only on explicit request. If requested, the natural
coverage mirrors existing patterns:

- `src/agents/plugins/claude/__tests__/claude.models.test.ts` — per-tier ranking, fetch-failure
  fallback, and explicit-override-respect logic, structured like `copilot-cli.models.test.ts`.
- A test on `anthropic-subscription.template.ts` confirming `exportEnvVars` no longer forces
  `CODEMIE_MODEL` / `CODEMIE_HAIKU_MODEL` / `CODEMIE_OPUS_MODEL`.

## Risks Carried Into Implementation

- `ClaudeAcpPlugin`, `ClaudeSessionAdapter` currently have no test coverage — the `beforeRun` wiring
  point must be verified not to regress either.
- The exact TTL value and cache storage mechanism for the catalog fetch are left to implementation
  time — should match (or explicitly reuse) whatever Codex/Kimi already use, to avoid a third
  divergent caching approach.
- The `CODEMIE_MODEL_SOURCE` plumbing must be confirmed to be wired all the way through for Claude's
  four tiers (`model`/`haiku`/`sonnet`/`opus`) specifically, not just the single-model case Copilot
  handles — this is called out as an open verification item in the technical analysis and should be
  the first thing implementation checks.
- `ConfigLoader.exportProviderEnvVars`'s always-emit-even-empty behavior (EPMCDME-12779) needs a
  concrete check against the anthropic-subscription change before relying on "no override" actually
  meaning no env var is set.
