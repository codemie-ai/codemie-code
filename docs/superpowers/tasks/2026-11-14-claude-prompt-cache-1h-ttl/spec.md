# Spec: 1-hour prompt cache for `codemie-claude` — consistent, visible and diagnosable

## Intent

Users report a sharp rise in spend with `codemie-claude` and suspect a 5-minute prompt cache. Findings:

- CodeMie already sets `ENABLE_PROMPT_CACHING_1H=1` in the Claude agent default `beforeRun` (`src/agents/plugins/claude/claude.plugin.ts:351-353`), uncommented and untested. It reaches Claude Code on sso, jwt, litellm, anthropic-subscription and ollama.
- On bedrock it does not: `resolveHook` leaves the agent default out when a provider registers an agent-specific hook (`src/agents/core/lifecycle-helpers.ts:84-100`). This is a known gap, left for a follow-up (see Non-goals).
- Reproduction (codemie 0.16.8, Claude Code 2.1.322, default profile): `codemie-claude -p … --output-format json` reported `ephemeral_1h_input_tokens: 33897`, `ephemeral_5m_input_tokens: 0`. 1h is honoured end to end on a current install.
- Claude Code docs: the flag is outranked by `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, the settings keys `promptCacheTtl` / `subagentPromptCacheTtl`, and by a settings `env` block, which replaces the process value. `DISABLE_PROMPT_CACHING*` turns caching off.

This change makes the 1h setup consistent, visible and diagnosable on the non-bedrock providers. **It does not promise lower spend**: the default path was already at 1h, the cause of the reported rise is not located, and 1h cache writes cost more than 5m writes. The doctor check is the tool for locating the cause in a user's setup (old or hand-edited settings, shell variables).

## Size

Within the S estimate (upper end). No shared agent core and no provider template is touched: one small extraction in the Claude plugin, an extension of an existing settings reader, a resolver, a doctor check, tests.

## Behaviour

### 1. Hook chaining

Not changed. `resolveHook`, `lifecycle-helpers.ts` and the bedrock template stay as they are.

### 2. The cache default

Stays `ENABLE_PROMPT_CACHING_1H=1`, set only when unset, on every provider that runs the Claude agent default. It gains the comment its neighbours have: why, the opt-out, the upstream doc link, and that upstream needs v2.1.108+, below CodeMie's supported minimum (`claude.plugin.ts:44-54`).

The two rules the resolver needs — the cache default, and the `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` value by provider (`claude.plugin.ts:287-289`) — move into one exported pure function called by `beforeRun` and by the resolver. Values and gating are unchanged.

### 3. One resolver for "effective prompt-cache setup"

A single read-only function answers, for a `claude` launch in a given profile and working directory: which TTL is expected (`1h`, `5m`, `disabled`, `unknown`) and what decided it. It returns a structured result and holds the upstream precedence (Intent, last bullet) as one ordered table.

Inputs:

- the env (the cache variables in Intent, the betas switch, the provider), with CodeMie's defaults from the section 2 function applied;
- the Claude settings layers — user, project, local, managed — taken from the existing layered reader (`src/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.ts:23-86`, which honours `CLAUDE_CONFIG_DIR` / `CLAUDE_PROJECT_DIR`), extended to return each layer's path and parsed object. `readClaudeSettingsEnv` keeps its contract.

Rules:

- it names the source of whatever decides the outcome: shell, which settings file, or CodeMie default;
- an unreadable layer gives `unknown`, never "no override";
- "1h requested, not confirmed" is derived from the resolved betas value, with no provider list of its own;
- a non-empty `ENABLE_PROMPT_CACHING_1H` other than `1` / `true` gives `unknown`, value shown;
- it never writes a settings file and spawns no process.

Assumption: the per-launch `--settings` file CodeMie writes for sso/jwt (`src/providers/core/default-agent-hooks.ts:79-82`) carries no cache key; doctor cannot see that layer.

### 4. Launch log

Every `claude` / `claude-acp` launch writes one `logger.debug` line with the resolver's result: expected TTL, deciding source, and the cache variables as resolved.

### 5. `codemie doctor`

A new check, added to the `checks` array that runs them (`src/cli/commands/doctor/index.ts:93-105`), reports the resolver's result for the active profile and current directory, and prints both.

- `ok`: 1h expected, on `ai-run-sso` and `litellm`;
- `info`: 1h requested but not confirmed on this provider path; or, on bedrock, that CodeMie's 1h default is not applied there (known gap);
- `warn`: 5m, disabled or `unknown`, naming the variable or file responsible and how to remove it;
- always: the one-line way to confirm what is billed — a `-p --output-format json` call and the `usage.cache_creation` 1h / 5m fields.

It emits one `info` line when Claude Code is not installed, runs no model request, and never sets `success: false` (a warning does not change doctor's exit code, as in `AgentsCheck.ts:89`).

## Acceptance criteria

- AC1. Removed with the bedrock fix.
- AC2. For every provider/agent pair, the env and args produced at launch are the same as before.
- AC3. On every provider that runs the Claude agent default, a non-empty `ENABLE_PROMPT_CACHING_1H` from the shell is kept; an empty one is treated as unset.
- AC4. A launch writes one debug line stating the expected cache TTL and what decided it.
- AC5. `codemie doctor` shows a prompt-cache check that reports `ok` on a clean current install on `ai-run-sso` and `litellm`; on other providers reports `info`: 1h requested, not confirmed, with the confirming command; and warns, naming the cause, for each of: a higher-precedence variable in the shell, a settings `env` entry or TTL key in user, project, local or managed settings, caching disabled, an unreadable settings layer.
- AC6. For a given profile, working directory and shell environment, doctor's result equals the launch log's (one resolver).
- AC7. Tests: one `claude.plugin.<concern>.test.ts` file for the cache default (default, explicit value wins, empty treated as unset).
- AC8. Manual check on the default profile: `codemie-claude -p … --output-format json` reports `ephemeral_1h_input_tokens > 0` and `ephemeral_5m_input_tokens = 0`, and `codemie doctor` reports `ok` for the same profile.

## Non-goals

- No bedrock fix: no change to `resolveHook` / `lifecycle-helpers.ts`, to the bedrock template, or to which hooks bedrock + `claude` runs. Known gap for a follow-up: that pair receives no agent default `beforeRun`, so no 1h flag and none of the other Claude defaults.
- No per-profile or CLI setting for the cache TTL.
- No editing, migrating or cleaning of the user's `~/.claude` or project settings; doctor reports only.
- No console warning at launch; the launch signal is the debug log.
- No change to the SSO proxy, its request plugins, the gateway or LiteLLM.
- No change to `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` or any other existing default's value or gating.
- No fix for subagent/compaction buckets beyond what `ENABLE_PROMPT_CACHING_1H` already requests; `CLAUDE_CODE_PROMPT_CACHE_TTL` is not injected.
- No change to pricing, statusline or analytics cost readers.
- No doctor-side model request to measure the billed TTL.
- No claim or criterion about lower spend.

## Decisions

- Bedrock is left out of this task and recorded as a known gap, over fixing it through hook chaining or the bedrock template — user, answers AR-1, AR-2
- Proceed without a promise of lower spend and carry the cause as an open item, over waiting for a complaining user's data — user, answers AR-4
- Scope includes a `codemie doctor` check and launch logging of the effective cache setup, over shipping the env fix alone — user
- 1h stays the default for every provider with the shell value winning, over a per-profile setting — user
- Tests: a cache-default test file plus a bedrock case, over no tests — user
- The bedrock test case is dropped, over kept: it tested the fix the user removed.
- Only the two rules the resolver needs are extracted into a shared pure function, over moving all guarded defaults or copying the rules into the resolver.
- Settings layers come from the existing layered reader, extended, over a new reader in the resolver.
- The installed Claude Code version is not a resolver input, over a below-2.1.108 warning: the supported minimum already blocks older versions.
- Doctor reports the bedrock gap as `info`, over staying silent or warning.
- The doctor check never fails the doctor run, over `success: false` on a warning.
- One shared resolver for doctor and the launch log, over two implementations.
- Stale or conflicting user settings are reported, over auto-corrected.
- Launch signal is a debug log line, over a visible console warning: the user asked for logs, and doctor carries the visible message.
- Doctor is static (env, files), over running a paid request.
- Keep `ENABLE_PROMPT_CACHING_1H` as the only injected cache variable, over also injecting `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`.

## Risks and open items

- **Open item — cause of the reported rise.** From one complaining user: provider, Claude Code version and the 1h/5m cache-write split from the section 5 one-liner; and the date the 1h default landed against the first complaint. The 1h write premium is itself a candidate cause.
- **Open for the gate — tests for the resolver and the doctor check** were not asked for and are not in AC7; recommended, since AC5 and AC6 otherwise have no automated check.
- Through a gateway, 1h also needs an `extended-cache-ttl` beta. CodeMie sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` for providers other than `ai-run-sso` / `litellm`; whether that strips the beta is unconfirmed. Doctor reports these paths as `info`.
- Upstream precedence among cache variables, settings keys and managed settings is taken from the docs, not checked against the binary; the meaning of `ENABLE_PROMPT_CACHING_1H=0` is unverified.
- LiteLLM / Bedrock Converse support for a 1h TTL is unverified.
- Doctor evaluates the active profile and current directory; a launch with another profile or directory can differ. Doctor prints both so the reader can tell.
