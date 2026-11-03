import { apiIdentity } from './api-identity.js';

/**
 * Routing evidence, separate from launch mode and from the analytics destination.
 * Pure: callers pass process env, the settings.json `env` block, and profile facts.
 */
export interface RoutingInput {
  /** Process env as seen by the agent/hook (CODEMIE_* and ANTHROPIC_BASE_URL). */
  env: Record<string, string | undefined>;
  /** Claude settings.json `env` block; wins over process env (Claude reads it at startup). */
  settingsEnv?: Record<string, unknown>;
  /** True when a settings layer exists but could not be read: the endpoint may be overridden there, so nothing is provable. */
  settingsUnknown?: boolean;
  /**
   * True when the configured provider is CodeMie-routed: the inputs of BaseAgentAdapter.shouldUseProxy
   * (provider authType 'sso', or CODEMIE_AUTH_METHOD 'jwt', and authType != 'none').
   */
  codemieProvider: boolean;
  /** Configured profile model base URL; defaults to CODEMIE_PROFILE_CONFIG.baseUrl. */
  profileBaseUrl?: string;
}

export interface RoutingResult {
  routed: boolean;
  /** 'unproven' => classify never yields Personal; 'proven' => routed value is certain. */
  routing_proof: 'proven' | 'unproven';
}

const PROVEN = (routed: boolean): RoutingResult => ({ routed, routing_proof: 'proven' });
const UNPROVEN: RoutingResult = { routed: false, routing_proof: 'unproven' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ANTHROPIC_DIRECT = 'https://api.anthropic.com';

export function launchMode(env: Record<string, string | undefined>): 'managed' | 'native' {
  return env.CODEMIE_SESSION_ID ? 'managed' : 'native';
}

function identity(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return apiIdentity(url);
  } catch {
    return undefined;
  }
}

