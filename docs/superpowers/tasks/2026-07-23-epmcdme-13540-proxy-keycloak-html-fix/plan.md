# Proxy Keycloak HTML Response Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `codemie proxy connect desktop` from crashing with a SyntaxError when the upstream model-discovery endpoint returns a Keycloak HTML page instead of JSON, and fix the same false-healthy bug in the proxy deep health-check.

**Architecture:** Add a Content-Type guard in `fetchClaudeModels()` (desktop.ts) and `checkProxyHealth()` (health-check.ts) — both check `!contentType.includes('application/json')` after `response.ok` passes, and surface a `ConfigurationError` / `code: 'unauthorized'` result with actionable re-auth instructions.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, Vitest 4.1.5 (`globalThis.fetch = vi.fn()` mock pattern), `ConfigurationError` from `@/utils/errors.js`.

## Global Constraints

- ES modules with `.js` extensions on all imports.
- No `any` — use `as unknown as typeof globalThis.fetch` for fetch mocks.
- `ConfigurationError` is the only user-facing error class; always throw it (never raw `Error`) for user-facing failures.
- Tests only on explicit request — but this plan is an explicit request, so all test steps are in scope.
- `globalThis.fetch = vi.fn()` is the established mock pattern; no import mocking needed.
- Run commands from the repo root (`/mnt/c/Users/AleksandrBudanov/Projects/codemie-dev/codemie-code`).

---

## File Structure

| File | Change |
|---|---|
| `src/cli/commands/proxy/connectors/desktop.ts` | Add Content-Type guard at line 104 (before `response.json()`); update existing test mocks |
| `src/cli/commands/proxy/health-check.ts` | Add Content-Type guard at line 105 (before `return { healthy: true }`) |
| `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` | Add 3 new `fetchClaudeModels` tests; update 5 existing mock objects to include `headers` |
| `src/cli/commands/proxy/__tests__/health-check.test.ts` | Add 2 new deep-check tests; update 1 existing mock object to include `headers` |

---

### Task 1: `fetchClaudeModels` Content-Type guard

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:103-104`
- Modify: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (fetchClaudeModels describe block)

**Test-first: yes — HTML 200 mock → `rejects.toThrow('SSO session may have expired')` (Step 1–2 write and run RED before guard is added in Step 3)**

**Interfaces:**
- Consumes: `ConfigurationError` from `@/utils/errors.js` (already imported at line 6)
- Produces: `fetchClaudeModels()` now throws `ConfigurationError` (not `SyntaxError`) when the proxy returns a non-JSON 200 response

- [ ] **Step 1: Write 3 failing tests in `desktop.test.ts`**

Add a `headers` helper at the top of the `fetchClaudeModels` describe block (line 73, after the `afterEach`) and append 3 new `it` blocks before the closing `});` at line 157.

The `headers` helper:
```typescript
const headers = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });
```

New test 1 — HTML 200 throws with re-auth message:
```typescript
it('throws ConfigurationError with re-auth message when response is HTML (Keycloak redirect)', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: headers('text/html; charset=utf-8'),
    json: async () => { throw new SyntaxError("Unexpected token '<'"); },
  }) as unknown as typeof globalThis.fetch;

  await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
    .rejects.toThrow('SSO session may have expired');
});
```

New test 2 — plain-text 200 also triggers the guard:
```typescript
it('throws ConfigurationError when response content-type is plain text (not JSON)', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: headers('text/plain; charset=utf-8'),
    json: async () => { throw new SyntaxError('not json'); },
  }) as unknown as typeof globalThis.fetch;

  await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
    .rejects.toThrow('SSO session may have expired');
});
```

New test 3 — JSON 200 with explicit content-type still works (regression):
```typescript
it('returns models when content-type is application/json (regression)', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: headers('application/json; charset=utf-8'),
    json: async () => ({ data: [{ id: 'claude-sonnet-4-6' }] }),
  }) as unknown as typeof globalThis.fetch;

  const models = await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy');
  expect(models).toContain('claude-sonnet-4-6');
});
```

- [ ] **Step 2: Run the new tests to confirm RED**

```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts --reporter verbose 2>&1 | grep -E "✓|✗|FAIL|PASS|Error|expected"
```

Expected: tests 1 and 2 fail because without the guard, the SyntaxError is caught by the outer catch and rethrown as "Local proxy model discovery could not reach" — not the expected "SSO session may have expired". Test 3 may pass (no guard yet) or fail with TypeError if run after tests 1/2 — either confirms tests are sensitive to the guard.

- [ ] **Step 3: Add the Content-Type guard to `desktop.ts`**

In `src/cli/commands/proxy/connectors/desktop.ts`, after the closing `}` of the `if (!response.ok)` block (line 103) and before `const json = await response.json()` (line 104), insert:

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

The file around the insertion point looks like this after the edit:
```typescript
    if (!response.ok) {
      // ... (lines 88–102 unchanged)
      throw new ConfigurationError(...);
    }
    // INSERT HERE ↓
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
        `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
        `to re-authenticate, then run \`codemie proxy connect desktop\` again.`
      );
    }
    const json = await response.json() as ModelsListResponse | CodeMieLlmModel[];
