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
