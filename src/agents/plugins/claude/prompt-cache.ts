import {
  readClaudeSettingsLayers,
  type ClaudeSettingsLayer,
} from '@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js';

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

export type CacheTtl = '1h' | '5m' | 'disabled' | 'unknown';

export type CacheSource =
  | { kind: 'shell' | 'codemie-default' | 'upstream-default' }
  | { kind: 'settings'; path: string };

/** The prompt-cache TTL a Claude Code session will ask for, and what decided it. */
export interface PromptCacheSetup {
  ttl: CacheTtl;
  /** Variable or settings key that decided, e.g. 'FORCE_PROMPT_CACHING_5M', 'promptCacheTtl', 'upstream default'. */
  decidedBy: string;
  /** Raw deciding value. */
  value?: string;
  source: CacheSource;
  /** False when the resolved CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is '1'/'true': the request is made, its effect is not verified. */
  confirmed: boolean;
  /** Only when a subagent override exists. */
  subagent?: { ttl: CacheTtl; decidedBy: string; source: CacheSource };
  /** Every cache variable that has a value, plus the betas switch, as resolved. */
  variables: Record<string, string>;
}

export interface PromptCacheInput {
  /** The environment BEFORE CodeMie defaults. */
  env: NodeJS.ProcessEnv;
  /** Whether this launch path applies `claudeCacheDefaults` (the agent's default `beforeRun` runs). */
  codemieDefaults: boolean;
}

interface Resolved {
  value: string;
  source: CacheSource;
}

/** What a precedence row sees: resolved variables and settings keys, never the raw layers. */
interface PrecedenceContext {
  variable(name: string): Resolved | undefined;
  variableNames(): string[];
  setting(key: string): Resolved | undefined;
}

interface PrecedenceMatch extends Resolved {
  ttl: CacheTtl;
  decidedBy: string;
}

export interface PromptCachePrecedenceRow {
  name: string;
  match(ctx: PrecedenceContext): PrecedenceMatch | undefined;
}

const BETAS_SWITCH = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS';
const DISABLE_PREFIX = 'DISABLE_PROMPT_CACHING';
const SUBAGENT_TTL_VARIABLE = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';
const SUBAGENT_TTL_SETTING = 'subagentPromptCacheTtl';
const CACHE_VARIABLES = [
  'FORCE_PROMPT_CACHING_5M',
  'CLAUDE_CODE_PROMPT_CACHE_TTL',
  'ENABLE_PROMPT_CACHING_1H',
  SUBAGENT_TTL_VARIABLE,
  BETAS_SWITCH,
];

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function ttlOf(value: string): CacheTtl {
  const normalized = value.trim().toLowerCase();
  return normalized === '1h' || normalized === '5m' ? normalized : 'unknown';
}

/** A row for a value that names the TTL itself ('1h' / '5m'); any other non-empty value is unknown. */
function ttlValueRow(name: string, read: (ctx: PrecedenceContext) => Resolved | undefined): PromptCachePrecedenceRow {
  return {
    name,
    match(ctx) {
      const resolved = read(ctx);
      return resolved?.value ? { ...resolved, ttl: ttlOf(resolved.value), decidedBy: name } : undefined;
    },
  };
}

/**
 * Which setting decides the prompt-cache TTL: the first matching row wins.
 *
 * The order is the documented intent of each setting and has not been verified against the Claude
 * Code binary. It lives only here, so a correction is one edit.
 */