```

- [ ] **Step 4: Update existing `fetchClaudeModels` mocks in `desktop.test.ts` to include headers**

Without this step, the existing 5 tests in the `fetchClaudeModels` describe block will fail with `TypeError: Cannot read properties of undefined (reading 'get')` because their mock responses have no `headers` property.

Update each `mockResolvedValue(...)` in the `fetchClaudeModels` describe block to include `headers: headers('application/json')`:

**Line 79–92** (returns Claude family ids):
```typescript
globalThis.fetch = vi.fn().mockResolvedValue({
  ok: true,
  headers: headers('application/json'),
  json: async () => [
    { base_name: 'claude-sonnet-4-5-20250929' },
    // ... rest unchanged
  ],
}) as unknown as typeof globalThis.fetch;
```

**Line 107** (sends Authorization header):
```typescript
const fetchSpy = vi.fn().mockResolvedValue({
  ok: true,
  headers: headers('application/json'),
  json: async () => ({ data: [] }),
});
```

**Line 116** (throws when fetch fails) — no change needed; this mock uses `mockRejectedValue`, which throws before headers are accessed.

**Line 122** (throws when response is not ok):
```typescript
globalThis.fetch = vi.fn().mockResolvedValue({
  ok: false,
  headers: headers('application/json'),
  json: async () => ({}),
}) as unknown as typeof globalThis.fetch;
```

Wait — `!response.ok` fires before the content-type guard, so `headers` is not accessed for this case. No change strictly needed, but add it for consistency to make the mock realistic.

**Line 128–136** (vertex-only catalog):
```typescript
globalThis.fetch = vi.fn().mockResolvedValue({
  ok: true,
  headers: headers('application/json'),
  json: async () => [...],
}) as unknown as typeof globalThis.fetch;
```

**Line 144–152** (prefers non-vertex):
```typescript
globalThis.fetch = vi.fn().mockResolvedValue({
  ok: true,
  headers: headers('application/json'),
  json: async () => [...],
}) as unknown as typeof globalThis.fetch;
```

- [ ] **Step 5: Run all `fetchClaudeModels` tests to confirm GREEN**

```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts --reporter verbose 2>&1 | grep -E "✓|✗|FAIL|PASS|fetchClaudeModels"
```

Expected output:
```
✓ fetchClaudeModels > returns Claude family ids and excludes vertex / non-claude entries
✓ fetchClaudeModels > sends Authorization Bearer header with the gateway key
✓ fetchClaudeModels > throws when fetch fails
✓ fetchClaudeModels > throws when response is not ok
✓ fetchClaudeModels > returns vertex Claude ids when the catalog is vertex-only
✓ fetchClaudeModels > prefers non-vertex Claude ids when both canonical and vertex entries exist
✓ fetchClaudeModels > throws ConfigurationError with re-auth message when response is HTML (Keycloak redirect)
✓ fetchClaudeModels > throws ConfigurationError when response content-type is plain text (not JSON)
✓ fetchClaudeModels > returns models when content-type is application/json (regression)
```

- [ ] **Step 6: Commit Task 1**

```bash
git add src/cli/commands/proxy/connectors/desktop.ts \
        src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
git commit -m "fix(proxy): guard fetchClaudeModels against non-JSON 200 (Keycloak HTML redirect)

