# MCP Auth Proxy (`codemie mcp-auth-proxy`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `codemie mcp-auth-proxy` daemon — a loopback-only transparent HTTP proxy that rewrites OAuth `client_name`/`scope`/`resource` between Claude Code and multiple remote MCP servers, per `docs/SPEC-mcp-auth-proxy.md` (authoritative) and `docs/superpowers/specs/2026-07-03-mcp-auth-proxy-design.md` (repo binding, decisions D1–D8).

**Architecture:** New core module `src/mcp/auth-proxy/` (types, config, rewrites, state, upstream-client, metadata-cache, server, runtime) + daemon bin entry + CLI command, following the 5-layer rule (CLI → core → utils). Streaming pass-through uses raw `node:http(s)` + `stream/promises` `pipeline` (design D1 — deliberate, gate-approved deviation from the spec's undici hint). The proxy holds no tokens; per-route OAuth artifacts are fully isolated.

**Tech Stack:** Node 20 ES modules (`.js` import extensions), Commander, chalk, `http-proxy-agent`/`https-proxy-agent` (existing deps), Vitest 4 (co-located `__tests__/`), project utils (`getCodemiePath`, `logger`, `sanitizeLogArgs`, `spawnDetached`, `ConfigurationError`/`ToolExecutionError`).

**Conventions that apply to every task:**
- No `console.log` outside `src/cli/**` (CLI user output uses `console`/chalk like existing commands); module code logs via `logger.debug` + `sanitizeLogArgs`.
- Never log tokens, codes, verifiers, `Authorization` headers, bodies, or `/as/*` query strings — log rewritten field *names* only.
- Explicit return types on exports, no `any`, single quotes.
- Commit scope: `proxy` for module/daemon work, `cli` for CLI/registration, `docs` for docs (allowed scopes are enforced by commitlint).
- No new dependencies; no `package.json` changes.
- Run single test files with `npx vitest run <path>`.

---

### Task 1: Types + config validation

**Test-first: yes — `validateAuthProxyConfig` rejects each invalid shape with the offending key path; fails until `config.ts` exists.**

**Files:**
- Create: `src/mcp/auth-proxy/types.ts`
- Create: `src/mcp/auth-proxy/config.ts`
- Test: `src/mcp/auth-proxy/__tests__/config.test.ts`

- [ ] **Step 1: Write `types.ts`** (types only — needed by the test's imports; contains no logic to test)

```ts
/**
 * MCP Auth Proxy — shared types.
 *
 * See docs/SPEC-mcp-auth-proxy.md (authoritative spec) and
 * docs/superpowers/specs/2026-07-03-mcp-auth-proxy-design.md (design decisions D1–D8).
 */

export type JsonObject = Record<string, unknown>;

export interface RouteConfig {
  /** Canonical upstream MCP endpoint (https:// only; stored without trailing slash). */
  upstreamUrl: string;
  /** DCR client_name override; absent = pass through (R4). */
  clientName?: string;
  /** Scope override applied at every rewrite point (R1–R6); absent = pass through. */
  scopes?: string[];
}

export interface AuthProxyConfig {
  port: number;
  servers: Record<string, RouteConfig>;
}

export interface AuthProxyDaemonState {
  pid: number;
  port: number;
  routes: string[];
  startedAt: string;
}

export type RouteStatus = 'ok' | 'degraded' | 'unknown';

export interface UpstreamMetadata {
  /** Upstream Protected Resource Metadata document (RFC 9728), verbatim. */
  prm: JsonObject;
  /** Upstream Authorization Server metadata document (RFC 8414 / OIDC), verbatim. */
  asMetadata: JsonObject;
  /** Upstream canonical resource URI for RFC 8707 rewrites (no trailing slash). */
  upstreamResource: string;
  registrationEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface RewriteResult<T> {
  value: T;
  /** Names of rewritten fields — safe to log (names only, never values). */
  rewrote: string[];
}

export interface RewriteContext {
  /** e.g. `http://127.0.0.1:42800` (no trailing slash). */
  proxyOrigin: string;
  routeId: string;
  scopes?: string[];
}
```

- [ ] **Step 2: Write the failing test `src/mcp/auth-proxy/__tests__/config.test.ts`**

```ts
/**
 * mcp-auth-proxy config validation tests
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUTH_PROXY_PORT,
  loadAuthProxyConfig,
  validateAuthProxyConfig,
} from '../config.js';
import { ConfigurationError } from '../../../utils/errors.js';

const validServers = { radar: { upstreamUrl: 'https://mcp.example.com/mcp/radar' } };

describe('validateAuthProxyConfig', () => {
  it('accepts a minimal config and applies the default port', () => {
    const config = validateAuthProxyConfig({ servers: validServers });
    expect(config.port).toBe(DEFAULT_AUTH_PROXY_PORT);
    expect(config.servers.radar.upstreamUrl).toBe('https://mcp.example.com/mcp/radar');
  });

  it('accepts a full route config and strips trailing slashes from upstreamUrl', () => {
    const config = validateAuthProxyConfig({
      port: 42801,
      servers: {
        radar: {
          upstreamUrl: 'https://mcp.example.com/mcp/radar/',
          clientName: 'EPAM Approved MCP Client',
          scopes: ['openid', 'mcp:access'],
        },
      },
    });
    expect(config.port).toBe(42801);
    expect(config.servers.radar.upstreamUrl).toBe('https://mcp.example.com/mcp/radar');
    expect(config.servers.radar.clientName).toBe('EPAM Approved MCP Client');
    expect(config.servers.radar.scopes).toEqual(['openid', 'mcp:access']);
  });

  it.each([null, [], 'x', 42])('rejects non-object root: %j', (root) => {
    expect(() => validateAuthProxyConfig(root)).toThrow(ConfigurationError);
  });

  it.each([0, -1, 1.5, 70000, '42800'])('rejects invalid port %j naming "port"', (port) => {
    expect(() => validateAuthProxyConfig({ port, servers: validServers })).toThrow(/"port"/);
  });

  it('rejects missing or empty servers naming "servers"', () => {
    expect(() => validateAuthProxyConfig({})).toThrow(/"servers"/);
    expect(() => validateAuthProxyConfig({ servers: {} })).toThrow(/at least one route/);
  });

  it.each(['Radar', '-radar', 'ra_dar', 'ra.dar'])('rejects invalid route id %j with key path', (id) => {
    expect(() =>
      validateAuthProxyConfig({ servers: { [id]: { upstreamUrl: 'https://x.example' } } })
    ).toThrow(/servers\./);
  });

  it.each(['as', 'healthz'])('rejects reserved route id %j', (id) => {
    expect(() =>
      validateAuthProxyConfig({ servers: { [id]: { upstreamUrl: 'https://x.example' } } })
    ).toThrow(/reserved/);
  });

  it('rejects missing, malformed, and non-https upstreamUrl with key path', () => {
    expect(() => validateAuthProxyConfig({ servers: { radar: {} } })).toThrow(
      /servers\.radar\.upstreamUrl/
    );
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl: 'not a url' } } })
    ).toThrow(/servers\.radar\.upstreamUrl/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl: 'http://mcp.example.com' } } })
    ).toThrow(/servers\.radar\.upstreamUrl.*https/);
  });

  it('rejects empty clientName and invalid scopes with key paths', () => {
    const upstreamUrl = 'https://x.example';
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, clientName: '' } } })
    ).toThrow(/servers\.radar\.clientName/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: [] } } })
    ).toThrow(/servers\.radar\.scopes/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: [''] } } })
    ).toThrow(/servers\.radar\.scopes/);
    expect(() =>
      validateAuthProxyConfig({ servers: { radar: { upstreamUrl, scopes: 'openid' } } })
    ).toThrow(/servers\.radar\.scopes/);
  });
});

describe('loadAuthProxyConfig', () => {
  it('throws ConfigurationError for a missing config file', async () => {
    const missing = join(tmpdir(), `mcp-auth-proxy-missing-${process.pid}.json`);
    await expect(loadAuthProxyConfig(missing)).rejects.toThrow(ConfigurationError);
    await expect(loadAuthProxyConfig(missing)).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts`
Expected: FAIL — `Cannot find module '../config.js'` (or equivalent resolve error).

- [ ] **Step 4: Write `src/mcp/auth-proxy/config.ts`**

```ts
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
// `as` + `.well-known` are reserved by the route map; `healthz` by the health endpoint
// (design D6 — a route named "healthz" would shadow GET /healthz).
const RESERVED_ROUTE_IDS = new Set(['as', '.well-known', 'healthz']);

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
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth-proxy/types.ts src/mcp/auth-proxy/config.ts src/mcp/auth-proxy/__tests__/config.test.ts
git commit -m "feat(proxy): add mcp-auth-proxy types and config validation"
```

---

### Task 2: Pure rewrite rules R1–R6

**Test-first: yes — table-driven tests for all six rewrite functions (challenge rewrite/injection, CIMD deletion, PKCE preservation, resource restoration, conditional scope); fails until `rewrites.ts` exists.**

**Files:**
- Create: `src/mcp/auth-proxy/rewrites.ts`
- Test: `src/mcp/auth-proxy/__tests__/rewrites.test.ts`

- [ ] **Step 1: Write the failing test `src/mcp/auth-proxy/__tests__/rewrites.test.ts`**

```ts
/**
 * mcp-auth-proxy rewrite rules (R1–R6) tests — pure functions, no mocks.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import {
  rewriteAsMetadata,
  rewriteAuthorizeQuery,
  rewriteChallengeHeader,
  rewritePrm,
  rewriteRegistrationBody,
  rewriteTokenBody,
} from '../rewrites.js';
import type { JsonObject } from '../types.js';

const ctx = { proxyOrigin: 'http://127.0.0.1:42800', routeId: 'radar' };
const ctxScoped = { ...ctx, scopes: ['openid', 'mcp:access'] };
const PRM_URL = 'http://127.0.0.1:42800/.well-known/oauth-protected-resource/radar';

describe('rewriteChallengeHeader (R1)', () => {
  it('rewrites resource_metadata and sets scope, preserving other params', () => {
    const header =
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp/radar", error="invalid_token"';
    const { value, rewrote } = rewriteChallengeHeader(header, ctxScoped);
    expect(value).toContain(`resource_metadata="${PRM_URL}"`);
    expect(value).toContain('scope="openid mcp:access"');
    expect(value).toContain('error="invalid_token"');
    expect(rewrote).toEqual(['resource_metadata', 'scope']);
  });

  it('replaces an existing scope param instead of duplicating it', () => {
    const header = 'Bearer resource_metadata="https://x.example/prm", scope="claudeai"';
    const { value } = rewriteChallengeHeader(header, ctxScoped);
    expect(value).toContain('scope="openid mcp:access"');
    expect(value).not.toContain('claudeai');
  });

  it('leaves upstream scope untouched when no scopes are configured', () => {
    const header = 'Bearer resource_metadata="https://x.example/prm", scope="upstream-scope"';
    const { value, rewrote } = rewriteChallengeHeader(header, ctx);
    expect(value).toContain('scope="upstream-scope"');
    expect(rewrote).toEqual(['resource_metadata']);
  });

  it('prepends resource_metadata when the Bearer challenge lacks it', () => {
    const { value } = rewriteChallengeHeader('Bearer error="invalid_token"', ctx);
    expect(value).toBe(`Bearer resource_metadata="${PRM_URL}", error="invalid_token"`);
  });

  it('injects a full challenge when the upstream sent no header at all', () => {
    const { value } = rewriteChallengeHeader(undefined, ctxScoped);
    expect(value).toBe(`Bearer resource_metadata="${PRM_URL}", scope="openid mcp:access"`);
  });

  it('handles a bare "Bearer" header', () => {
    const { value } = rewriteChallengeHeader('Bearer', ctx);
    expect(value).toBe(`Bearer resource_metadata="${PRM_URL}"`);
  });
});

describe('rewritePrm (R2)', () => {
  const prm: JsonObject = {
    resource: 'https://mcp.example.com/mcp/radar',
    authorization_servers: ['https://idp.example.com/realms/x'],
    scopes_supported: ['upstream-scope'],
    bearer_methods_supported: ['header'],
  };

  it('rewrites resource + authorization_servers, passes other fields through', () => {
    const { value, rewrote } = rewritePrm(prm, ctx);
    expect(value.resource).toBe('http://127.0.0.1:42800/radar');
    expect(value.authorization_servers).toEqual(['http://127.0.0.1:42800/as/radar']);
    expect(value.bearer_methods_supported).toEqual(['header']);
    expect(value.scopes_supported).toEqual(['upstream-scope']);
    expect(rewrote).toEqual(['resource', 'authorization_servers']);
  });

  it('overrides scopes_supported only when scopes are configured', () => {
    const { value, rewrote } = rewritePrm(prm, ctxScoped);
    expect(value.scopes_supported).toEqual(['openid', 'mcp:access']);
    expect(rewrote).toContain('scopes_supported');
  });
});

describe('rewriteAsMetadata (R3)', () => {
  const asMeta: JsonObject = {
    issuer: 'https://idp.example.com/realms/x',
    authorization_endpoint: 'https://idp.example.com/realms/x/authorize',
    token_endpoint: 'https://idp.example.com/realms/x/token',
    registration_endpoint: 'https://idp.example.com/realms/x/register',
    revocation_endpoint: 'https://idp.example.com/realms/x/revoke',
    jwks_uri: 'https://idp.example.com/realms/x/jwks',
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
  };

  it('maps issuer + endpoints to the proxy, keeps jwks_uri upstream, preserves PKCE, deletes CIMD flag', () => {
    const { value, rewrote } = rewriteAsMetadata(asMeta, { ...ctx, upstreamHasRevocation: true });
    expect(value.issuer).toBe('http://127.0.0.1:42800/as/radar');
    expect(value.authorization_endpoint).toBe('http://127.0.0.1:42800/as/radar/authorize');
    expect(value.token_endpoint).toBe('http://127.0.0.1:42800/as/radar/token');
    expect(value.registration_endpoint).toBe('http://127.0.0.1:42800/as/radar/register');
    expect(value.revocation_endpoint).toBe('http://127.0.0.1:42800/as/radar/revoke');
    expect(value.jwks_uri).toBe('https://idp.example.com/realms/x/jwks');
    expect(value.code_challenge_methods_supported).toEqual(['S256']);
    expect(value).not.toHaveProperty('client_id_metadata_document_supported');
    expect(rewrote).toContain('client_id_metadata_document_supported');
  });

  it('drops revocation_endpoint when the upstream advertises none', () => {
    const { value } = rewriteAsMetadata(asMeta, { ...ctx, upstreamHasRevocation: false });
    expect(value).not.toHaveProperty('revocation_endpoint');
  });

  it('overrides scopes_supported only when configured', () => {
    const { value } = rewriteAsMetadata(
      { ...asMeta, scopes_supported: ['upstream-scope'] },
      { ...ctxScoped, upstreamHasRevocation: false }
    );
    expect(value.scopes_supported).toEqual(['openid', 'mcp:access']);
  });
});

describe('rewriteRegistrationBody (R4)', () => {
  it('overrides client_name and injects scope, preserving redirect_uris and grant_types', () => {
    const body: JsonObject = {
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:12345/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    };
    const { value, rewrote } = rewriteRegistrationBody(body, {
      clientName: 'EPAM Approved MCP Client',
      scopes: ['openid'],
    });
    expect(value.client_name).toBe('EPAM Approved MCP Client');
    expect(value.scope).toBe('openid');
    expect(value.redirect_uris).toEqual(['http://localhost:12345/callback']);
    expect(value.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(value.token_endpoint_auth_method).toBe('none');
    expect(rewrote).toEqual(['client_name', 'scope']);
  });

  it('passes everything through untouched when nothing is configured', () => {
    const body: JsonObject = { client_name: 'Claude Code', scope: 'claudeai' };
    const { value, rewrote } = rewriteRegistrationBody(body, {});
    expect(value).toEqual(body);
    expect(rewrote).toEqual([]);
  });
});

describe('rewriteAuthorizeQuery (R5)', () => {
  it('sets resource to the upstream canonical URI and overrides scope, keeping PKCE/state', () => {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'abc',
      redirect_uri: 'http://localhost:1/cb',
      state: 's1',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      scope: 'claudeai',
      resource: 'http://127.0.0.1:42800/radar',
    });
    const { value, rewrote } = rewriteAuthorizeQuery(query, {
      scopes: ['openid'],
      upstreamResource: 'https://mcp.example.com/mcp/radar',
    });
    expect(value.get('resource')).toBe('https://mcp.example.com/mcp/radar');
    expect(value.get('scope')).toBe('openid');
    expect(value.get('code_challenge')).toBe('cc');
    expect(value.get('code_challenge_method')).toBe('S256');
    expect(value.get('state')).toBe('s1');
    expect(value.get('client_id')).toBe('abc');
    expect(rewrote).toEqual(['resource', 'scope']);
  });

  it('leaves scope alone when not configured and injects resource when absent', () => {
    const query = new URLSearchParams({ scope: 'claudeai' });
    const { value, rewrote } = rewriteAuthorizeQuery(query, {
      upstreamResource: 'https://mcp.example.com/mcp/radar',
    });
    expect(value.get('scope')).toBe('claudeai');
    expect(value.get('resource')).toBe('https://mcp.example.com/mcp/radar');
    expect(rewrote).toEqual(['resource']);
  });
});

describe('rewriteTokenBody (R6)', () => {
  it('rewrites resource and existing scope for authorization_code grants', () => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      client_id: 'abc',
      redirect_uri: 'http://localhost:1/cb',
      resource: 'http://127.0.0.1:42800/radar',
      scope: 'claudeai',
    });
    const { value, rewrote } = rewriteTokenBody(form, {
      scopes: ['openid'],
      upstreamResource: 'https://mcp.example.com/mcp/radar',
    });
    expect(value.get('resource')).toBe('https://mcp.example.com/mcp/radar');
    expect(value.get('scope')).toBe('openid');
    expect(value.get('code')).toBe('c');
    expect(value.get('code_verifier')).toBe('v');
    expect(rewrote).toEqual(['resource', 'scope']);
  });

  it('does not inject scope into a refresh_token grant that has none', () => {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r' });
    const { value, rewrote } = rewriteTokenBody(form, {
      scopes: ['openid'],
      upstreamResource: 'https://mcp.example.com/mcp/radar',
    });
    expect(value.has('scope')).toBe(false);
    expect(value.get('refresh_token')).toBe('r');
    expect(rewrote).toEqual(['resource']);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/rewrites.test.ts`
Expected: FAIL — `Cannot find module '../rewrites.js'`.

- [ ] **Step 3: Write `src/mcp/auth-proxy/rewrites.ts`**

```ts
/**
 * MCP Auth Proxy — pure rewrite rules R1–R6 (docs/SPEC-mcp-auth-proxy.md § Rewrite Rules).
 *
 * No I/O: every function maps (upstream artifact, context) → rewritten artifact plus the
 * NAMES of rewritten fields (names only — values are never logged).
 */
import type { JsonObject, RewriteContext, RewriteResult } from './types.js';

function proxyPrmUrl(ctx: RewriteContext): string {
  return `${ctx.proxyOrigin}/.well-known/oauth-protected-resource/${ctx.routeId}`;
}

function proxyIssuer(ctx: RewriteContext): string {
  return `${ctx.proxyOrigin}/as/${ctx.routeId}`;
}

/**
 * R1 — WWW-Authenticate challenge on 401 / 403(insufficient_scope): point
 * resource_metadata at the proxy PRM and (if configured) set the authoritative scope.
 * Injects a full challenge when the upstream sent none, so discovery always lands on
 * the proxy. All other challenge params pass through.
 */
export function rewriteChallengeHeader(
  header: string | undefined,
  ctx: RewriteContext
): RewriteResult<string> {
  const rewrote: string[] = ['resource_metadata'];
  const scopeValue = ctx.scopes?.join(' ');
  const prmParam = `resource_metadata="${proxyPrmUrl(ctx)}"`;

  const bearerMatch = header === undefined ? null : /^\s*Bearer\b\s*(.*)$/i.exec(header);
  if (!bearerMatch) {
    const params = [prmParam];
    if (scopeValue !== undefined) {
      params.push(`scope="${scopeValue}"`);
      rewrote.push('scope');
    }
    return { value: `Bearer ${params.join(', ')}`, rewrote };
  }

  let params = bearerMatch[1].trim();
  if (/resource_metadata\s*=\s*"[^"]*"/i.test(params)) {
    params = params.replace(/resource_metadata\s*=\s*"[^"]*"/i, prmParam);
  } else {
    params = params.length > 0 ? `${prmParam}, ${params}` : prmParam;
  }

  if (scopeValue !== undefined) {
    if (/scope\s*=\s*"[^"]*"/i.test(params)) {
      params = params.replace(/scope\s*=\s*"[^"]*"/i, `scope="${scopeValue}"`);
    } else {
      params = `${params}, scope="${scopeValue}"`;
    }
    rewrote.push('scope');
  }

  return { value: `Bearer ${params}`, rewrote };
}