function profileUrl(input: RoutingInput): string | undefined {
  if (input.profileBaseUrl) return input.profileBaseUrl;
  try {
    const raw = input.env.CODEMIE_PROFILE_CONFIG;
    const baseUrl = raw ? (JSON.parse(raw) as { baseUrl?: unknown }).baseUrl : undefined;
    return typeof baseUrl === 'string' ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

function isLoopback(url: string | undefined): boolean {
  try {
    return !!url && LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * One rule for the cloud-provider flags, used by both routing functions. Explicit off values are off;
 * the spellings Claude Code accepts as true are on; anything else is unknown, which is never read as off.
 */
const OFF = ['', '0', 'false', 'no', 'off'];
const ON = ['1', 'true', 'yes', 'on'];
function flagState(v: string | undefined): 'off' | 'on' | 'unknown' {
  const t = (v ?? '').trim().toLowerCase();
  return OFF.includes(t) ? 'off' : ON.includes(t) ? 'on' : 'unknown';
}

const ENDPOINT_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * The effective value of each endpoint-selecting variable (settings.json `env` wins over process env, as
 * Claude applies it). Undefined = unknown: a non-scalar settings value, or an empty settings value that
 * would override a non-empty process value, cannot be classified either way.
 */
function effectiveEndpointEnv(
  input: RoutingInput,
  keys: readonly string[] = ENDPOINT_KEYS
): Record<string, string | undefined> | undefined {
  const out: Record<string, string | undefined> = {};
  for (const name of keys) {
    const s = input.settingsEnv?.[name];
    const fromProcess = input.env[name] || undefined;
    if (s === undefined) {
      out[name] = fromProcess;
    } else if (typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean') {
      const v = String(s);
      if (!v && fromProcess) return undefined;
      out[name] = v || undefined;
    } else {
      return undefined;
    }
  }
  return out;
}

/** `candidate` is `base` itself or lies under it at a path-segment boundary (same scheme/host/port). */
function underBase(candidate: string | undefined, base: string | undefined): boolean {
  return !!candidate && !!base && (candidate === base || candidate.startsWith(`${base}/`));
}

const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
/** Conservative: anything but an explicit off value counts as set, so an unfamiliar spelling never reads as OAuth. */
const flagSet = (v: string | undefined): boolean => flagState(v) !== 'off';
/** Credentials that make Claude authenticate with something other than the saved OAuth login. Only presence is read. */
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK',
];

/**
 * True only when the saved Claude OAuth login (`.claude.json` `oauthAccount`) is what the session pays with:
 * the effective env (settings.json over process env) selects no cloud provider, carries no API key / auth
 * token / OAuth token, no `apiKeyHelper` exists, and the endpoint is the first-party default. Anything
 * ambiguous or unreadable is false, so the organization is withheld and the session is Unknown. Values are
 * only tested for presence and never returned.
 */
export function oauthAccountPays(input: RoutingInput & { apiKeyHelper?: boolean }): boolean {
  if (input.settingsUnknown || input.apiKeyHelper) return false;
  const effective = effectiveEndpointEnv(input, [...ENDPOINT_KEYS, ...CLOUD_FLAGS, ...CREDENTIAL_KEYS]);
  if (!effective) return false;
  if (CLOUD_FLAGS.some((name) => flagSet(effective[name])) || CREDENTIAL_KEYS.some((name) => effective[name])) return false;
  const endpoint = effective.ANTHROPIC_BASE_URL;
  return !endpoint || identity(endpoint) === identity(ANTHROPIC_DIRECT);
}

export function routedViaCodemie(input: RoutingInput): RoutingResult {
  const { env } = input;
  const effective = input.settingsUnknown ? undefined : effectiveEndpointEnv(input);
  if (!effective) return UNPROVEN;
  const get = (name: string): string | undefined => effective[name];
  // Claude Code's own resolution (session-env-fields.ts): the Bedrock/Vertex flags select a cloud provider
  // on its default endpoint unless a provider base URL overrides it; otherwise ANTHROPIC_BASE_URL, empty =
  // api.anthropic.com.
  const flags = CLOUD_FLAGS.map((name) => flagState(get(name)));
  // An unfamiliar spelling cannot be resolved to a route either way: nothing is provable.
  if (flags.includes('unknown')) return UNPROVEN;
  const cloud = flagState(get('CLAUDE_CODE_USE_BEDROCK')) === 'on' || flagState(get('CLAUDE_CODE_USE_VERTEX')) === 'on';
  const endpoint = cloud ? get('ANTHROPIC_BEDROCK_BASE_URL') || get('ANTHROPIC_VERTEX_BASE_URL') : get('ANTHROPIC_BASE_URL');
  // Foundry is a cloud provider this module cannot resolve an endpoint for: nothing is provable.
  if (flagState(get('CLAUDE_CODE_USE_FOUNDRY')) === 'on') return UNPROVEN;
  const endpointId = identity(endpoint);
  // Positively direct: the executor's default endpoint or explicit first-party Anthropic. A foreign override is not.
  const direct = !endpoint || (!cloud && endpointId === identity(ANTHROPIC_DIRECT));

  if (launchMode(env) === 'managed' && input.codemieProvider) {
    // Proxy ran: endpoint must be the proven local proxy, and the preserved upstream must be the configured model route.
    const proxy = env.CODEMIE_BASE_URL;
    const target = identity(env.CODEMIE_TARGET_API_URL);
    const ok =
      !!endpointId && isLoopback(proxy) && endpointId === identity(proxy) &&
      !!target && target === identity(profileUrl(input));
    return ok ? PROVEN(true) : UNPROVEN;
  }

  // No proxy ran: the effective endpoint must itself be under the configured CodeMie model route
  // (origin + path-segment prefix); the analytics URL is never proof.
  if (launchMode(env) === 'native' && input.codemieProvider && underBase(endpointId, identity(profileUrl(input)))) {
    return PROVEN(true);
  }
  return direct ? PROVEN(false) : UNPROVEN;
}
