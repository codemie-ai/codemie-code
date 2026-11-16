import {
  readClaudeSettingsLayers,
  type ClaudeSettingsLayer,
} from '@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js';
import { CLAUDE_LAUNCH_ENV_DEFAULTS } from './launch-env-defaults.js';

/** The two launch defaults that decide which prompt-cache TTL a Claude Code session asks for. */
export interface ClaudeCacheDefaults {
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?: string;
  ENABLE_PROMPT_CACHING_1H?: string;
}

const CACHE_DEFAULT_NAMES: ReadonlyArray<keyof ClaudeCacheDefaults> = [
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'ENABLE_PROMPT_CACHING_1H',
];

/**
 * Pure. Returns only the keys CodeMie would set, i.e. those empty/unset in `env`. Derived from
 * CLAUDE_LAUNCH_ENV_DEFAULTS, so the resolver and the launcher share one rule.
 */
export function claudeCacheDefaults(env: NodeJS.ProcessEnv): ClaudeCacheDefaults {
  const defaults: ClaudeCacheDefaults = {};
  for (const declared of CLAUDE_LAUNCH_ENV_DEFAULTS) {
    const name = CACHE_DEFAULT_NAMES.find((candidate) => candidate === declared.name);
    if (!name || env[name]) continue;
    const resolved = declared.value(env);
    if (resolved) defaults[name] = resolved.value;
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
  /** False unless the resolved CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is unset, empty or '0'/'false': the request is made, its effect is not verified. */
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

/** Where a variable can come from, as a source row sees it. */
interface VariableSourceInput {
  /** Readable settings layers, highest precedence first. */
  layers: ClaudeSettingsLayer[];
  /** The shell environment, before CodeMie defaults. */
  shell: NodeJS.ProcessEnv;
  /** What CodeMie would set at launch; empty where its defaults are not applied. */
  defaults: Record<string, string | undefined>;
}

export interface PromptCacheVariableSourceRow {
  name: string;
  read(variable: string, input: VariableSourceInput): Resolved | undefined;
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

export interface PromptCachePrecedenceTable {
  /** Where the value of a variable is taken from: the first source that has it wins. */
  variableSources: readonly PromptCacheVariableSourceRow[];
  /** What decides the main prompt-cache TTL: the first matching row wins. */
  ttl: readonly PromptCachePrecedenceRow[];
  /** What decides the subagent override, when there is one: the first matching row wins. */
  subagent: readonly PromptCachePrecedenceRow[];
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

function isFalsy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
}

function ttlOf(value: string): CacheTtl {
  const normalized = value.trim().toLowerCase();
  return normalized === '1h' || normalized === '5m' ? normalized : 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An on/off switch: 1 / true decides `ttl`, 0 / false and an empty value do not decide. Any other
 * value is unknown, because whether Claude Code reads it as on has not been verified.
 */
function switchMatch(name: string, resolved: Resolved | undefined, ttl: CacheTtl): PrecedenceMatch | undefined {
  if (!resolved?.value || isFalsy(resolved.value)) return undefined;
  return { ...resolved, ttl: isTruthy(resolved.value) ? ttl : 'unknown', decidedBy: name };
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
 * Everything about precedence, in one place: where a variable's value comes from, which setting
 * decides the prompt-cache TTL, and which one decides the subagent override. In each list the
 * first row that answers wins.
 *
 * The order is the documented intent of each setting and has not been verified against the Claude
 * Code binary. It lives only here, so a correction is one edit.
 */
export const PROMPT_CACHE_PRECEDENCE: PromptCachePrecedenceTable = {
  variableSources: [
    {
      // An `env` block of a Claude settings file replaces the process value, even with an empty string.
      name: 'settings env',
      read(variable, { layers }) {
        for (const layer of layers) {
          const block = layer.settings?.env;
          if (isPlainObject(block) && block[variable] !== undefined && block[variable] !== null) {
            return { value: String(block[variable]), source: { kind: 'settings', path: layer.path } };
          }
        }
        return undefined;
      },
    },
    {
      // An empty shell value is the same as unset.
      name: 'shell',
      read(variable, { shell }) {
        const value = shell[variable];
        return value ? { value, source: { kind: 'shell' } } : undefined;
      },
    },
    {
      name: 'CodeMie default',
      read(variable, { defaults }) {
        const value = defaults[variable];
        return value ? { value, source: { kind: 'codemie-default' } } : undefined;
      },
    },
  ],
  ttl: [
    {
      name: `${DISABLE_PREFIX}*`,
      match(ctx) {
        const matches = ctx
          .variableNames()
          .filter((name) => name.startsWith(DISABLE_PREFIX))
          .map((name) => switchMatch(name, ctx.variable(name), 'disabled'))
          .filter((match): match is PrecedenceMatch => match !== undefined);
        // A variant that clearly disables wins over one whose value cannot be read either way.
        return matches.find((match) => match.ttl === 'disabled') ?? matches[0];
      },
    },
    {
      name: 'FORCE_PROMPT_CACHING_5M',
      match: (ctx) => switchMatch('FORCE_PROMPT_CACHING_5M', ctx.variable('FORCE_PROMPT_CACHING_5M'), '5m'),
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
    {
      // Reached only when nothing above decided. A settings file that sets a cache variable to an
      // empty string hides the shell value and the CodeMie default, so the outcome is that file's
      // doing: name it instead of reporting the upstream default.
      name: 'blank settings env entry',
      match(ctx) {
        for (const name of ctx.variableNames()) {
          if (name === SUBAGENT_TTL_VARIABLE || name === BETAS_SWITCH) continue;
          const resolved = ctx.variable(name);
          if (resolved?.value === '' && resolved.source.kind === 'settings') {
            return { ...resolved, ttl: 'unknown', decidedBy: name };
          }
        }
        return undefined;
      },
    },
  ],
  subagent: [
    ttlValueRow(SUBAGENT_TTL_VARIABLE, (ctx) => ctx.variable(SUBAGENT_TTL_VARIABLE)),
    ttlValueRow(SUBAGENT_TTL_SETTING, (ctx) => ctx.setting(SUBAGENT_TTL_SETTING)),
  ],
};

function firstMatch(rows: readonly PromptCachePrecedenceRow[], ctx: PrecedenceContext): PrecedenceMatch | undefined {
  for (const row of rows) {
    const match = row.match(ctx);
    if (match) return match;
  }
  return undefined;
}

function buildContext(input: PromptCacheInput, layers: ClaudeSettingsLayer[]): PrecedenceContext {
  // Highest precedence first, so the first hit is the layer Claude Code would use.
  const readable = layers.filter((layer) => layer.state === 'ok' && layer.settings).reverse();
  const sources: VariableSourceInput = {
    layers: readable,
    shell: input.env,
    defaults: input.codemieDefaults ? { ...claudeCacheDefaults(input.env) } : {},
  };

  return {
    variable(name) {
      for (const source of PROMPT_CACHE_PRECEDENCE.variableSources) {
        const resolved = source.read(name, sources);
        if (resolved) return resolved;
      }
      return undefined;
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
  // Confirmed only while the betas switch is clearly off (unset, empty, 0 / false).
  const betas = ctx.variable(BETAS_SWITCH);
  const confirmed = !(betas?.value && !isFalsy(betas.value));

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

  const decision = firstMatch(PROMPT_CACHE_PRECEDENCE.ttl, ctx);
  const subagent = firstMatch(PROMPT_CACHE_PRECEDENCE.subagent, ctx);

  return {
    ...(decision
      ? { ttl: decision.ttl, decidedBy: decision.decidedBy, value: decision.value, source: decision.source }
      : { ttl: '5m', decidedBy: 'upstream default', source: { kind: 'upstream-default' } }),
    confirmed,
    ...(subagent ? { subagent: { ttl: subagent.ttl, decidedBy: subagent.decidedBy, source: subagent.source } } : {}),
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
