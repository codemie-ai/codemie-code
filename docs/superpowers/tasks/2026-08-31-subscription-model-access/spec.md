# Spec — EPMCDME-14341: Latest Claude Models on an Anthropic Subscription Profile

**Ticket**: https://jiraeu.epam.com/browse/EPMCDME-14341
**Branch**: `EPMCDME-14341_subscription-model-access`
**Complexity**: M (16/36)
**Flow**: sdlc-standard

## Problem

On an `anthropic-subscription` profile the CLI removes model access from a user who already pays for it, in two independent ways:

1. **`--model` is silently swallowed.** `-m/--model` is a config-only option (`AgentCLI.ts:598`); it never reaches the `claude` binary, and the value it sets in `CODEMIE_MODEL` is then blanked by the provider (`anthropic-subscription.template.ts:125`). Every subscription launch runs on Claude Code's own default, with no message that the choice was dropped.
2. **The version prompt defaults to a downgrade.** When the installed Claude Code is newer than CodeMie's pinned version, the launcher prompt (`BaseAgentAdapter.ts:440-467`) defaults to installing the older pinned version — taking newly released models off the menu.

Two adjacent UX gaps compound it: setup asks for and stores a model that never takes effect (pre-filled `sonnet`), and `codemie models list` errors with "not supported" for this provider.

## Locked decisions

- **D1 — No entitlement logic (product owner).** CodeMie passes `--model` straight through to Claude Code and **relays** Claude Code's own refusal for unentitled models. CodeMie never validates entitlement or substitutes a model. A live entitlement catalog is out of scope.
- **D2 — Version-pin flip is subscription-scoped.** The newer-than-pinned default flip and the "newer models may be unavailable" message apply only when `CODEMIE_PROVIDER === 'anthropic-subscription'`. Proxied providers (SSO/LiteLLM/Bedrock) keep today's `install` default, where an untested newer binary can break the CodeMie proxy. The minimum-version hard block is unchanged for all providers.
- **D3 — Passthrough rides a dedicated env var.** `enrichArgs` receives `extractConfig(env)` (derived from env; `.model` = the blanked `CODEMIE_MODEL`), so a new `AgentConfig` field cannot carry the value. A dedicated env var `CODEMIE_CLI_MODEL`, set only from the explicit CLI `--model`, is the mechanism. This is what keeps a stale **stored** profile model from ever being injected.
- **D4 — Tests included** (explicit opt-in via this TDD flow), despite the repo's default "tests only on explicit request".

## Env var contract — `CODEMIE_CLI_MODEL`

- **Set by**: `AgentCLI.handleRun` — only when `options.model` is truthy (the user passed `-m/--model` **this launch**). Never derived from the stored profile.
- **Read by**: `anthropic-subscription` `enrichArgs` (injects `--model`) and the launch banner.
- **Survives blanking**: it is a new key, untouched by the provider's `exportEnvVars` (which blanks `CODEMIE_*_MODEL`) and by `beforeRun` (which deletes `ANTHROPIC_DEFAULT_*`). `Object.assign(process.env, env)` (`BaseAgentAdapter.ts:613`) does not clear keys absent from `env`.
- **Non-subscription providers ignore it** — they continue to resolve model via `CODEMIE_MODEL → ANTHROPIC_MODEL`.

## Change sites

### CS1 — Capture the explicit CLI model (`src/agents/core/AgentCLI.ts`)
In `handleRun`, after config load (~line 203), set `process.env.CODEMIE_CLI_MODEL = options.model` when `options.model` is a non-empty string. Provider-agnostic to write; only the subscription path reads it. No change to `configOnlyOptions` (`--model` stays stripped from generic passthrough for all providers).

### CS2 — Inject `--model` for subscription (`src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts`)
Extend `agentHooks.claude.enrichArgs` (currently only injects `--plugin-dir`). Read `process.env.CODEMIE_CLI_MODEL`; if set **and** `args` does not already contain `--model`, prepend `['--model', value]`. Compose with the existing `--plugin-dir` injection; keep both dedup guards. `exportEnvVars` blanking is unchanged.

### CS3 — Version-pin, subscription-scoped (`src/agents/core/BaseAgentAdapter.ts`)
`run()` receives `envOverrides` (the provider env, carrying `CODEMIE_PROVIDER`) — readable at the version-check branch before `process.env` is merged.
- **Scenario 1 — `isNewer` (line 440-467)**: when `envOverrides?.CODEMIE_PROVIDER === 'anthropic-subscription'`, set the prompt `default` to `'continue'` (else keep `'install'`). No downgrade step runs on the default choice.
- **Scenario 2 — `hasUpdate`, older-but-supported (line 484-501)**: for the subscription provider, add a line to the message that newer models may be unavailable on the installed version. Default stays `'install'` (an upgrade to the verified version, which the AC wants offered).
- **Scenario 0 — `isBelowMinimum` (line 397)**: unchanged; already refuses the below-minimum version and directs the user to update.
- `setup.ts:895` / `install.ts:228` `isNewer` prompts are out of scope (not the launcher run path).