/**
 * R2 — Protected Resource Metadata: resource → proxy MCP URL (no trailing slash),
 * authorization_servers → proxy AS issuer, scopes_supported → configured scopes (only
 * when configured). All other fields pass through.
 */
export function rewritePrm(prm: JsonObject, ctx: RewriteContext): RewriteResult<JsonObject> {
  const rewrote = ['resource', 'authorization_servers'];
  const value: JsonObject = {
    ...prm,
    resource: `${ctx.proxyOrigin}/${ctx.routeId}`,
    authorization_servers: [proxyIssuer(ctx)],
  };
  if (ctx.scopes !== undefined) {
    value.scopes_supported = [...ctx.scopes];
    rewrote.push('scopes_supported');
  }
  return { value, rewrote };
}

/**
 * R3 — AS metadata: issuer/authorize/token/register (and revoke, when the upstream has
 * one) → proxy endpoints; client_id_metadata_document_supported deleted (forces the DCR
 * path — spec fact 3); code_challenge_methods_supported and every other field (jwks_uri,
 * grant types, auth methods, …) pass through with their real upstream values.
 */
export function rewriteAsMetadata(
  asMetadata: JsonObject,
  ctx: RewriteContext & { upstreamHasRevocation: boolean }
): RewriteResult<JsonObject> {
  const issuer = proxyIssuer(ctx);
  const rewrote = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'];
  const value: JsonObject = {
    ...asMetadata,
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
  };
  if (ctx.upstreamHasRevocation) {
    value.revocation_endpoint = `${issuer}/revoke`;
    rewrote.push('revocation_endpoint');
  } else {
    delete value.revocation_endpoint;
  }
  if ('client_id_metadata_document_supported' in value) {
    delete value.client_id_metadata_document_supported;
    rewrote.push('client_id_metadata_document_supported');
  }
  if (ctx.scopes !== undefined) {
    value.scopes_supported = [...ctx.scopes];
    rewrote.push('scopes_supported');
  }
  return { value, rewrote };
}

