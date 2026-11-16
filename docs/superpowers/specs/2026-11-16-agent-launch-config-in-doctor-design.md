# Agent launch config in `codemie doctor`: design

Date: 2026-11-16 · Branch: `fix/claude-prompt-cache-1h-ttl` · Status: implemented (PR #820)

## Intent

`codemie doctor` shows, under each installed agent, the environment that agent launches with:
every variable CodeMie sets or watches, the value in effect, and where that value comes from.

Provider-specific launch values belong to the provider, not the agent. The code's own rule is:
"Agents remain FULLY provider-agnostic. Providers register hooks for agents they need to
customize" (`lifecycle-helpers.ts`).

## Launch: who sets what

| Layer | Declared in | Applied by | Precedence |
|---|---|---|---|
| User | shell, Claude settings `env` block | (already there) | always wins |
| Provider | `agentHooks.<agent>.env` (`ProviderLifecycleHooks.env`, plain data) | `applyProviderAgentEnv` in `executeBeforeRun`, before any `beforeRun` hook | fills only unset variables |
| Agent | `AgentMetadata.launchEnvDefaults` (`CLAUDE_LAUNCH_ENV_DEFAULTS`) | `applyLaunchEnvDefaults` in Claude's default `beforeRun` | fills only what is still unset |

- **Provider `env` is not a hook.** It doesn't replace the agent's default `beforeRun` the way an
  agent-specific provider `beforeRun` does. Bedrock's `claude` hook still replaces it, and
  `agentDefaultHookRuns` in `lifecycle-helpers.ts` is the single statement of that rule.
- **Claude's defaults name no provider.** They are:
  - `ENABLE_PROMPT_CACHING_1H=1`;
  - the gateway-safe values `ENABLE_TOOL_SEARCH=0` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`;
  - telemetry off and the binary auto-updater off, with plugin auto-updates kept on;
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from the profile, else 85.

  `CLAUDE_CODE_AUTO_MODE_SERVER` has no default.
- **Providers declare the rest**, for both `claude` and `claude-acp` (hooks are keyed by exact
  agent name):

  | Provider | `ENABLE_TOOL_SEARCH` | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `CLAUDE_CODE_AUTO_MODE_SERVER` | Why |
  |---|---|---|---|---|
  | `ai-run-sso` | `true` | `0` | `0` | proxy forwards the tool-search payload; gateway can't carry auto-mode safeguards |
  | `litellm` | `true` | `0` | — | LiteLLM passes the tool-search payload through |
  | `anthropic-subscription` | `true` | `0` | — | direct to Anthropic; the gateway-safe values only cost tokens |
  | others | — | — | — | Claude's gateway-safe defaults apply |

## Doctor

- **Placement:** the rows sit under the agent's line in Installed Agents, below one header line,
  as aligned `NAME = value  source` rows.
- **Sources, in precedence order:** settings file path, `your shell`, `provider <name>`,
  `profile "<name>"`, `CodeMie default`. A row adds what it overrides when that differs.
- **Watched rows:** variables CodeMie never sets appear only when something sets them. These are
  `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`,
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and `DISABLE_PROMPT_CACHING[_HAIKU|_SONNET|_OPUS]`, plus the
  settings keys `promptCacheTtl` and `subagentPromptCacheTtl` (`settingsKey` declarations).
- **No winner is computed.** When several cache settings are set, Claude Code decides which wins,
  and doctor doesn't guess. An earlier prompt-cache resolver did guess, using a precedence order
  never verified against Claude Code, and was removed.
- **`--profile <name>`** evaluates another profile; the default is the active one.
- **Notes and failures:**
  - Inside an agent session, one line notes that variables are inherited.
  - A failure for one agent becomes one `info` line under that agent and never fails the check.
- **Doctor only reads.** It never runs `beforeRun`, and it strips terminal controls from
  everything it prints that came from a file, the shell or the profile.

## Measured effect (same model `claude-opus-5-5`, same prompt)

| Setup | Total input | Uncached per run |
|---|---|---|
| plain `claude` | 93,594 | 4 |
| `codemie-claude --profile anthropic`, before | 131,073 | 21,466 |
| `codemie-claude --profile anthropic`, after | 94,146 | 4 |

A 5-run agentic task, SSO against plain `claude`, came out within 1% (median 340.9k vs 339.3k
total input), with every cache write at the 1h TTL.

## Out of scope

- **Model selection.** Claude's catalog-based tier resolution still skips
  `anthropic-subscription` by name. That's about models, not launch env.
- **Other agents' launch defaults.** Copilot CLI, Codex, OpenCode and OpenWiki can declare theirs
  the same way later.
