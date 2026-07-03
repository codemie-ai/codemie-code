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