/**
 * R4 — Dynamic Client Registration body: client_name / scope overrides (scope injected
 * when absent). Everything else — redirect_uris, grant_types, response_types,
 * token_endpoint_auth_method, … — passes through untouched.
 */
export function rewriteRegistrationBody(
  body: JsonObject,
  ctx: { clientName?: string; scopes?: string[] }
): RewriteResult<JsonObject> {
  const rewrote: string[] = [];
  const value: JsonObject = { ...body };
  if (ctx.clientName !== undefined) {
    value.client_name = ctx.clientName;
    rewrote.push('client_name');
  }
  if (ctx.scopes !== undefined) {
    value.scope = ctx.scopes.join(' ');
    rewrote.push('scope');
  }
  return { value, rewrote };
}

/**
 * R5 — authorization redirect query: resource → upstream canonical URI (RFC 8707;
 * set even when absent so issued tokens are audience-bound upstream), scope override
 * only when configured. client_id, redirect_uri, state, PKCE params, and unknown
 * params pass through untouched.
 */
export function rewriteAuthorizeQuery(
  query: URLSearchParams,
  ctx: { scopes?: string[]; upstreamResource: string }
): RewriteResult<URLSearchParams> {
  const rewrote = ['resource'];
  const value = new URLSearchParams(query);
  value.set('resource', ctx.upstreamResource);
  if (ctx.scopes !== undefined) {
    value.set('scope', ctx.scopes.join(' '));
    rewrote.push('scope');
  }
  return { value, rewrote };
}

/**
 * R6 — token exchange form body (all grant types): resource → upstream canonical URI;
 * scope rewritten only when the field is present AND scopes are configured. code,
 * code_verifier, client_id, redirect_uri, refresh_token pass through untouched.
 */
export function rewriteTokenBody(
  form: URLSearchParams,
  ctx: { scopes?: string[]; upstreamResource: string }
): RewriteResult<URLSearchParams> {
  const rewrote = ['resource'];
  const value = new URLSearchParams(form);
  value.set('resource', ctx.upstreamResource);
  if (ctx.scopes !== undefined && value.has('scope')) {
    value.set('scope', ctx.scopes.join(' '));
    rewrote.push('scope');
  }
  return { value, rewrote };
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/rewrites.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/rewrites.ts src/mcp/auth-proxy/__tests__/rewrites.test.ts
git commit -m "feat(proxy): add pure OAuth rewrite rules R1-R6 for mcp-auth-proxy"
```

---

### Task 3: Daemon state file helpers

**Test-first: yes — atomic round-trip, malformed-file null, clear idempotency, pid liveness; fails until `state.ts` exists.**

**Files:**
- Create: `src/mcp/auth-proxy/state.ts`
- Test: `src/mcp/auth-proxy/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test `src/mcp/auth-proxy/__tests__/state.test.ts`**

Note: all helpers take an explicit `stateFile` path (defaulting to the codemie-home path at
call time), so tests pass tmp paths directly — no `vi.mock` of paths needed.

```ts
/**
 * mcp-auth-proxy daemon state file tests
 * @group unit
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import {
  clearAuthProxyState,
  isProcessAlive,
  readAuthProxyState,
  writeAuthProxyState,
} from '../state.js';
import type { AuthProxyDaemonState } from '../types.js';

const stateFile = join(tmpdir(), `mcp-auth-proxy-state-test-${process.pid}-${Date.now()}.json`);
const state: AuthProxyDaemonState = {
  pid: process.pid,
  port: 42800,
  routes: ['radar', 'other'],
  startedAt: '2026-07-03T00:00:00Z',
};

afterEach(async () => {
  try {
    await unlink(stateFile);
  } catch {
    // already gone
  }
});

describe('auth proxy state file', () => {
  it('round-trips state atomically (no .tmp file left behind)', async () => {
    await writeAuthProxyState(state, stateFile);
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
    expect(await readAuthProxyState(stateFile)).toEqual(state);
  });

  it('returns null for a missing, malformed, or wrong-shaped state file', async () => {
    expect(await readAuthProxyState(stateFile)).toBeNull();
    await writeFile(stateFile, 'not-json', 'utf-8');
    expect(await readAuthProxyState(stateFile)).toBeNull();
    await writeFile(stateFile, '{"pid":"x"}', 'utf-8');
    expect(await readAuthProxyState(stateFile)).toBeNull();
  });

  it('clearAuthProxyState removes the file and tolerates absence', async () => {
    await writeAuthProxyState(state, stateFile);
    await clearAuthProxyState(stateFile);
    expect(existsSync(stateFile)).toBe(false);
    await expect(clearAuthProxyState(stateFile)).resolves.toBeUndefined();
  });

  it('isProcessAlive: true for this process, false for a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/state.test.ts`
Expected: FAIL — `Cannot find module '../state.js'`.

- [ ] **Step 3: Write `src/mcp/auth-proxy/state.ts`**

Pattern-mirror of `src/cli/commands/proxy/daemon-manager.ts` (atomic tmp+rename writes,
defensive reads, signal-0 liveness) for the auth-proxy state schema. Default paths are
resolved per call so `CODEMIE_HOME` is honored at call time.

```ts
/**
 * MCP Auth Proxy — daemon state file helpers.
 *
 * Atomic tmp+rename writes and defensive reads, mirroring the SSO proxy's
 * daemon-manager pattern for the auth-proxy state schema {pid, port, routes, startedAt}.
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { getDefaultStatePath } from './config.js';
import type { AuthProxyDaemonState } from './types.js';

export async function readAuthProxyState(
  stateFile: string = getDefaultStatePath()
): Promise<AuthProxyDaemonState | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as AuthProxyDaemonState;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeAuthProxyState(
  state: AuthProxyDaemonState,
  stateFile: string = getDefaultStatePath()
): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, stateFile);
}

export async function clearAuthProxyState(
  stateFile: string = getDefaultStatePath()
): Promise<void> {
  try {
    await unlink(stateFile);
  } catch {
    // Already gone — no-op
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/state.ts src/mcp/auth-proxy/__tests__/state.test.ts
git commit -m "feat(proxy): add mcp-auth-proxy daemon state file helpers"
```

---

### Task 4: Upstream HTTP client

**Test-first: no — thin I/O wrapper mirroring the proven `proxy-http-client.ts` template; its forwarding, streaming, and fetchJson behavior is exercised end-to-end by Task 6's server tests against a real local upstream.**

**Files:**
- Create: `src/mcp/auth-proxy/upstream-client.ts`

- [ ] **Step 1: Write `src/mcp/auth-proxy/upstream-client.ts`**

Differences from the SSO template, on purpose: TLS verification stays ON
(`rejectUnauthorized` defaults to `true` — this client relays OAuth traffic; corporate
CAs go through `NODE_EXTRA_CA_CERTS`), and `begin()` exposes the `ClientRequest` so the
server can propagate client aborts (spec R1).

```ts
/**
 * MCP Auth Proxy — outbound HTTP client.
 *
 * Streaming forward for the MCP pass-through (no buffering, abort propagation) plus a
 * small buffered fetchJson for OAuth metadata discovery. Honors HTTP(S)_PROXY env like
 * the SSO proxy's outbound client. TLS verification is intentionally ON: this client
 * relays OAuth traffic to the enterprise IdP.
 */
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { logger } from '../../utils/logger.js';
import type { JsonObject } from './types.js';

const FETCH_JSON_TIMEOUT_MS = 5000;
const FETCH_JSON_MAX_BYTES = 256 * 1024;

function getProxyEnvUrl(protocol: string): string | undefined {
  if (protocol === 'https:') {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
    );
  }
  return process.env.HTTP_PROXY || process.env.http_proxy;
}

export interface BeginOptions {
  method: string;
  headers: http.OutgoingHttpHeaders;
  /** Streaming request body (MCP pass-through). Mutually exclusive with `body`. */
  bodyStream?: Readable;
  /** Buffered request body (rewritten OAuth payloads). */
  body?: Buffer;
}

export interface UpstreamExchange {
  request: http.ClientRequest;
  response: Promise<http.IncomingMessage>;
}

export class UpstreamClient {
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;

  constructor() {
    const agentOptions = { keepAlive: true, maxSockets: 50 };
    const httpsProxyUrl = getProxyEnvUrl('https:');
    const httpProxyUrl = getProxyEnvUrl('http:');
    this.httpsAgent = httpsProxyUrl
      ? new HttpsProxyAgent(httpsProxyUrl, agentOptions)
      : new https.Agent(agentOptions);
    this.httpAgent = httpProxyUrl
      ? new HttpProxyAgent(httpProxyUrl, agentOptions)
      : new http.Agent(agentOptions);
    if (httpsProxyUrl || httpProxyUrl) {
      logger.debug('[mcp-auth-proxy] Using corporate proxy from environment for upstream calls');
    }
  }

  /**
   * Open an upstream request. `response` rejects on network errors; callers destroy
   * `request` to propagate client aborts. Timeout 0 — MCP SSE streams are long-lived.
   */
  begin(url: URL, options: BeginOptions): UpstreamExchange {
    const isHttps = url.protocol === 'https:';
    const protocol = isHttps ? https : http;
    const agent = isHttps ? this.httpsAgent : this.httpAgent;

    let request!: http.ClientRequest;
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      request = protocol.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: options.method,
          headers: options.headers,
          agent,
          timeout: 0,
        },
        resolve
      );
      request.on('error', reject);
    });

    if (options.bodyStream) {
      pipeline(options.bodyStream, request).catch((error: unknown) => {
        request.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    } else if (options.body !== undefined) {
      request.end(options.body);
    } else {
      request.end();
    }

    return { request, response };
  }

  /** Buffered GET returning parsed JSON. Non-2xx, oversized, or non-object → throws. */
  async fetchJson(url: string): Promise<JsonObject> {
    const target = new URL(url);
    const { request, response } = this.begin(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const timer = setTimeout(
      () => request.destroy(new Error(`Timed out fetching metadata from ${target.host}`)),
      FETCH_JSON_TIMEOUT_MS
    );
    try {
      const res = await response;
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`GET ${target.host}${target.pathname} returned ${status}`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res) {
        const buf = Buffer.from(chunk as Buffer);
        size += buf.length;
        if (size > FETCH_JSON_MAX_BYTES) {
          res.destroy();
          throw new Error(`Metadata document from ${target.host} exceeds ${FETCH_JSON_MAX_BYTES} bytes`);
        }
        chunks.push(buf);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Metadata document from ${target.host} is not a JSON object`);
      }
      return parsed as JsonObject;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/auth-proxy/upstream-client.ts