EPMCDME-13540: after response.ok passes, check Content-Type before
calling response.json(). A 302->200 Keycloak redirect produces ok=true
with text/html body; response.json() threw SyntaxError. Now throws
ConfigurationError with actionable re-auth message instead."
```

---

### Task 2: `checkProxyHealth` deep-check Content-Type guard

**Files:**
- Modify: `src/cli/commands/proxy/health-check.ts:104-105`
- Modify: `src/cli/commands/proxy/__tests__/health-check.test.ts` (deep describe tests)

**Test-first: yes — HTML 200 deep-check mock → `result.code === 'unauthorized'` (Steps 7–8 write and run RED before guard is added in Step 9)**

**Interfaces:**
- Consumes: `ProxyHealthResult` with `code: 'unauthorized'` (type already defined at line 15–19)
- Produces: `checkProxyHealth({ deep: true })` returns `{ healthy: false, code: 'unauthorized' }` when the models endpoint returns a non-JSON 200

- [ ] **Step 7: Write 2 tests in `health-check.test.ts`**

Add a `headers` helper at the top of the describe block (after `const MODELS = ...` at line 9) and 2 new `it` blocks before the final `});`.

The `headers` helper:
```typescript
const headers = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });
```

New test 4 — HTML 200 deep check returns unauthorized:
```typescript
it('deep: unauthorized when /v1/llm_models returns 200 with HTML content-type (Keycloak redirect)', async () => {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (HEALTH(url)) return { ok: true, status: 200 };
    if (MODELS(url)) return {
      ok: true,
      status: 200,
      headers: headers('text/html; charset=utf-8'),
    };
    throw new Error(`unexpected url ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;

  const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

  expect(result.healthy).toBe(false);
  expect(result.level).toBe('deep');
  expect(result.code).toBe('unauthorized');
  expect(result.reason).toContain('SSO session expired');
});
```

New test 5 — JSON 200 deep check still healthy (regression):
```typescript
it('deep: healthy when /v1/llm_models returns 200 with application/json (regression)', async () => {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (HEALTH(url)) return { ok: true, status: 200 };
    if (MODELS(url)) return {
      ok: true,
      status: 200,
      headers: headers('application/json'),
      json: async () => [],
    };
    throw new Error(`unexpected url ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;

  const result = await checkProxyHealth({ port: 4001, gatewayKey: 'k', deep: true });

  expect(result).toEqual({ healthy: true, level: 'deep', code: 'ok' });
});
```

- [ ] **Step 8: Run the new tests to confirm RED**

```bash
npx vitest run --project unit src/cli/commands/proxy/__tests__/health-check.test.ts --reporter verbose 2>&1 | grep -E "✓|✗|FAIL|PASS|Error|expected"
```

Expected: test 4 fails — currently the code hits `return { healthy: true, level: 'deep', code: 'ok' }` for any `res.ok === true` response, so the result is `healthy: true` instead of `healthy: false`.

- [ ] **Step 9: Add the Content-Type guard to `health-check.ts`**

In `src/cli/commands/proxy/health-check.ts`, after the closing `}` of the `if (!res.ok)` block (line 103) and before `return { healthy: true, level: 'deep', code: 'ok' }` (line 105), insert:

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

The file around the insertion point looks like this after the edit:
```typescript
    if (!res.ok) {
      return {
        healthy: false,
        level: 'deep',
        code: 'upstream-error',
        reason: `Upstream model discovery returned ${res.status}`,
      };
    }
    // INSERT HERE ↓
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {
        healthy: false,
        level: 'deep',
        code: 'unauthorized',
        reason: 'SSO session expired — run `codemie proxy stop && codemie profile login` to re-authenticate.',
      };
    }
    return { healthy: true, level: 'deep', code: 'ok' };
```

- [ ] **Step 10: Update the existing deep-healthy mock in `health-check.test.ts` to include headers**

The existing test at line 59 (`deep: healthy when /health and /v1/llm_models both succeed`) returns `{ ok: true, status: 200, json: async () => [] }` for the models endpoint — no `headers`. After the guard is added, `res.headers.get(...)` will throw TypeError on this mock.

Update the MODELS branch of that test's fetchSpy:
```typescript
if (MODELS(url)) return {
  ok: true,
  status: 200,
  headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
  json: async () => [],
};
```

- [ ] **Step 11: Run all `health-check.test.ts` tests to confirm GREEN**

```bash
npx vitest run --project unit src/cli/commands/proxy/__tests__/health-check.test.ts --reporter verbose 2>&1 | grep -E "✓|✗|FAIL|PASS|checkProxyHealth"
```

Expected output:
```
✓ checkProxyHealth > shallow: returns healthy when /health responds 200
✓ checkProxyHealth > shallow: dead-socket when the /health fetch rejects (proxy not listening)
✓ checkProxyHealth > shallow: dead-socket when /health returns a non-2xx status
✓ checkProxyHealth > deep: healthy when /health and /v1/llm_models both succeed, with Bearer auth
✓ checkProxyHealth > deep: unauthorized when /v1/llm_models returns 401
✓ checkProxyHealth > deep: unauthorized when /v1/llm_models returns 403
✓ checkProxyHealth > deep: upstream-error when /v1/llm_models returns a 5xx
✓ checkProxyHealth > deep: upstream-error when the models fetch throws
✓ checkProxyHealth > does not perform the deep call when deep is not requested
✓ checkProxyHealth > deep: unauthorized when /v1/llm_models returns 200 with HTML content-type (Keycloak redirect)
✓ checkProxyHealth > deep: healthy when /v1/llm_models returns 200 with application/json (regression)
```

- [ ] **Step 12: Run the full unit suite to check for regressions**

```bash
npx vitest run --project unit --reporter verbose 2>&1 | tail -20
```

Expected: all tests pass, no failures.

- [ ] **Step 13: Run typecheck to confirm no type errors**

```bash
npm run typecheck 2>&1 | tail -20
```

Expected: exit 0, no errors.

- [ ] **Step 14: Commit Task 2**

```bash
git add src/cli/commands/proxy/health-check.ts \
        src/cli/commands/proxy/__tests__/health-check.test.ts
git commit -m "fix(proxy): guard checkProxyHealth deep-check against non-JSON 200

EPMCDME-13540: same Keycloak HTML redirect that crashes fetchClaudeModels
also causes checkProxyHealth to return healthy:true falsely. Guard
added after res.ok passes: non-JSON content-type returns
{healthy:false, code:'unauthorized'} with re-auth guidance."
```
