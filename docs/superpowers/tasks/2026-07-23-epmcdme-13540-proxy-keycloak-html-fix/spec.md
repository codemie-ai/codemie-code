# Spec: Proxy Keycloak HTML Response Fix

**Ticket:** EPMCDME-13540  
**Slug:** epmcdme-13540-proxy-keycloak-html-fix

## Problem

`codemie proxy connect desktop` crashes with an unhandled `SyntaxError` when the upstream model discovery endpoint returns a Keycloak HTML page instead of JSON. This happens because Node.js `fetch()` silently follows the 302 redirect to the Keycloak login page, producing a `200 OK` response with `text/html` content. `response.ok` is `true`, so the existing status check passes, and `response.json()` throws on the HTML body.

A secondary issue: `checkProxyHealth()` deep-check has the same false-healthy bug — an HTML 200 causes it to return `{ healthy: true }`, masking the auth failure.

## Root Cause

- `fetchClaudeModels()` in `desktop.ts` calls `response.json()` without verifying `Content-Type`.
- `checkProxyHealth()` in `health-check.ts` returns `{ healthy: true }` without verifying `Content-Type`.
- Both trust `response.ok` as a sufficient success signal, which is wrong when redirects are followed.

## Design

### Fix 1 — `fetchClaudeModels()` guard (`desktop.ts`)

After the `response.ok` check and before `response.json()`, add a Content-Type guard:

```typescript
const contentType = response.headers.get('content-type') ?? '';
if (!contentType.includes('application/json')) {
  throw new ConfigurationError(
    `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
    `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
    `to re-authenticate, then run \`codemie proxy connect desktop\` again.`
  );
}
```

The guard uses `!includes('application/json')` (not `includes('text/html')`) to catch Keycloak HTML, plain-text error pages, and any other non-JSON 200 that would crash `response.json()`.

The existing catch block re-throws `ConfigurationError` unchanged, so the error surfaces via `printProxyError` as `✗ <message>`.

### Fix 2 — `checkProxyHealth()` deep-check guard (`health-check.ts`)

After the `!res.ok` check and before `return { healthy: true }`, add:

```typescript
const contentType = res.headers.get('content-type') ?? '';
if (!contentType.includes('application/json')) {
  return {
    healthy: false,
    level: 'deep',
    code: 'unauthorized',
    reason: 'SSO session expired — run `codemie proxy stop && codemie profile login` to re-authenticate.',
  };
}
```

This prevents a false-healthy result when the proxy is running but the upstream session is dead.

### Error taxonomy

| Scenario | Detection | Outcome |
|---|---|---|
| Proxy unavailable | `fetch()` throws (ECONNREFUSED) | Already handled |
| SSO session expired / redirect | `response.ok` + non-JSON content-type | **New** — `ConfigurationError` / `code: 'unauthorized'` |
| Backend error | `!response.ok` (4xx/5xx) | Already handled |
| Unexpected content type | `response.ok` + non-JSON, non-HTML | Same new guard catches it |

## Test Cases

### `desktop.test.ts`

1. HTML 200 from `/v1/llm_models` → `fetchClaudeModels` throws `ConfigurationError` containing the re-auth message
2. JSON 200 from `/v1/llm_models` → returns model list (regression)
3. Plain-text 200 → `fetchClaudeModels` throws `ConfigurationError` (broadened guard coverage)

### `health-check.test.ts`

4. HTML 200 from deep-check endpoint → `checkProxyHealth` returns `{ healthy: false, code: 'unauthorized' }`
5. JSON 200 from deep-check endpoint → `checkProxyHealth` returns `{ healthy: true }` (regression)

## Files Changed

| File | Change |
|---|---|
| `src/cli/commands/proxy/connectors/desktop.ts` | Add Content-Type guard in `fetchClaudeModels()` |
| `src/cli/commands/proxy/health-check.ts` | Add Content-Type guard in `checkProxyHealth()` deep path |
| `src/cli/commands/proxy/connectors/desktop.test.ts` | Add tests 1–3 |
| `src/cli/commands/proxy/health-check.test.ts` | Add tests 4–5 |

## Out of Scope

- Proactive token refresh or automatic re-login
- Changes to `sso.auth.ts` expiry logic (local `expiresAt` check is a separate concern)
- Changes to `sso.proxy.ts` (does not follow redirects; not affected)
