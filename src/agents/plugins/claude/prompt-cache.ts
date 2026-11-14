/**
 * Providers whose gateway is known to round-trip what tool search requires: the
 * `tool-search-tool-2025-10-19` beta header, `defer_loading` tool fields and `tool_reference`
 * content blocks.
 *
 * - `ai-run-sso` — the local CodeMie proxy forwards every request header except `host`/`connection`
 *   (`sso.proxy.ts`), and this was verified end to end (44,396 -> 24,353 turn-one tokens).
 * - `litellm` — documents passing the beta header, `defer_loading` and `tool_reference` through.
 *
 * `beforeRun` is provider-agnostic and runs for bedrock, ollama and subscription endpoints too, for
 * which no such evidence exists — and a gateway that takes the body fields without the header answers
 * HTTP 400. So the tool-search defaults are applied only here; every other provider keeps the
 * conservative values, and either variable set explicitly in the environment still wins everywhere.
 */
export const TOOL_SEARCH_VERIFIED_PROVIDERS = new Set(['ai-run-sso', 'litellm']);

/** The two launch defaults that decide which prompt-cache TTL a Claude Code session asks for. */
export interface ClaudeCacheDefaults {
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?: string;
  ENABLE_PROMPT_CACHING_1H?: string;
}

/** Pure. Returns only the keys CodeMie would set, i.e. those empty/unset in `env`. */
export function claudeCacheDefaults(env: NodeJS.ProcessEnv): ClaudeCacheDefaults {
  const defaults: ClaudeCacheDefaults = {};
  if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
    defaults.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = TOOL_SEARCH_VERIFIED_PROVIDERS.has(env.CODEMIE_PROVIDER ?? '')
      ? '0'
      : '1';
  }
  if (!env.ENABLE_PROMPT_CACHING_1H) {
    defaults.ENABLE_PROMPT_CACHING_1H = '1';
  }
  return defaults;
}