### CS4 — Launch banner states the model (`src/agents/core/BaseAgentAdapter.ts:~564`)
Currently `const model = env.CODEMIE_MODEL || 'unknown'`. For the subscription provider: show `process.env.CODEMIE_CLI_MODEL` when set; otherwise a phrase indicating the model is chosen per session by Claude Code / the user's Anthropic subscription (never `'unknown'`). Non-subscription behavior unchanged.

### CS5 — `codemie models list` (`src/cli/commands/models.ts:73-77`)
For `anthropic-subscription`, replace the `process.exit(1)` "not supported" path with an informational message (exit 0): models come from the user's Anthropic subscription, and `/model` inside Claude Code shows or changes the model in a session. Scoped to the subscription branch; other providers unchanged.

### CS6 — Setup no longer prompts/stores a model (`src/cli/commands/setup.ts`, `src/providers/integration/setup-ui.ts`, `anthropic-subscription.setup-steps.ts`)
For the subscription provider: skip the "Enter model name manually" prompt (`setup.ts:617-632`); `buildConfig` stores no `model`; the success summary (`setup-ui.ts:273`) states the model is chosen per session by Claude Code + the user's Anthropic subscription rather than printing `Model: sonnet`. Pre-existing profiles that already carry a stored model launch normally (runtime ignores it via the blanking + `CODEMIE_CLI_MODEL` mechanism) with no migration.

## Acceptance-criteria traceability

| AC group | Covered by |
|---|---|
| `--model` entitled → session runs on it; launch not refused; relayed to `claude` | CS1 + CS2 |
| no `--model` → Claude Code default; no imposed/pre-filled model | CS1 (var unset) + CS2 (no injection) |
| in-session `/model` switch stays in effect | Unchanged (Claude Code owns the session) |
| API-key/SSO `--model` resolution unchanged | CS1/CS2 scoped; shared env pipeline untouched |
| model stated to the user at start | CS4 |
| setup not asked for a model; summary explains per-session choice | CS6 |
| `models list` explains source; no "unsupported" error | CS5 |
| stale stored model not presented / no migration | CS6 + D3 |
| newer-than-verified: warned; default continues on installed; no downgrade | CS3 Scenario 1 |
| older-but-supported: told newer models may be unavailable; offered update | CS3 Scenario 2 |
| below minimum: no session; told to update | CS3 Scenario 0 (unchanged) |
| unentitled model → refusal names model, attributes to subscription; no substitution | D1 (Claude Code refuses; CodeMie relays, never swallows/substitutes) |
| not installed/not authenticated → existing guidance | Unchanged |
| session-end reporting records actual model used | Verified — analytics reads transcripts (`BaseAgentAdapter.ts:908`); no change |

## Out of scope

Live entitlement-backed model catalog; supported-version refresh cadence / whether the pin should exist for other providers; Moonshot Subscription parity; per-tier overrides on the subscription path; any change to model resolution/ranking/recommended-starring for API-key/SSO/Bedrock/LiteLLM; models absent from Claude Code's own picker on a verified version; pricing entries for unreleased models; agents other than Claude Code; the `setup`/`install` command version prompts.

## Test plan (Vitest, unit unless noted)

1. `anthropic-subscription.template.test.ts` — `enrichArgs` injects `['--model', v]` when `CODEMIE_CLI_MODEL` set; injects nothing when unset; does **not** double-inject when `--model` already in `args`; composes with `--plugin-dir`.
2. `moonshot-subscription` — assert its `enrichArgs`/template is untouched by the `CODEMIE_CLI_MODEL` mechanism (no injection).
3. `BaseAgentAdapter` version prompt — Scenario 1 default is `'continue'` when provider is `anthropic-subscription`, `'install'` otherwise; minimum-version block unchanged.
4. `models list` — subscription provider prints the informational message and exits 0 (no "unsupported" error).
5. Setup — `buildConfig` stores no `model` for the subscription provider; success summary text asserts per-session wording.
6. Banner — states `CODEMIE_CLI_MODEL` when set; states the per-session phrase (not `'unknown'`) when unset, for the subscription provider.

## Risks & mitigations

- **Shared env pipeline regression** → confine changes to the subscription template + the provider-guarded branches in `BaseAgentAdapter`/`models.ts`; never touch `transformEnvVars`/`exportProviderEnvVars`/`collectPassThroughArgs`. `model-tier-e2e.test.ts` is the regression guard for the non-subscription env path.
- **Double `--model`** → dedup guard checks for both `--model` and the `--model=` equals-form before injecting (mirrors `--plugin-dir`). The equals-form is reachable only via raw passthrough after `--` (e.g. `-m X -- --model=Y`); found and closed during manual edge-case verification.
- **`moonshot-subscription` drift** → only `anthropic-subscription.template.ts` is edited; test 2 guards it.
- **Provider not readable at version branch** → mitigated: `envOverrides` carries `CODEMIE_PROVIDER` (AgentCLI:461 → run()).
- **No automated coverage for new behaviors** → addressed by the test plan above (D4).