git commit -m "feat(proxy): add streaming upstream HTTP client for mcp-auth-proxy"
```

---

### Task 5: Metadata discovery + TTL cache

**Test-first: yes — discovery priority order, 401-hint preference, positive TTL, 10 s negative cache with per-route isolation, multi-AS warning, missing registration_endpoint failure; fails until `metadata-cache.ts` exists.**

**Files:**
- Create: `src/mcp/auth-proxy/metadata-cache.ts`
- Test: `src/mcp/auth-proxy/__tests__/metadata-cache.test.ts`

- [ ] **Step 1: Write the failing test `src/mcp/auth-proxy/__tests__/metadata-cache.test.ts`**

```ts
/**
 * mcp-auth-proxy metadata discovery + cache tests (fetchJson injected — no network).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  METADATA_TTL_MS,
  NEGATIVE_TTL_MS,
  MetadataCache,
  MetadataDiscoveryError,
} from '../metadata-cache.js';
import { logger } from '../../../utils/logger.js';
import type { JsonObject, RouteConfig } from '../types.js';

const route: RouteConfig = { upstreamUrl: 'https://mcp.example.com/mcp/radar' };

const PRM: JsonObject = {
  resource: 'https://mcp.example.com/mcp/radar/',
  authorization_servers: ['https://idp.example.com/realms/x'],
};
const AS: JsonObject = {
  issuer: 'https://idp.example.com/realms/x',
  authorization_endpoint: 'https://idp.example.com/a',
  token_endpoint: 'https://idp.example.com/t',
  registration_endpoint: 'https://idp.example.com/r',
};

const PRM_PATH_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp/radar';
const AS_8414_URL = 'https://idp.example.com/.well-known/oauth-authorization-server/realms/x';

function fakeFetcher(docs: Record<string, JsonObject>): {
  calls: string[];
  fetchJson: (url: string) => Promise<JsonObject>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetchJson: (url: string): Promise<JsonObject> => {
      calls.push(url);
      const doc = docs[url];
      return doc !== undefined ? Promise.resolve(doc) : Promise.reject(new Error(`404 ${url}`));
    },
  };
}

const HAPPY_DOCS: Record<string, JsonObject> = {
  [PRM_PATH_URL]: PRM,
  [AS_8414_URL]: AS,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MetadataCache', () => {
  it('discovers PRM path-variant first and AS metadata in the spec priority order', async () => {
    const { calls, fetchJson } = fakeFetcher(HAPPY_DOCS);
    const cache = new MetadataCache(fetchJson);
    const meta = await cache.getMetadata('radar', route);
    expect(calls[0]).toBe(PRM_PATH_URL);
    expect(calls[1]).toBe(AS_8414_URL);
    expect(meta.upstreamResource).toBe('https://mcp.example.com/mcp/radar');
    expect(meta.registrationEndpoint).toBe('https://idp.example.com/r');
    expect(meta.authorizationEndpoint).toBe('https://idp.example.com/a');
    expect(meta.tokenEndpoint).toBe('https://idp.example.com/t');
    expect(meta.revocationEndpoint).toBeUndefined();
    expect(cache.getStatus('radar')).toBe('ok');
  });

  it('falls back to the root PRM variant and the OIDC path-appending AS variant', async () => {
    const docs: Record<string, JsonObject> = {
      'https://mcp.example.com/.well-known/oauth-protected-resource': PRM,
      'https://idp.example.com/realms/x/.well-known/openid-configuration': AS,
    };
    const { calls, fetchJson } = fakeFetcher(docs);
    const cache = new MetadataCache(fetchJson);
    await cache.getMetadata('radar', route);
    expect(calls).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
    const insertion = calls.indexOf(AS_8414_URL);
    const oidcInsertion = calls.indexOf(
      'https://idp.example.com/.well-known/openid-configuration/realms/x'
    );
    const appending = calls.indexOf(
      'https://idp.example.com/realms/x/.well-known/openid-configuration'
    );
    expect(insertion).toBeGreaterThanOrEqual(0);
    expect(insertion).toBeLessThan(oidcInsertion);
    expect(oidcInsertion).toBeLessThan(appending);
  });

  it('prefers a PRM URL captured from a live 401 challenge', async () => {
    const hinted = 'https://mcp.example.com/custom/prm-location';
    const { calls, fetchJson } = fakeFetcher({ ...HAPPY_DOCS, [hinted]: PRM });
    const cache = new MetadataCache(fetchJson);
    cache.notePrmUrl('radar', hinted);
    await cache.getMetadata('radar', route);
    expect(calls[0]).toBe(hinted);
  });

  it('caches positive results for the TTL and refreshes after expiry', async () => {
    const { calls, fetchJson } = fakeFetcher(HAPPY_DOCS);
    const cache = new MetadataCache(fetchJson);
    await cache.getMetadata('radar', route);
    await cache.getMetadata('radar', route);
    expect(calls.length).toBe(2);
    vi.advanceTimersByTime(METADATA_TTL_MS + 1);
    await cache.getMetadata('radar', route);
    expect(calls.length).toBe(4);
  });

  it('negative-caches failures for 10 s, retries after, and keeps failures per-route', async () => {
    const { calls, fetchJson } = fakeFetcher({});
    const cache = new MetadataCache(fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(cache.getStatus('radar')).toBe('degraded');
    const callsAfterFirst = calls.length;
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(calls.length).toBe(callsAfterFirst);
    expect(cache.getStatus('other')).toBe('unknown');
    vi.advanceTimersByTime(NEGATIVE_TTL_MS + 1);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('warns and uses the first AS when the upstream PRM lists several', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const docs: Record<string, JsonObject> = {
      [PRM_PATH_URL]: {
        ...PRM,
        authorization_servers: ['https://idp.example.com/realms/x', 'https://other.example'],
      },
      [AS_8414_URL]: AS,
    };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    const meta = await cache.getMetadata('radar', route);
    expect(meta.tokenEndpoint).toBe('https://idp.example.com/t');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('fails when the AS advertises no registration_endpoint (DCR is mandatory)', async () => {
    const asWithoutRegistration: JsonObject = { ...AS };
    delete asWithoutRegistration.registration_endpoint;
    const docs: Record<string, JsonObject> = { [PRM_PATH_URL]: PRM, [AS_8414_URL]: asWithoutRegistration };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(/registration_endpoint/);
  });

  it('fails when the PRM has no authorization_servers', async () => {
    const docs: Record<string, JsonObject> = { [PRM_PATH_URL]: { resource: 'x' } };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(/authorization_servers/);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/metadata-cache.test.ts`
Expected: FAIL — `Cannot find module '../metadata-cache.js'`.

- [ ] **Step 3: Write `src/mcp/auth-proxy/metadata-cache.ts`**

```ts
/**
 * MCP Auth Proxy — per-route upstream OAuth metadata discovery + TTL cache.
 *
 * Discovery chain per the MCP Authorization spec (rev 2025-11-25): upstream PRM
 * (path-aware well-known, then root, plus any resource_metadata URL captured from a live
 * upstream 401), then AS metadata from the PRM's first authorization server, trying the
 * spec's well-known variants in priority order (RFC 8414 path-insertion → OIDC
 * path-insertion → OIDC path-appending). Positive TTL 300 s; failures negative-cached
 * 10 s so a degraded route retries quickly without hammering the upstream. Route
 * failures are fully isolated — one degraded route never affects another.
 */
