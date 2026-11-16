/**
 * The environment variables a `codemie-claude` launch sets when they are unset or empty.
 *
 * This list is the single source: the Claude default `beforeRun` applies it
 * (`applyLaunchEnvDefaults`), the prompt-cache resolver derives its CodeMie defaults from it
 * (`claudeCacheDefaults`), and `codemie doctor` describes it under Installed Agents. Order is the
 * order the launcher applies them in. Any non-empty value already in the environment is kept, so
 * setting a variable in the shell is always the opt-out.
 *
 * Provider-neutral by design ("agents define DEFAULT behavior only", agents/core/types.ts): no
 * value here depends on which provider runs Claude. A provider whose connection allows more declares
 * its own values in `agentHooks.claude.env` (and `agentHooks['claude-acp'].env`); those are applied
 * first (applyProviderAgentEnv), so these defaults only fill what is still unset. Examples: sso and
 * litellm turn tool search on; sso turns the auto-mode server review off.
 *
 * Imports nothing from claude.plugin.ts or prompt-cache.ts: both import this module.
 */

import type { LaunchEnvDefault, LaunchEnvValue } from '../../core/types.js';

const DEFAULT_AUTOCOMPACT_PCT = 85;

function codemie(value: string): LaunchEnvValue {
  return { value, from: 'codemie-default' };
}

export const CLAUDE_LAUNCH_ENV_DEFAULTS: readonly LaunchEnvDefault[] = [
  /**
   * Experimental betas off: the gateway-safe default. A gateway that takes the body fields
   * (`context_management` / `output_config`) without the beta header answers HTTP 400.
   * CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS also suppresses the tool-search beta header and wins over
   * ENABLE_TOOL_SEARCH, so a provider that enables tool search sets this to '0' as well.
   * Parsed as a boolean upstream, so '0' reads as false — do NOT use '' for it: the unset-or-empty
   * guard treats an empty string as unset and would restore this default.
   * https://code.claude.com/docs/en/llm-gateway-protocol
   */
  {
    name: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    value: () => codemie('1'),
    why: 'Experimental betas off unless the provider allows them (gateway-safe). Set to 0 to allow them.',
  },
  /**
   * Ask for the 1-hour prompt-cache TTL instead of the upstream 5-minute default, so a cached
   * prefix survives the pauses of an ordinary working session. Upstream honours it from Claude
   * Code v2.1.108, which is below CLAUDE_MINIMUM_SUPPORTED_VERSION, so every launchable version
   * understands it. https://code.claude.com/docs/en/settings
   */
  {
    name: 'ENABLE_PROMPT_CACHING_1H',
    value: () => codemie('1'),
    why: '1-hour prompt-cache TTL instead of the 5-minute default. Set any other non-empty value to opt out.',
  },
  /**
   * Server-side auto-mode classifier review: no Claude default, Claude Code decides. A provider
   * whose gateway cannot carry the `safeguards` / `safeguard_results` fields sets it to '0' in its
   * `agentHooks.claude.env` (ai-run-sso). Listed so doctor shows it whenever it has a value.
   * https://code.claude.com/docs/en/auto-mode-classifier-billing
   */
  {
    name: 'CLAUDE_CODE_AUTO_MODE_SERVER',
    value: () => undefined,
    why: 'Server-side auto mode review; set to 0 by a provider whose gateway cannot carry it.',
  },
  /**
   * Disable Claude Code telemetry to prevent 404s on /api/event_logging/batch when using the
   * proxy (the telemetry endpoint doesn't exist on the CodeMie backend).
   * https://code.claude.com/docs/en/settings
   */
  {
    name: 'CLAUDE_CODE_ENABLE_TELEMETRY',
    value: () => codemie('0'),
    why: 'Claude Code telemetry off: its endpoint does not exist behind the CodeMie proxy.',
  },
  /**
   * CRITICAL: Disable the Claude Code auto-updater to maintain version control. CodeMie manages
   * Claude versions explicitly via installVersion() for compatibility; auto-updates could break
   * version compatibility with the CodeMie backend. https://code.claude.com/docs/en/settings
   */
  {
    name: 'DISABLE_AUTOUPDATER',
    value: () => codemie('1'),
    why: 'Claude Code auto-updater off: CodeMie pins the supported version (codemie install claude --supported).',
  },
  /**
   * ...but keep *plugin* auto-updates working. Upstream gates them on the same predicate as the
   * binary updater:
   *   Pmt() = autoUpdaterDisabled() && !FORCE_AUTOUPDATE_PLUGINS
   * which both skips the background plugin update pass and hides the per-marketplace "Enable
   * auto-update" item from the /plugin Marketplaces menu entirely. Without this, pinning the
   * binary above silently leaves every CodeMie user on whatever plugin version they first
   * installed, with no visible control to change it.
   * https://code.claude.com/docs/en/discover-plugins#configure-auto-updates
   */
  {
    name: 'FORCE_AUTOUPDATE_PLUGINS',
    value: () => codemie('1'),
    why: 'Plugin auto-updates kept on although the Claude Code updater is off.',
  },
  /**
   * Tool search off: the gateway-safe default. Tool search withholds MCP/deferrable tool definitions
   * from the context and loads them on demand, which cuts a large fixed cost from every turn
   * (measured 44,396 -> 24,353 turn-one tokens), but a gateway that receives `tool_reference`
   * blocks it cannot round-trip answers HTTP 400 rather than degrading. A provider whose connection
   * carries the payload sets 'true' (and CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='0') in its
   * `agentHooks.claude.env`: ai-run-sso, litellm, anthropic-subscription.
   * https://code.claude.com/docs/en/agent-sdk/tool-search
   */
  {
    name: 'ENABLE_TOOL_SEARCH',
    value: () => codemie('0'),
    why: "Tool search off unless the provider enables it (gateway-safe). Set 'true'/'auto:N' to opt in, '0' to opt out.",
  },
  /** Auto-compaction threshold: the profile's `claudeAutocompactPct`, else 85. */
  {
    name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    value: (env) => {
      if (env.CODEMIE_PROFILE_CONFIG) {
        try {
          const profileConfig: unknown = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
          const pct = (profileConfig as { claudeAutocompactPct?: unknown } | null)?.claudeAutocompactPct;
          if (typeof pct === 'number') return { value: String(pct), from: 'profile' };
        } catch {
          // ignore malformed profile config
        }
      }
      return codemie(String(DEFAULT_AUTOCOMPACT_PCT));
    },
    why: "Context auto-compaction threshold (%). Set claudeAutocompactPct in the profile to change it.",
  },
];

