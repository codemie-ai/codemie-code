/**
 * MCP Auth Proxy — config loading + validation.
 *
 * Config file: <codemieDir>/mcp-auth-proxy.json (resolved via getCodemiePath — never
 * hardcode ~/.codemie). Validation errors name the offending key path (spec requirement).
 */
import { readFile } from 'node:fs/promises';
import { getCodemiePath } from '../../utils/paths.js';
import { ConfigurationError } from '../../utils/errors.js';
import type { AuthProxyConfig, RouteConfig } from './types.js';

export const DEFAULT_AUTH_PROXY_PORT = 42800;
export const AUTH_PROXY_CONFIG_FILE = 'mcp-auth-proxy.json';
export const AUTH_PROXY_STATE_FILE = 'mcp-auth-proxy.state.json';

const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// `as` + `.well-known` are reserved by the route map; `healthz` by the health
// endpoint and `shutdown` by the graceful-shutdown control endpoint (design D6 —
// a route named "healthz"/"shutdown" would shadow GET /healthz / POST /shutdown).
const RESERVED_ROUTE_IDS = new Set(['as', '.well-known', 'healthz', 'shutdown']);

export function getDefaultConfigPath(): string {
  return getCodemiePath(AUTH_PROXY_CONFIG_FILE);
}

export function getDefaultStatePath(): string {
  return getCodemiePath(AUTH_PROXY_STATE_FILE);
}

export async function loadAuthProxyConfig(configPath?: string): Promise<AuthProxyConfig> {
  const path = configPath ?? getDefaultConfigPath();

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new ConfigurationError(
      `MCP auth proxy config not found: ${path}\n` +
        `Create it with a "servers" map — see docs/SPEC-mcp-auth-proxy.md § Configuration.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(`${path}: invalid JSON — ${(error as Error).message}`);
  }

  return validateAuthProxyConfig(parsed);
}

export function validateAuthProxyConfig(parsed: unknown): AuthProxyConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError('mcp-auth-proxy config: root must be a JSON object');
  }
  const root = parsed as Record<string, unknown>;

  let port = DEFAULT_AUTH_PROXY_PORT;
  if (root.port !== undefined) {
    if (
      typeof root.port !== 'number' ||
      !Number.isInteger(root.port) ||
      root.port < 1 ||
      root.port > 65535
    ) {
      throw new ConfigurationError(
        'mcp-auth-proxy config: "port" must be an integer between 1 and 65535'
      );
    }
    port = root.port;
  }

  if (typeof root.servers !== 'object' || root.servers === null || Array.isArray(root.servers)) {
    throw new ConfigurationError(
      'mcp-auth-proxy config: "servers" must be an object mapping route ids to server configs'
    );
  }

  const entries = Object.entries(root.servers as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ConfigurationError('mcp-auth-proxy config: "servers" must contain at least one route');
  }

  const servers: Record<string, RouteConfig> = {};
  for (const [id, value] of entries) {
    if (!ROUTE_ID_PATTERN.test(id)) {
      throw new ConfigurationError(
        `mcp-auth-proxy config: servers.${id}: route id must match ^[a-z0-9][a-z0-9-]*$`
      );
    }
    if (RESERVED_ROUTE_IDS.has(id)) {
      throw new ConfigurationError(`mcp-auth-proxy config: servers.${id}: route id is reserved`);
    }
    servers[id] = validateRoute(value, `servers.${id}`);
  }

  return { port, servers };
}

function validateRoute(value: unknown, keyPath: string): RouteConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`mcp-auth-proxy config: ${keyPath}: must be an object`);
  }
  const route = value as Record<string, unknown>;

  if (typeof route.upstreamUrl !== 'string' || route.upstreamUrl.length === 0) {
    throw new ConfigurationError(`mcp-auth-proxy config: ${keyPath}.upstreamUrl: required string`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(route.upstreamUrl);
  } catch {
    throw new ConfigurationError(`mcp-auth-proxy config: ${keyPath}.upstreamUrl: not a valid URL`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new ConfigurationError(`mcp-auth-proxy config: ${keyPath}.upstreamUrl: must use https://`);
  }

  if (
    route.clientName !== undefined &&
    (typeof route.clientName !== 'string' || route.clientName.length === 0)
  ) {
    throw new ConfigurationError(
      `mcp-auth-proxy config: ${keyPath}.clientName: must be a non-empty string`
    );
  }

  if (route.scopes !== undefined) {
    if (
      !Array.isArray(route.scopes) ||
      route.scopes.length === 0 ||
      route.scopes.some((scope) => typeof scope !== 'string' || scope.length === 0)
    ) {
      throw new ConfigurationError(
        `mcp-auth-proxy config: ${keyPath}.scopes: must be a non-empty array of non-empty strings`
      );
    }
  }

  return {
    upstreamUrl: route.upstreamUrl.replace(/\/+$/, ''),
    ...(route.clientName !== undefined ? { clientName: route.clientName as string } : {}),
    ...(route.scopes !== undefined ? { scopes: [...(route.scopes as string[])] } : {}),
  };
}