import { CodeMieError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { JsonObject, RouteConfig, RouteStatus, UpstreamMetadata } from './types.js';

export const METADATA_TTL_MS = 300_000;
export const NEGATIVE_TTL_MS = 10_000;

export class MetadataDiscoveryError extends CodeMieError {
  constructor(routeId: string, reason: string) {
    super(`Metadata discovery failed for route "${routeId}": ${reason}`);
    this.name = 'MetadataDiscoveryError';
  }
}

export type FetchJson = (url: string) => Promise<JsonObject>;

interface CacheEntry {
  metadata: UpstreamMetadata;
  expiresAt: number;
}

interface FailureEntry {
  reason: string;
  expiresAt: number;
}

export class MetadataCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly prmUrlHints = new Map<string, string>();

  constructor(private readonly fetchJson: FetchJson) {}

  /** R2: remember a resource_metadata URL observed on a live upstream 401. */
  notePrmUrl(routeId: string, url: string): void {
    try {
      new URL(url);
      this.prmUrlHints.set(routeId, url);
    } catch {
      // Malformed hint — ignore.
    }
  }

  getStatus(routeId: string): RouteStatus {
    if (this.entries.has(routeId)) {
      return 'ok';
    }
    const failure = this.failures.get(routeId);
    if (failure !== undefined && failure.expiresAt > Date.now()) {
      return 'degraded';
    }
    return 'unknown';
  }

  async getMetadata(routeId: string, route: RouteConfig): Promise<UpstreamMetadata> {
    const cached = this.entries.get(routeId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }
    if (cached !== undefined) {
      this.entries.delete(routeId);
    }

    const failure = this.failures.get(routeId);
    if (failure !== undefined && failure.expiresAt > Date.now()) {
      throw new MetadataDiscoveryError(routeId, failure.reason);
    }

    try {
      const metadata = await this.discover(routeId, route);
      this.entries.set(routeId, { metadata, expiresAt: Date.now() + METADATA_TTL_MS });
      this.failures.delete(routeId);
      return metadata;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.failures.set(routeId, { reason, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      throw error instanceof MetadataDiscoveryError
        ? error
        : new MetadataDiscoveryError(routeId, reason);
    }
  }

  private async discover(routeId: string, route: RouteConfig): Promise<UpstreamMetadata> {
    const upstream = new URL(route.upstreamUrl);
    const upstreamPath = upstream.pathname.replace(/\/+$/, '');

    const prmCandidates: string[] = [];
    const hint = this.prmUrlHints.get(routeId);
    if (hint !== undefined) {
      prmCandidates.push(hint);
    }
    if (upstreamPath !== '' && upstreamPath !== '/') {
      prmCandidates.push(`${upstream.origin}/.well-known/oauth-protected-resource${upstreamPath}`);
    }
    prmCandidates.push(`${upstream.origin}/.well-known/oauth-protected-resource`);

    const prm = await this.firstJson(prmCandidates, routeId, 'protected resource metadata');

    const authServers = prm.authorization_servers;
    if (!Array.isArray(authServers) || authServers.length === 0 || typeof authServers[0] !== 'string') {
      throw new MetadataDiscoveryError(routeId, 'upstream PRM has no authorization_servers');
    }
    if (authServers.length > 1) {
      logger.warn(
        `[mcp-auth-proxy] Route "${routeId}": upstream lists ${authServers.length} authorization servers; using the first (v1 limitation)`
      );
    }

    const issuer = new URL(authServers[0]);
    const issuerPath = issuer.pathname.replace(/\/+$/, '');
    const asCandidates =
      issuerPath !== '' && issuerPath !== '/'
        ? [
            `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
            `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
            `${issuer.origin}${issuerPath}/.well-known/openid-configuration`,
          ]
        : [
            `${issuer.origin}/.well-known/oauth-authorization-server`,
            `${issuer.origin}/.well-known/openid-configuration`,
          ];

    const asMetadata = await this.firstJson(asCandidates, routeId, 'authorization server metadata');

    const registrationEndpoint = asMetadata.registration_endpoint;
    if (typeof registrationEndpoint !== 'string' || registrationEndpoint.length === 0) {
      throw new MetadataDiscoveryError(
        routeId,
        'upstream AS advertises no registration_endpoint — DCR is mandatory for this proxy'
      );
    }
    const authorizationEndpoint = asMetadata.authorization_endpoint;
    const tokenEndpoint = asMetadata.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new MetadataDiscoveryError(
        routeId,
        'upstream AS metadata lacks authorization_endpoint/token_endpoint'
      );
    }

    const upstreamResource =
      typeof prm.resource === 'string' && prm.resource.length > 0
        ? prm.resource.replace(/\/+$/, '')
        : route.upstreamUrl.replace(/\/+$/, '');

    return {
      prm,
      asMetadata,
      upstreamResource,
      registrationEndpoint,
      authorizationEndpoint,
      tokenEndpoint,
      ...(typeof asMetadata.revocation_endpoint === 'string'
        ? { revocationEndpoint: asMetadata.revocation_endpoint }
        : {}),
    };
  }

  private async firstJson(candidates: string[], routeId: string, what: string): Promise<JsonObject> {
    let lastError = 'no candidate URLs';
    for (const candidate of candidates) {
      try {
        return await this.fetchJson(candidate);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new MetadataDiscoveryError(routeId, `could not fetch ${what}: ${lastError}`);
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/metadata-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/metadata-cache.ts src/mcp/auth-proxy/__tests__/metadata-cache.test.ts
git commit -m "feat(proxy): add upstream OAuth metadata discovery and TTL cache"
```

---

### Task 6: Proxy server (route dispatch + streaming pass-through + OAuth endpoints)

**Test-first: yes — integration-style tests against a real local fake upstream (`node:http`): pass-through with auth, 401 challenge rewrite + injection, PRM/AS metadata rewrites on all three well-known variants, DCR/authorize/token rewrites observed at the upstream, SSE streaming, multi-route isolation with one dead upstream, 64 KB limit, healthz, root-PRM alias, unknown route; fails until `server.ts` exists.**

**Files:**
- Create: `src/mcp/auth-proxy/server.ts`
- Test: `src/mcp/auth-proxy/__tests__/server.test.ts`

Notes for this task:
- Tests build `AuthProxyConfig` object literals directly (bypassing `validateAuthProxyConfig`) so the fake upstream can use `http://127.0.0.1` and port `0` (ephemeral). Production configs are always validated before reaching `McpAuthProxy`.
- Requests to the proxy use global `fetch` — it ignores `HTTP_PROXY` env, which is exactly right for loopback tests.

- [ ] **Step 1: Write the failing test `src/mcp/auth-proxy/__tests__/server.test.ts`**

```ts
/**
 * mcp-auth-proxy server tests — real HTTP against a local fake upstream (MCP RS + AS).
 * @group unit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpAuthProxy } from '../server.js';
import type { AuthProxyConfig, JsonObject } from '../types.js';

interface FakeUpstream {
  server: http.Server;
  origin: string;
  state: { lastRegisterBody?: JsonObject; lastTokenBody?: string; lastMcpAuth?: string };
}

function createFakeUpstream(): Promise<FakeUpstream> {
  const state: FakeUpstream['state'] = {};
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', origin);
    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks).toString('utf-8');
    };

    void (async (): Promise<void> => {
      if (url.pathname === '/mcp/radar' && req.method === 'POST') {
        state.lastMcpAuth = req.headers.authorization;
        if (req.headers.authorization) {
          sendJson(200, { jsonrpc: '2.0', id: 1, result: 'ok' });
        } else {
          res.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/radar", scope="upstream-scope"`,
          });
          res.end();
        }
        return;
      }
      if (url.pathname === '/mcp/radar/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => {
          res.write('data: two\n\n');
          res.end();
        }, 20);
        return;
      }
      if (url.pathname === '/mcp/naked') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (
        url.pathname === '/.well-known/oauth-protected-resource/mcp/radar' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp/naked'
      ) {
        const resource = url.pathname.endsWith('naked') ? `${origin}/mcp/naked` : `${origin}/mcp/radar`;
        sendJson(200, {
          resource,
          authorization_servers: [`${origin}/idp`],
          scopes_supported: ['upstream-scope'],
        });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server/idp') {
        sendJson(200, {
          issuer: `${origin}/idp`,
          authorization_endpoint: `${origin}/idp/authorize`,
          token_endpoint: `${origin}/idp/token`,
          registration_endpoint: `${origin}/idp/register`,
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true,
        });
        return;
      }
      if (url.pathname === '/idp/register' && req.method === 'POST') {
        state.lastRegisterBody = JSON.parse(await readBody()) as JsonObject;
        sendJson(201, { client_id: `dyn-${Date.now()}`, client_name: state.lastRegisterBody.client_name });
        return;
      }
      if (url.pathname === '/idp/token' && req.method === 'POST') {
        state.lastTokenBody = await readBody();
        sendJson(200, { access_token: 'tok-123', token_type: 'Bearer' });
        return;
      }
      sendJson(404, { error: 'not_found' });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        state,
      });
    });
  });
}