/** Watched, never set: CodeMie leaves it alone, but `codemie doctor` shows it whenever it has a value. */
function watched(name: string, why: string): LaunchEnvDefault {
  return { name, value: () => undefined, why };
}

/**
 * Variables CodeMie never sets that can shorten, override or switch off the prompt cache that
 * ENABLE_PROMPT_CACHING_1H asks for. Declared so `codemie doctor` lists any of them that has a
 * value (shell or a Claude settings `env` block) next to the defaults above; the precedence between
 * them is the prompt-cache resolver's (PROMPT_CACHE_PRECEDENCE in prompt-cache.ts).
 */
export const CLAUDE_PROMPT_CACHE_WATCHED: readonly LaunchEnvDefault[] = [
  watched('FORCE_PROMPT_CACHING_5M', 'Forces the 5-minute prompt-cache TTL; wins over ENABLE_PROMPT_CACHING_1H.'),
  watched('CLAUDE_CODE_PROMPT_CACHE_TTL', 'Sets the prompt-cache TTL directly (1h or 5m).'),
  watched('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'Sets the prompt-cache TTL for subagents (1h or 5m).'),
  watched('DISABLE_PROMPT_CACHING', 'Turns prompt caching off for every model.'),
  watched('DISABLE_PROMPT_CACHING_HAIKU', 'Turns prompt caching off for Haiku models.'),
  watched('DISABLE_PROMPT_CACHING_SONNET', 'Turns prompt caching off for Sonnet models.'),
  watched('DISABLE_PROMPT_CACHING_OPUS', 'Turns prompt caching off for Opus models.'),
];

/** Every row `codemie doctor` may show under Claude: the defaults CodeMie sets, then the watched cache variables. */
export const CLAUDE_LAUNCH_ENV_ROWS: readonly LaunchEnvDefault[] = [...CLAUDE_LAUNCH_ENV_DEFAULTS, ...CLAUDE_PROMPT_CACHE_WATCHED];
