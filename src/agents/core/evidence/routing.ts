import { apiIdentity } from './api-identity.js';

/**
 * Routing evidence, separate from launch mode and from the analytics destination.
 * Pure: callers pass process env, the settings.json `env` block, and profile facts.
 */
export interface RoutingInput {
  /** Process env as seen by the agent/hook (CODEMIE_* and ANTHROPIC_BASE_URL). */
  env: Record<string, string | undefined>;
  /** Claude settings.json `env` block; wins over process env (Claude reads it at startup). */
  settingsEnv?: Record<string, string | undefined>;
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

export function routedViaCodemie(input: RoutingInput): RoutingResult {
  const { env } = input;
  const endpoint = input.settingsEnv?.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || undefined;
  const endpointId = identity(endpoint);
  const direct = endpointId === identity(ANTHROPIC_DIRECT);

  if (launchMode(env) === 'managed' && input.codemieProvider) {
    // Proxy ran: endpoint must be the proven local proxy, and the preserved upstream must be the configured model route.
    const proxy = env.CODEMIE_BASE_URL;
    const target = identity(env.CODEMIE_TARGET_API_URL);
    const ok =
      !!endpointId && isLoopback(proxy) && endpointId === identity(proxy) &&
      !!target && target === identity(profileUrl(input));
    return ok ? PROVEN(true) : UNPROVEN;
  }

  if (launchMode(env) === 'native' && input.codemieProvider) {
    // No proxy: the effective endpoint itself must be the configured CodeMie model route.
    const configured = identity(profileUrl(input));
    return endpointId && configured && endpointId === configured ? PROVEN(true) : UNPROVEN;
  }

  // Non-CodeMie provider: positively direct only when the endpoint is explicitly api.anthropic.com.
  // An absent/foreign endpoint may hide a route (other settings layers, gateways) => unproven.
  return direct ? PROVEN(false) : UNPROVEN;
}