describe('McpAuthProxy', () => {
  let upstream: FakeUpstream;
  let proxy: McpAuthProxy;
  let proxyOrigin: string;

  beforeAll(async () => {
    upstream = await createFakeUpstream();
    const config: AuthProxyConfig = {
      port: 0,
      servers: {
        radar: {
          upstreamUrl: `${upstream.origin}/mcp/radar`,
          clientName: 'EPAM Approved MCP Client',
          scopes: ['openid', 'mcp:access'],
        },
        naked: { upstreamUrl: `${upstream.origin}/mcp/naked` },
        down: { upstreamUrl: 'http://127.0.0.1:1/mcp/down' },
      },
    };
    proxy = new McpAuthProxy(config);
    const { url } = await proxy.start();
    proxyOrigin = url;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('streams MCP POSTs through untouched, passing Authorization along', async () => {
    const res = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-abc' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(upstream.state.lastMcpAuth).toBe('Bearer tok-abc');
  });

  it('rewrites the 401 challenge to point at the proxy PRM with configured scope', async () => {
    const res = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(`resource_metadata="${proxyOrigin}/.well-known/oauth-protected-resource/radar"`);
    expect(challenge).toContain('scope="openid mcp:access"');
    expect(challenge).not.toContain('upstream-scope');
  });

  it('injects a challenge when the upstream 401 carries none', async () => {
    const res = await fetch(`${proxyOrigin}/naked`, { method: 'GET' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(`resource_metadata="${proxyOrigin}/.well-known/oauth-protected-resource/naked"`);
    expect(challenge).not.toContain('scope=');
  });

  it('streams SSE responses through with the event-stream content type', async () => {
    const res = await fetch(`${proxyOrigin}/radar/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toContain('data: one');
    expect(body).toContain('data: two');
  });

  it('serves the rewritten PRM for a route', async () => {
    const res = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource/radar`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as JsonObject;
    expect(prm.resource).toBe(`${proxyOrigin}/radar`);
    expect(prm.authorization_servers).toEqual([`${proxyOrigin}/as/radar`]);
    expect(prm.scopes_supported).toEqual(['openid', 'mcp:access']);
  });

  it('serves identical rewritten AS metadata on all three well-known variants', async () => {
    const variants = [
      `${proxyOrigin}/.well-known/oauth-authorization-server/as/radar`,
      `${proxyOrigin}/.well-known/openid-configuration/as/radar`,
      `${proxyOrigin}/as/radar/.well-known/openid-configuration`,
    ];
    const bodies: JsonObject[] = [];
    for (const variant of variants) {
      const res = await fetch(variant);
      expect(res.status).toBe(200);
      bodies.push((await res.json()) as JsonObject);
    }
    for (const body of bodies) {
      expect(body.issuer).toBe(`${proxyOrigin}/as/radar`);
      expect(body.authorization_endpoint).toBe(`${proxyOrigin}/as/radar/authorize`);
      expect(body.token_endpoint).toBe(`${proxyOrigin}/as/radar/token`);
      expect(body.registration_endpoint).toBe(`${proxyOrigin}/as/radar/register`);
      expect(body.code_challenge_methods_supported).toEqual(['S256']);
      expect(body).not.toHaveProperty('client_id_metadata_document_supported');
      expect(body).not.toHaveProperty('revocation_endpoint');
    }
  });

  it('rewrites DCR bodies (client_name + injected scope) and relays the dynamic client_id', async () => {
    const res = await fetch(`${proxyOrigin}/as/radar/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:33418/callback'],
      }),
    });
    expect(res.status).toBe(201);
    const registered = (await res.json()) as JsonObject;
    expect(String(registered.client_id)).toMatch(/^dyn-/);
    expect(upstream.state.lastRegisterBody?.client_name).toBe('EPAM Approved MCP Client');
    expect(upstream.state.lastRegisterBody?.scope).toBe('openid mcp:access');
    expect(upstream.state.lastRegisterBody?.redirect_uris).toEqual(['http://localhost:33418/callback']);
  });

  it('302-redirects authorize with rewritten scope + resource, preserving PKCE params', async () => {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'dyn-1',
      redirect_uri: 'http://localhost:33418/callback',
      state: 's1',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      scope: 'claudeai',
      resource: `${proxyOrigin}/radar`,
    });
    const res = await fetch(`${proxyOrigin}/as/radar/authorize?${query.toString()}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${upstream.origin}/idp/authorize`);
    expect(location.searchParams.get('scope')).toBe('openid mcp:access');
    expect(location.searchParams.get('resource')).toBe(`${upstream.origin}/mcp/radar`);
    expect(location.searchParams.get('code_challenge')).toBe('cc');
    expect(location.searchParams.get('state')).toBe('s1');
  });

  it('rewrites token bodies (resource) and relays the token response verbatim', async () => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      code_verifier: 'verifier-1',
      client_id: 'dyn-1',
      redirect_uri: 'http://localhost:33418/callback',
      resource: `${proxyOrigin}/radar`,
    });
    const res = await fetch(`${proxyOrigin}/as/radar/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as JsonObject).access_token).toBe('tok-123');
    const sent = new URLSearchParams(upstream.state.lastTokenBody ?? '');
    expect(sent.get('resource')).toBe(`${upstream.origin}/mcp/radar`);
    expect(sent.get('code')).toBe('auth-code-1');
    expect(sent.get('code_verifier')).toBe('verifier-1');
  });

  it('keeps routes isolated: a dead upstream 502s while others keep working', async () => {
    const downRes = await fetch(`${proxyOrigin}/down`, { method: 'POST', body: '{}' });
    expect(downRes.status).toBe(502);
    expect(await downRes.json()).toEqual({ error: 'upstream_unreachable', route: 'down' });

    const okRes = await fetch(`${proxyOrigin}/radar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-abc' },
      body: '{}',
    });
    expect(okRes.status).toBe(200);
  });

  it('marks a route degraded in /healthz after failed discovery, without touching others', async () => {
    const prmRes = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource/down`);
    expect(prmRes.status).toBe(502);

    const health = await fetch(`${proxyOrigin}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; routes: Array<{ id: string; status: string }> };
    expect(body.status).toBe('ok');
    expect(body.routes.find((r) => r.id === 'down')?.status).toBe('degraded');
    expect(body.routes.find((r) => r.id === 'radar')?.status).toBe('ok');
  });

  it('rejects oversized register bodies with 413', async () => {
    const res = await fetch(`${proxyOrigin}/as/radar/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x'.repeat(65 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('404s unknown routes and the root PRM alias when multiple routes exist', async () => {
    const unknown = await fetch(`${proxyOrigin}/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_route' });

    const rootPrm = await fetch(`${proxyOrigin}/.well-known/oauth-protected-resource`);
    expect(rootPrm.status).toBe(404);
  });
});

describe('McpAuthProxy single-route alias', () => {
  it('serves the root PRM alias when exactly one route is configured', async () => {
    const upstream = await createFakeUpstream();
    const config: AuthProxyConfig = {
      port: 0,
      servers: { radar: { upstreamUrl: `${upstream.origin}/mcp/radar` } },
    };
    const solo = new McpAuthProxy(config);
    const { url } = await solo.start();
    try {
      const res = await fetch(`${url}/.well-known/oauth-protected-resource`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as JsonObject).resource).toBe(`${url}/radar`);
    } finally {
      await solo.stop();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: FAIL — `Cannot find module '../server.js'`.

- [ ] **Step 3: Write `src/mcp/auth-proxy/server.ts`**

```ts
/**
 * MCP Auth Proxy — HTTP server (docs/SPEC-mcp-auth-proxy.md § Route Map, rows 1–11).
 *
 * Loopback-only transparent proxy: streams MCP traffic to upstreams untouched (design
 * D1: raw node:http + pipeline — no buffering, no body-parsing middleware) and serves
 * per-route OAuth endpoints whose only job is the surgical rewrites in rewrites.ts.
 * Stateless w.r.t. auth: no tokens, codes, or client records are ever held.
 *
 * Uniform log rule: method, route id, endpoint kind, status, duration, and rewritten
 * field NAMES only — never headers, bodies, or query strings on OAuth routes.
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { ConfigurationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { sanitizeLogArgs } from '../../utils/security.js';
import { MetadataCache, MetadataDiscoveryError } from './metadata-cache.js';
import {
  rewriteAsMetadata,
  rewriteAuthorizeQuery,
  rewriteChallengeHeader,
  rewritePrm,
  rewriteRegistrationBody,
  rewriteTokenBody,
} from './rewrites.js';
import { UpstreamClient } from './upstream-client.js';
import type { AuthProxyConfig, JsonObject, RewriteContext, RouteConfig } from './types.js';

// Bind to the literal IPv4 loopback, never 'localhost' (repo ADR: macOS resolves
// 'localhost' to ::1 only) and never a configurable host — the proxy relays bearer
// tokens and must not be network-exposed.
export const BIND_HOST = '127.0.0.1';

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;

/** Hop-by-hop headers (RFC 9110 §7.6.1) — never forwarded in either direction. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

class BodyTooLargeError extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

async function readBodyLimited(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(incoming: http.IncomingHttpHeaders, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') {
      continue;
    }
    if (value !== undefined) {
      headers[lower] = value;
    }
  }
  headers.host = target.host;
  return headers;
}

function copyResponseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

function isUpstreamNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined || error.message.includes('Timed out') || error.message.includes('socket hang up');
}

export class McpAuthProxy {
  private server?: http.Server;
  private port: number;
  private readonly sockets = new Set<Socket>();
  private readonly client: UpstreamClient;
  private readonly metadata: MetadataCache;

  constructor(private readonly config: AuthProxyConfig) {
    this.port = config.port;
    this.client = new UpstreamClient();
    this.metadata = new MetadataCache((url) => this.client.fetchJson(url));
  }

  get origin(): string {
    return `http://${BIND_HOST}:${this.port}`;
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.server) {
      throw new ConfigurationError('mcp-auth-proxy server is already running');
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(
          error.code === 'EADDRINUSE'
            ? new ConfigurationError(
                `Port ${this.port} is already in use — stop the other process or set a different "port" in mcp-auth-proxy.json`
              )
            : error
        );
      });
      server.listen(this.port, BIND_HOST, () => resolve());
    });

    const address = server.address();
    if (address !== null && typeof address === 'object') {
      this.port = address.port;
    }
    this.server = server;
    logger.debug(
      `[mcp-auth-proxy] Listening on ${this.origin} (routes: ${Object.keys(this.config.servers).join(', ')})`
    );
    return { port: this.port, url: this.origin };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Long-lived SSE sockets would otherwise keep close() pending forever.
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
    this.client.close();
  }

  private ctx(routeId: string): RewriteContext {
    return {
      proxyOrigin: this.origin,
      routeId,
      scopes: this.config.servers[routeId]?.scopes,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', this.origin);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    let kind = 'unknown';
    let routeId = '';

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        kind = 'healthz';
        this.serveHealth(res);
      } else if (segments[0] === '.well-known') {
        [kind, routeId] = await this.handleWellKnown(req, res, segments);
      } else if (segments[0] === 'as' && segments.length >= 2) {
        routeId = segments[1];
        kind = await this.handleOAuth(req, res, url, segments);
      } else if (segments.length >= 1 && this.config.servers[segments[0]] !== undefined) {
        routeId = segments[0];
        kind = 'mcp';
        await this.passThrough(req, res, url, routeId);
      } else {
        sendJson(res, 404, { error: 'unknown_route' });
      }
    } catch (error) {
      this.handleError(res, routeId, error);
    }

    logger.debug(
      '[mcp-auth-proxy] request',
      ...sanitizeLogArgs({
        method: req.method,
        route: routeId || undefined,
        kind,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      })
    );
  }

  // ── Route map rows 2–6: well-known documents ─────────────────────────────

  private async handleWellKnown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    segments: string[]
  ): Promise<[string, string]> {
    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'unknown_route' });
      return ['unknown', ''];
    }
    const doc = segments[1];

    if (doc === 'oauth-protected-resource') {
      if (segments.length === 3) {
        await this.servePrm(res, segments[2]);
        return ['prm', segments[2]];
      }
      // Row 3: root alias only when exactly one route is configured.
      const routeIds = Object.keys(this.config.servers);
      if (segments.length === 2 && routeIds.length === 1) {
        await this.servePrm(res, routeIds[0]);
        return ['prm', routeIds[0]];
      }
      sendJson(res, 404, { error: 'unknown_route' });
      return ['unknown', ''];
    }

    if (
      (doc === 'oauth-authorization-server' || doc === 'openid-configuration') &&
      segments[2] === 'as' &&
      segments.length === 4
    ) {
      await this.serveAsMetadata(res, segments[3]);
      return ['as-metadata', segments[3]];
    }

    sendJson(res, 404, { error: 'unknown_route' });
    return ['unknown', ''];
  }

  private async servePrm(res: http.ServerResponse, routeId: string): Promise<void> {
    const route = this.config.servers[routeId];
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewritePrm(meta.prm, this.ctx(routeId));
    sendJson(res, 200, value);
    this.logRewrites('prm', routeId, rewrote);
  }

  private async serveAsMetadata(res: http.ServerResponse, routeId: string): Promise<void> {
    const route = this.config.servers[routeId];
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewriteAsMetadata(meta.asMetadata, {
      ...this.ctx(routeId),
      upstreamHasRevocation: meta.revocationEndpoint !== undefined,
    });
    sendJson(res, 200, value);
    this.logRewrites('as-metadata', routeId, rewrote);
  }

  // ── Route map rows 7–10: OAuth endpoints under /as/<id>/* ────────────────

  private async handleOAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    segments: string[]
  ): Promise<string> {
    const routeId = segments[1];
    const route = this.config.servers[routeId];
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return 'unknown';
    }
    const action = segments.slice(2).join('/');

    if (req.method === 'GET' && action === '.well-known/openid-configuration') {
      await this.serveAsMetadata(res, routeId);
      return 'as-metadata';
    }
    if (req.method === 'POST' && action === 'register') {
      await this.handleRegister(req, res, routeId, route);
      return 'register';
    }
    if (req.method === 'GET' && action === 'authorize') {
      await this.handleAuthorize(res, url, routeId, route);
      return 'authorize';
    }
    if (req.method === 'POST' && action === 'token') {
      await this.handleToken(req, res, routeId, route);
      return 'token';
    }
    if (req.method === 'POST' && action === 'revoke') {
      await this.handleRevoke(req, res, routeId, route);
      return 'revoke';
    }
    sendJson(res, 404, { error: 'unknown_route' });
    return 'unknown';
  }

  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const { value, rewrote } = rewriteRegistrationBody(parsed as JsonObject, {
      clientName: route.clientName,
      scopes: route.scopes,
    });
    await this.relay(req, res, new URL(meta.registrationEndpoint), Buffer.from(JSON.stringify(value), 'utf-8'), 'application/json');
    this.logRewrites('register', routeId, rewrote);
  }

  private async handleAuthorize(
    res: http.ServerResponse,
    url: URL,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewriteAuthorizeQuery(url.searchParams, {
      scopes: route.scopes,
      upstreamResource: meta.upstreamResource,
    });
    const location = new URL(meta.authorizationEndpoint);
    for (const [key, param] of value) {
      location.searchParams.set(key, param);
    }
    res.writeHead(302, { location: location.toString() });
    res.end();
    this.logRewrites('authorize', routeId, rewrote);
  }

  private async handleToken(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    const { value, rewrote } = rewriteTokenBody(new URLSearchParams(body.toString('utf-8')), {
      scopes: route.scopes,
      upstreamResource: meta.upstreamResource,
    });
    // NEVER log request or response bodies on this route.
    await this.relay(
      req,
      res,
      new URL(meta.tokenEndpoint),
      Buffer.from(value.toString(), 'utf-8'),
      'application/x-www-form-urlencoded'
    );
    this.logRewrites('token', routeId, rewrote);
  }

  private async handleRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    if (meta.revocationEndpoint === undefined) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    const contentType =
      typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']
        : 'application/x-www-form-urlencoded';
    await this.relay(req, res, new URL(meta.revocationEndpoint), body, contentType);
  }

  /** Reads a 64 KB-limited OAuth body; answers 413 and returns null when oversized. */
  private async readOAuthBody(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<Buffer | null> {
    try {
      return await readBodyLimited(req, OAUTH_BODY_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return null;
      }
      throw error;
    }
  }

  /** Forwards a buffered OAuth payload upstream and relays status + body verbatim. */
  private async relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: URL,
    payload: Buffer,
    contentType: string
  ): Promise<void> {
    const headers = forwardHeaders(req.headers, target);
    headers['content-type'] = contentType;
    headers['content-length'] = String(payload.length);
    const { request, response } = this.client.begin(target, { method: 'POST', headers, body: payload });
    res.on('close', () => {
      if (!res.writableEnded) {
        request.destroy();
      }
    });
    const upstream = await response;
    res.writeHead(upstream.statusCode ?? 502, copyResponseHeaders(upstream));
    await pipeline(upstream, res);
  }

  // ── Route map row 1: MCP streaming pass-through ───────────────────────────

  private async passThrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    routeId: string
  ): Promise<void> {
    const route = this.config.servers[routeId];
    const target = new URL(route.upstreamUrl);
    target.pathname = target.pathname.replace(/\/+$/, '') + url.pathname.slice(`/${routeId}`.length);
    target.search = url.search;

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const { request, response } = this.client.begin(target, {
      method: req.method ?? 'GET',
      headers: forwardHeaders(req.headers, target),
      ...(hasBody ? { bodyStream: req } : {}),
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        request.destroy();
      }
    });

    const upstream = await response;
    const status = upstream.statusCode ?? 502;
    const outHeaders = copyResponseHeaders(upstream);

    const challenge = upstream.headers['www-authenticate'];
    const challengeText = typeof challenge === 'string' ? challenge : undefined;
    const needsChallengeRewrite =
      status === 401 ||
      (status === 403 &&
        challengeText !== undefined &&
        /error\s*=\s*"?insufficient_scope"?/i.test(challengeText));

    if (needsChallengeRewrite) {
      if (challengeText !== undefined) {
        const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challengeText);
        if (match) {
          this.metadata.notePrmUrl(routeId, match[1]);
        }
      }
      const { value, rewrote } = rewriteChallengeHeader(challengeText, this.ctx(routeId));
      outHeaders['www-authenticate'] = value;
      this.logRewrites('mcp', routeId, rewrote);
    }

    res.writeHead(status, outHeaders);
    try {
      await pipeline(upstream, res);
    } catch {
      // Client disconnected mid-stream (normal for aborted SSE) — tear both sides down.
      upstream.destroy();
      res.destroy();
    }
  }

  // ── Health + errors ───────────────────────────────────────────────────────

  private serveHealth(res: http.ServerResponse): void {
    const routes = Object.entries(this.config.servers).map(([id, route]) => ({
      id,
      upstreamUrl: route.upstreamUrl,
      status: this.metadata.getStatus(id),
    }));
    sendJson(res, 200, { status: 'ok', routes });
  }

  private handleError(res: http.ServerResponse, routeId: string, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof MetadataDiscoveryError || isUpstreamNetworkError(error)) {
      // Spec log rule: upstream host only — we log the route id, never full URLs.
      logger.warn(
        '[mcp-auth-proxy] Upstream unreachable',
        ...sanitizeLogArgs({ route: routeId || 'unknown' })
      );
      sendJson(
        res,
        502,
        routeId ? { error: 'upstream_unreachable', route: routeId } : { error: 'upstream_unreachable' }
      );
      return;
    }
    logger.error('[mcp-auth-proxy] Request handling failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }

  private logRewrites(kind: string, routeId: string, rewrote: string[]): void {
    if (rewrote.length === 0) {
      return;
    }
    logger.debug(
      '[mcp-auth-proxy] rewrote',
      ...sanitizeLogArgs({ route: routeId, kind, fields: rewrote.join(', ') })
    );
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: PASS (all cases, including isolation and single-route alias suites).

- [ ] **Step 5: Run the whole module's tests together**

Run: `npx vitest run src/mcp/auth-proxy`
Expected: PASS — config, rewrites, state, metadata-cache, server.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth-proxy/server.ts src/mcp/auth-proxy/__tests__/server.test.ts
git commit -m "feat(proxy): add McpAuthProxy server with streaming pass-through and OAuth rewrites"
```

---

### Task 7: Daemon runtime + bin entry + wrapper

**Test-first: no — thin glue mirroring `src/bin/proxy-daemon.ts` (deliberately WITHOUT the ProxyWatcher: spec non-goal). Config, state, and server behavior are already unit-tested; end-to-end daemon lifecycle is smoke-verified in Task 8 Step 5 via the real CLI.**

**Files:**
- Create: `src/mcp/auth-proxy/runtime.ts`
- Create: `src/bin/mcp-auth-proxy-daemon.ts`
- Create: `bin/mcp-auth-proxy-daemon.js`

- [ ] **Step 1: Write `src/mcp/auth-proxy/runtime.ts`** (design D5 — shared by the bin entry and CLI `--foreground`)

```ts
/**
 * MCP Auth Proxy — shared daemon runtime.
 *
 * Single implementation behind both the detached bin entry and CLI --foreground:
 * load + validate config, start the server, persist the state file, clean up on
 * SIGTERM/SIGINT. No self-healing watcher by design (spec § Non-Goals): the proxy
 * holds no session state, so a crash only needs a manual restart.
 */
import { logger } from '../../utils/logger.js';
import { getDefaultStatePath, loadAuthProxyConfig } from './config.js';
import { McpAuthProxy } from './server.js';
import { clearAuthProxyState, writeAuthProxyState } from './state.js';

export interface RunDaemonOptions {
  configPath?: string;
  port?: number;
  stateFile?: string;
}

export interface RunningDaemon {
  proxy: McpAuthProxy;
  port: number;
  url: string;
  routes: string[];
  stop: () => Promise<void>;
}

export async function runAuthProxyDaemon(options: RunDaemonOptions = {}): Promise<RunningDaemon> {
  const config = await loadAuthProxyConfig(options.configPath);
  if (options.port !== undefined) {
    config.port = options.port;
  }
  const stateFile = options.stateFile ?? getDefaultStatePath();

  const proxy = new McpAuthProxy(config);
  const { port, url } = await proxy.start();
  const routes = Object.keys(config.servers);

  await writeAuthProxyState(
    { pid: process.pid, port, routes, startedAt: new Date().toISOString() },
    stateFile
  );

  const stop = async (): Promise<void> => {
    try {
      await proxy.stop();
    } catch {
      // Best-effort shutdown
    }
    try {
      await clearAuthProxyState(stateFile);
    } catch {
      // Best-effort cleanup
    }
  };
  const onSignal = (): void => {
    void stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  logger.debug(`[mcp-auth-proxy] Daemon running at ${url} (routes: ${routes.join(', ')})`);
  return { proxy, port, url, routes, stop };
}
```

- [ ] **Step 2: Write `src/bin/mcp-auth-proxy-daemon.ts`**

```ts
/**
 * MCP Auth Proxy Daemon Entry Point
 *
 * Spawned as a detached process by `codemie mcp-auth-proxy start`.
 * Loads the config, starts McpAuthProxy, writes the state file, handles SIGTERM.
 */
import { parseArgs } from 'node:util';
import { runAuthProxyDaemon } from '../mcp/auth-proxy/runtime.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    port: { type: 'string' },
    'state-file': { type: 'string' },
  },
  strict: false,
});

const portArg = values.port as string | undefined;
const port = portArg ? Number.parseInt(portArg, 10) : undefined;
if (port !== undefined && (!Number.isFinite(port) || port <= 0)) {
  process.stderr.write(`[mcp-auth-proxy-daemon] Invalid --port value: ${portArg}\n`);
  process.exit(1);
}

try {
  await runAuthProxyDaemon({
    configPath: values.config as string | undefined,
    port,
    stateFile: values['state-file'] as string | undefined,
  });
} catch (error) {
  process.stderr.write(`[mcp-auth-proxy-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
```

- [ ] **Step 3: Write the git-tracked wrapper `bin/mcp-auth-proxy-daemon.js`** (design D4 — spawn is by file path; tsc emits the compiled entry under `dist/bin/`)

```js
#!/usr/bin/env node

/**
 * CodeMie MCP Auth Proxy Daemon entry point
 * Imports compiled daemon from dist/
 */
import('../dist/bin/mcp-auth-proxy-daemon.js').catch((error) => {
  process.stderr.write(`[mcp-auth-proxy-daemon] Fatal: ${error.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS; `dist/bin/mcp-auth-proxy-daemon.js` exists after build (`ls dist/bin/ | grep mcp-auth`).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/runtime.ts src/bin/mcp-auth-proxy-daemon.ts bin/mcp-auth-proxy-daemon.js
git commit -m "feat(proxy): add mcp-auth-proxy daemon runtime and detached entry point"
```

---

### Task 8: CLI command + registration + smoke test

**Test-first: no — mirrors the existing (untested) Commander start/stop/status precedent in `src/cli/commands/proxy/index.ts`; underlying config/state/server logic is unit-tested. Verified here by a real daemon lifecycle smoke run (Step 5).**

**Files:**
- Create: `src/cli/commands/mcp-auth-proxy.ts`
- Modify: `src/cli/index.ts` (imports around line 37; registration around line 98)

- [ ] **Step 1: Write `src/cli/commands/mcp-auth-proxy.ts`**

```ts
/**
 * `codemie mcp-auth-proxy` — manage the MCP OAuth rewriting proxy daemon.
 *
 * Distinct from `codemie mcp-proxy` (the stdio↔HTTP bridge): this command manages a
 * background loopback HTTP proxy that rewrites OAuth client_name/scope/resource for
 * remote MCP servers — see docs/SPEC-mcp-auth-proxy.md.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import http from 'node:http';
import { join, resolve } from 'node:path';
import {
  ConfigurationError,
  ToolExecutionError,
  createErrorContext,
  formatErrorForUser,
} from '../../utils/errors.js';
import { getDirname } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { spawnDetached } from '../../utils/processes.js';
import {
  getDefaultConfigPath,
  getDefaultStatePath,
  loadAuthProxyConfig,
} from '../../mcp/auth-proxy/config.js';
import { runAuthProxyDaemon } from '../../mcp/auth-proxy/runtime.js';
import {
  clearAuthProxyState,
  isProcessAlive,
  readAuthProxyState,
} from '../../mcp/auth-proxy/state.js';
import type { RouteStatus } from '../../mcp/auth-proxy/types.js';

function parsePortOption(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ConfigurationError(`Invalid port value: ${value}`);
  }
  return parsed;
}

function printError(error: unknown, label: string): never {
  logger.error(label, error);
  if (error instanceof ConfigurationError || error instanceof ToolExecutionError) {
    console.error(chalk.red(`✗ ${error.message}`));
  } else {
    console.error(formatErrorForUser(createErrorContext(error), { showSystem: false }));
  }
  process.exit(1);
}

function printAddCommands(port: number, routes: string[]): void {
  console.log(chalk.bold('\nAdd to Claude Code:'));
  for (const id of routes) {
    console.log(`  claude mcp add --scope local --transport http ${id} http://127.0.0.1:${port}/${id}`);
  }
}

interface HealthzRoute {
  id: string;
  upstreamUrl: string;
  status: RouteStatus;
}

function fetchHealth(port: number): Promise<{ status: string; routes: HealthzRoute[] }> {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolveHealth(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (error) {
            rejectHealth(error as Error);
          }
        });
      }
    );
    request.on('error', rejectHealth);
    request.on('timeout', () => request.destroy(new Error('healthz timed out')));
  });
}

export function createMcpAuthProxyCommand(): Command {
  const command = new Command('mcp-auth-proxy');
  command.description(
    'Manage the MCP OAuth rewriting proxy (client_name/scope/resource rewrites for remote MCP servers; not the stdio mcp-proxy bridge)'
  );

  command
    .command('start')
    .description('Start the proxy daemon (detached by default)')
    .option('--config <path>', 'Config file path (default: <codemie-home>/mcp-auth-proxy.json)')
    .option('--port <port>', 'Override the configured listen port')
    .option('--foreground', 'Run in the foreground (debugging; CODEMIE_DEBUG=true for verbose logs)')
    .action(async (opts: { config?: string; port?: string; foreground?: boolean }) => {
      try {
        const existing = await readAuthProxyState();
        if (existing && isProcessAlive(existing.pid)) {
          console.log(
            chalk.green(
              `✓ mcp-auth-proxy already running on http://127.0.0.1:${existing.port} (pid ${existing.pid})`
            )
          );
          printAddCommands(existing.port, existing.routes);
          return;
        }
        await clearAuthProxyState();

        const configPath = opts.config ? resolve(opts.config) : getDefaultConfigPath();
        const config = await loadAuthProxyConfig(configPath); // fail fast with the offending key path
        const port = parsePortOption(opts.port) ?? config.port;
        const routes = Object.keys(config.servers);

        if (opts.foreground) {
          await runAuthProxyDaemon({ configPath, port });
          console.log(chalk.green(`✓ mcp-auth-proxy running (foreground) on http://127.0.0.1:${port}`));
          printAddCommands(port, routes);
          console.log(chalk.gray('Press Ctrl+C to stop.'));
          return;
        }

        // dist/cli/commands/mcp-auth-proxy.js → ../../../bin/mcp-auth-proxy-daemon.js
        const daemonBin = join(getDirname(import.meta.url), '../../../bin/mcp-auth-proxy-daemon.js');
        spawnDetached(process.execPath, [
          daemonBin,
          '--config', configPath,
          '--port', String(port),
          '--state-file', getDefaultStatePath(),
        ]);

        for (let i = 0; i < 50; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          const state = await readAuthProxyState();
          if (state && isProcessAlive(state.pid)) {
            console.log(
              chalk.green(`✓ mcp-auth-proxy started on http://127.0.0.1:${state.port} (pid ${state.pid})`)
            );
            printAddCommands(state.port, state.routes);
            return;
          }
        }
        throw new ToolExecutionError(
          'mcp-auth-proxy-daemon',
          'Daemon failed to start within 5 seconds. Try --foreground with CODEMIE_DEBUG=true.'
        );
      } catch (error) {
        printError(error, '[mcp-auth-proxy] start failed');
      }
    });

  command
    .command('status')
    .description('Show daemon status and per-route health')
    .action(async () => {
      const state = await readAuthProxyState();
      if (!state || !isProcessAlive(state.pid)) {
        if (state) {
          await clearAuthProxyState();
        }
        console.log(chalk.yellow('mcp-auth-proxy is not running'));
        return;
      }
      console.log(
        chalk.green(
          `✓ mcp-auth-proxy running on http://127.0.0.1:${state.port} (pid ${state.pid}, started ${state.startedAt})`
        )
      );
      try {
        const health = await fetchHealth(state.port);
        for (const route of health.routes) {
          const marker =
            route.status === 'degraded' ? chalk.red('✗ degraded') : chalk.green(`✓ ${route.status}`);
          console.log(`  ${route.id}: ${marker} → ${route.upstreamUrl}`);
          console.log(
            `    claude mcp add --scope local --transport http ${route.id} http://127.0.0.1:${state.port}/${route.id}`
          );
        }
      } catch {
        console.log(chalk.red('  ✗ Daemon process is alive but /healthz did not answer'));
      }
    });

  command
    .command('stop')
    .description('Stop the proxy daemon and remove its state file')
    .action(async () => {
      const state = await readAuthProxyState();
      if (!state || !isProcessAlive(state.pid)) {
        await clearAuthProxyState();
        console.log(chalk.yellow('mcp-auth-proxy is not running'));
        return;
      }
      process.kill(state.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        if (!isProcessAlive(state.pid)) {
          break;
        }
      }
      if (isProcessAlive(state.pid)) {
        logger.warn('[mcp-auth-proxy] Daemon ignored SIGTERM; escalating to SIGKILL');
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the signal — fine.
        }
      }
      await clearAuthProxyState();
      console.log(chalk.green('✓ mcp-auth-proxy stopped'));
    });

  return command;
}
```

- [ ] **Step 2: Register the command in `src/cli/index.ts`**

Next to the existing import at line ~37:

```ts
import { createMcpAuthProxyCommand } from './commands/mcp-auth-proxy.js';
```

Next to the existing registration at line ~98 (`program.addCommand(createMcpProxyCommand());`):

```ts
program.addCommand(createMcpAuthProxyCommand());
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS with zero warnings.

- [ ] **Step 4: Help smoke**

Run: `node bin/codemie.js mcp-auth-proxy --help && node bin/codemie.js mcp-auth-proxy start --help`
Expected: shows `start`/`stop`/`status` subcommands and the `--config/--port/--foreground` options.

- [ ] **Step 5: Daemon lifecycle smoke (isolated CODEMIE_HOME; discovery is lazy so a dummy upstream is fine)**

```bash
SMOKE_HOME=$(mktemp -d)
cat > "$SMOKE_HOME/mcp-auth-proxy.json" <<'JSON'
{
  "port": 42890,
  "servers": {
    "radar": { "upstreamUrl": "https://mcp.example.invalid/mcp/radar", "clientName": "Smoke Client", "scopes": ["openid"] }
  }
}
JSON
CODEMIE_HOME="$SMOKE_HOME" node bin/codemie.js mcp-auth-proxy start
CODEMIE_HOME="$SMOKE_HOME" node bin/codemie.js mcp-auth-proxy status
curl -s http://127.0.0.1:42890/healthz
CODEMIE_HOME="$SMOKE_HOME" node bin/codemie.js mcp-auth-proxy stop
test ! -f "$SMOKE_HOME/mcp-auth-proxy.state.json" && echo "state file removed"
rm -rf "$SMOKE_HOME"
```

Expected: start prints the `claude mcp add … http://127.0.0.1:42890/radar` line; status shows the route (status `unknown` — no discovery yet); healthz returns `{"status":"ok","routes":[…]}`; stop terminates the daemon and the state file is gone.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/mcp-auth-proxy.ts src/cli/index.ts
git commit -m "feat(cli): register codemie mcp-auth-proxy start/stop/status command"
```

---

### Task 9: Docs + full quality gates

**Test-first: no — documentation and gate verification only.**

**Files:**
- Modify: `docs/COMMANDS.md` (Core Commands block, next to the `codemie mcp-proxy` line at ~line 24)

- [ ] **Step 1: Add the command to `docs/COMMANDS.md`**

Directly below the line `codemie mcp-proxy <url>          # Stdio-to-HTTP MCP proxy with OAuth support` add:

```text
codemie mcp-auth-proxy <start|stop|status>  # OAuth-rewriting proxy daemon for remote MCP servers (client_name/scope/resource overrides; config: ~/.codemie/mcp-auth-proxy.json)
```

- [ ] **Step 2: Run the full gates (acceptance criterion 10)**

Run: `npm run lint && npm run typecheck && npm run build && npm run test:unit`
Expected: all PASS, zero warnings; the five `src/mcp/auth-proxy/__tests__/*` suites are included in the unit run.

- [ ] **Step 3: Commit**

```bash
git add docs/COMMANDS.md
git commit -m "docs: document codemie mcp-auth-proxy command"
```

---

## Plan Self-Review Notes (already applied)

- **Spec coverage:** route map rows 1–11 → Task 6 (`handleRequest`/`handleWellKnown`/`handleOAuth`/`passThrough`, incl. row-3 single-route alias and row-10 revoke gating); R1–R6 → Task 2 (pure) + Task 6 (wiring); config semantics → Task 1; CLI/daemon/state → Tasks 3, 7, 8; healthz/status/add-command output → Tasks 6, 8; error handling (`502 upstream_unreachable`+route, `404 unknown_route`, degraded routes, 64 KB → 413) → Task 6; security (loopback literal bind, TLS verify on, no token/query logging, no watcher) → Tasks 4, 6, 7; acceptance criterion 10 → Task 9. E2E criteria 1–9 are covered at unit/integration level per the design's acceptance mapping; live-IdP verification is a manual post-merge step.
- **Deliberate deviations (do not "fix" during implementation):** node:http+pipeline instead of undici (design D1, gate-approved); no package.json change; no license headers (repo has none; license-check gates dependencies only).
- **Type consistency:** `RewriteResult`/`RewriteContext` defined once in Task 1 and used verbatim in Tasks 2/6; `getDefaultStatePath` lives in `config.ts` and is imported by `state.ts`/CLI; `isProcessAlive` is exported from `state.ts` (module-local, not imported from daemon-manager — layering).