export const PROMPT_CACHE_PRECEDENCE: readonly PromptCachePrecedenceRow[] = [
  {
    name: `${DISABLE_PREFIX}*`,
    match(ctx) {
      for (const name of ctx.variableNames()) {
        if (!name.startsWith(DISABLE_PREFIX)) continue;
        const resolved = ctx.variable(name);
        if (resolved && isTruthy(resolved.value)) return { ...resolved, ttl: 'disabled', decidedBy: name };
      }
      return undefined;
    },
  },
  {
    name: 'FORCE_PROMPT_CACHING_5M',
    match(ctx) {
      const resolved = ctx.variable('FORCE_PROMPT_CACHING_5M');
      return resolved && isTruthy(resolved.value)
        ? { ...resolved, ttl: '5m', decidedBy: 'FORCE_PROMPT_CACHING_5M' }
        : undefined;
    },
  },
  ttlValueRow('CLAUDE_CODE_PROMPT_CACHE_TTL', (ctx) => ctx.variable('CLAUDE_CODE_PROMPT_CACHE_TTL')),
  ttlValueRow('promptCacheTtl', (ctx) => ctx.setting('promptCacheTtl')),
  {
    name: 'ENABLE_PROMPT_CACHING_1H',
    match(ctx) {
      const resolved = ctx.variable('ENABLE_PROMPT_CACHING_1H');
      if (!resolved?.value) return undefined;
      return { ...resolved, ttl: isTruthy(resolved.value) ? '1h' : 'unknown', decidedBy: 'ENABLE_PROMPT_CACHING_1H' };
    },
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildContext(input: PromptCacheInput, layers: ClaudeSettingsLayer[]): PrecedenceContext {
  // Highest precedence first, so the first hit is the layer Claude Code would use.
  const readable = layers.filter((layer) => layer.state === 'ok' && layer.settings).reverse();
  const defaults: Record<string, string | undefined> = input.codemieDefaults ? { ...claudeCacheDefaults(input.env) } : {};

  return {
    variable(name) {
      for (const layer of readable) {
        const block = layer.settings?.env;
        if (isPlainObject(block) && block[name] !== undefined && block[name] !== null) {
          return { value: String(block[name]), source: { kind: 'settings', path: layer.path } };
        }
      }
      const shell = input.env[name];
      if (shell) return { value: shell, source: { kind: 'shell' } };
      const fallback = defaults[name];
      return fallback ? { value: fallback, source: { kind: 'codemie-default' } } : undefined;
    },
    variableNames() {
      const names = new Set<string>([...CACHE_VARIABLES, ...Object.keys(input.env)]);
      for (const layer of readable) {
        const block = layer.settings?.env;
        if (isPlainObject(block)) Object.keys(block).forEach((name) => names.add(name));
      }
      return [...names].filter((name) => CACHE_VARIABLES.includes(name) || name.startsWith(DISABLE_PREFIX)).sort();
    },
    setting(key) {
      for (const layer of readable) {
        const value = layer.settings?.[key];
        if (value !== undefined && value !== null) {
          return { value: String(value), source: { kind: 'settings', path: layer.path } };
        }
      }
      return undefined;
    },
  };
}

/** The highest layer that cannot be trusted: unreadable, or readable with an `env` that is not an object. */
function untrustedLayer(layers: ClaudeSettingsLayer[]): ClaudeSettingsLayer | undefined {
  return [...layers]
    .reverse()
    .find(
      (layer) =>
        layer.state === 'unreadable' ||
        (layer.state === 'ok' && layer.settings?.env !== undefined && !isPlainObject(layer.settings.env))
    );
}

/** Pure. `input.env` is the environment BEFORE CodeMie defaults; `layers` are lowest to highest precedence. */
export function decidePromptCacheSetup(input: PromptCacheInput, layers: ClaudeSettingsLayer[]): PromptCacheSetup {
  const ctx = buildContext(input, layers);

  const variables: Record<string, string> = {};
  for (const name of ctx.variableNames()) {
    const resolved = ctx.variable(name);
    if (resolved) variables[name] = resolved.value;
  }
  const betas = ctx.variable(BETAS_SWITCH);
  const confirmed = !(betas && isTruthy(betas.value));

  const untrusted = untrustedLayer(layers);
  if (untrusted) {
    return {
      ttl: 'unknown',
      decidedBy: 'unreadable settings',
      source: { kind: 'settings', path: untrusted.path },
      confirmed,
      variables,
    };
  }

  let decision: PrecedenceMatch | undefined;
  for (const row of PROMPT_CACHE_PRECEDENCE) {
    decision = row.match(ctx);
    if (decision) break;
  }

  const subagentVariable = ctx.variable(SUBAGENT_TTL_VARIABLE);
  const subagentSetting = ctx.setting(SUBAGENT_TTL_SETTING);
  let subagent: PromptCacheSetup['subagent'];
  if (subagentVariable?.value) {
    subagent = { ttl: ttlOf(subagentVariable.value), decidedBy: SUBAGENT_TTL_VARIABLE, source: subagentVariable.source };
  } else if (subagentSetting?.value) {
    subagent = { ttl: ttlOf(subagentSetting.value), decidedBy: SUBAGENT_TTL_SETTING, source: subagentSetting.source };
  }

  return {
    ...(decision
      ? { ttl: decision.ttl, decidedBy: decision.decidedBy, value: decision.value, source: decision.source }
      : { ttl: '5m', decidedBy: 'upstream default', source: { kind: 'upstream-default' } }),
    confirmed,
    ...(subagent ? { subagent } : {}),
    variables,
  };
}

/** Reads the settings layers for `cwd` and decides. Reads only: no file is written, nothing is spawned. */
export async function resolvePromptCacheSetup(input: PromptCacheInput & { cwd: string }): Promise<PromptCacheSetup> {
  const layers = await readClaudeSettingsLayers(input.cwd, input.env);
  return decidePromptCacheSetup(input, layers);
}

/** 'shell', 'CodeMie default', 'Claude Code default', or the settings file path. */
export function describePromptCacheSource(source: CacheSource): string {
  if (source.kind === 'settings') return source.path;
  if (source.kind === 'shell') return 'shell';
  return source.kind === 'codemie-default' ? 'CodeMie default' : 'Claude Code default';
}
