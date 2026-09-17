# Technical Research

**Task**: proxy connect desktop sso keycloak fetchClaudeModels model-discovery
**Generated**: 2026-07-23T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

codemie proxy connect desktop fails when local proxy model discovery receives Keycloak HTML instead of JSON. The CLI command `codemie proxy connect desktop` calls `fetchClaudeModels()` which hits `http://127.0.0.1:4001/v1/llm_models?include_all=true`. When the upstream Keycloak session has expired, the upstream returns a 302 redirect to the Keycloak login page. Node.js `fetch()` follows the redirect and lands on a 200 HTML page. `response.ok` is true so the code calls `response.json()` which throws `SyntaxError: Unexpected token '<', "<!-- Keycl"... is not valid JSON`. Acceptance criteria: (1) no crash on HTML/non-JSON response from model discovery endpoint, (2) detect Keycloak/OAuth HTML and surface actionable re-authentication message, (3) distinguish between: local proxy unavailable, auth/session issue, invalid non-JSON response, model discovery backend failure, (4) regression test coverage for non-JSON responses from /v1/llm_models?include_all=true.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/connectors/desktop.ts` — primary crash site; contains `fetchClaudeModels()`, `writeDesktopConfig()`, `selectDesktopClaudeModels()`, and MCP reconciliation; all model-discovery logic lives here
- `src/cli/commands/proxy/index.ts` — `createProxyCommand()`: registers the `proxy connect desktop` action, calls `writeDesktopConfig`, handles rollback on error via `printProxyError`
- `src/cli/commands/proxy/health-check.ts` — `checkProxyHealth()`: shallow (`/health`) and deep (`/v1/llm_models`) health checks; currently detects 401/403 but not HTML/redirect responses — secondary fix required here
- `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` — `fetchManagedMcpServers()`: safe null-on-failure fetch pattern; uses explicit status check and manual `JSON.parse` — the established reference pattern for safe HTTP handling in this codebase
- `src/utils/errors.ts` — `ConfigurationError` and `CodeMieError` base classes; `formatErrorForUser` renders errors to the console
- `src/utils/logger.ts` — structured logging; `sanitizeLogArgs()` wraps all log arguments
- `src/providers/plugins/sso/` — SSO auth, proxy daemon, session sync plugins; `authServerUrl` and `authRealm` fields stored in profile config

### Architecture and Layers Affected

- **CLI layer** (`src/cli/`): user-facing command parsing, orchestration, and error formatting — `proxy connect desktop` action registration and `printProxyError` handler in `index.ts`
- **Connector layer** (`src/cli/commands/proxy/connectors/`): desktop config write and model fetch in `desktop.ts`; `fetchClaudeModels()` is the primary change surface; `health-check.ts` requires a secondary coordinated fix
- **Provider/SSO layer** (`src/providers/plugins/sso/`): holds Keycloak profile fields (`authServerUrl`, `authRealm`) that can be used to construct actionable re-auth messages
- **Utility layer** (`src/utils/`): `ConfigurationError` is the correct error class to throw for the new error cases

### Integration Points

- Node.js built-in `fetch` called directly in `fetchClaudeModels()` with no redirect policy override, no Content-Type guard, and no timeout — the integration point where the bug manifests
- Local proxy daemon on `DEFAULT_DAEMON_PORT = 4001` (hardcoded in `src/cli/commands/proxy/index.ts`)
- Keycloak/SSO server referenced via `authServerUrl` / `authRealm` from profile config in `src/env/types.ts`
- `managed-mcp-remote.ts` uses a different HTTP stack (`HTTPClient.getRaw`) with explicit null-on-failure — an internal reference for safe fetch patterns

### Patterns and Conventions

- **Error handling pattern**: errors thrown as `ConfigurationError` (or subclasses); caught by `printProxyError` in `index.ts` which prints `error.message` and calls `process.exit(1)` — new error cases must follow this pattern
- **Response.ok guard before response.json()**: this is the broken pattern in `fetchClaudeModels()`; it does not account for 302→200 HTML responses where `response.ok` is `true` but body is HTML
- **Safe null-on-failure pattern** in `fetchManagedMcpServers`: entire fetch body wrapped in try/catch; returns `null` on any failure — the reference pattern to follow or adapt
- **Test mock pattern**: `globalThis.fetch = vi.fn()` for stubbing fetch in unit tests; no import mocking needed
- `sanitizeLogArgs()` wraps all structured log arguments in logger calls

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `/mnt/c/Users/AleksandrBudanov/Projects/codemie-dev/codemie-code/.ai-run/guides/integration/external-integrations.md` — covers SSO/provider patterns but contains no guidance on Keycloak HTML redirect detection or Content-Type validation
- `/mnt/c/Users/AleksandrBudanov/Projects/codemie-dev/codemie-code/.ai-run/guides/integration/exposed-api.md` — CLI surface and proxy endpoints documented here

### Architectural Decisions

- No ADRs or recorded decisions found specifically for model-discovery error handling or Keycloak redirect handling.
- The choice to use `response.ok` as the sole guard before `response.json()` is an implicit convention not documented anywhere; it pre-dates Keycloak redirect scenarios.

### Derived Conventions

- All user-surfaced error messages go through `ConfigurationError.message` → `printProxyError` → `process.exit(1)`; new error cases must integrate into this flow
- When a fetch can return non-JSON or may fail gracefully, the `fetchManagedMcpServers` null-on-failure pattern is the established safe alternative
- Re-auth messages should include the Keycloak realm info from profile config (`authServerUrl`, `authRealm`) to be actionable

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` — unit tests for `fetchClaudeModels`, `writeDesktopConfig`, model selection, and MCP reconciliation; covers `{ ok: false }` responses and empty arrays but **missing**: test for HTML/non-JSON 200 response (the Keycloak redirect scenario)
- `src/cli/commands/proxy/__tests__/health-check.test.ts` — unit tests for `checkProxyHealth`; covers 401/403/500/throw cases but **missing**: HTML redirect detection path
- `src/cli/commands/proxy/__tests__/watcher.test.ts` — proxy watcher tests; not directly relevant to this task
- `tests/integration/sso-claude-plugin.test.ts` — integration SSO tests; scope unclear for this specific failure mode

### Testing Framework and Patterns

- Vitest `^4.1.5`, three configured projects: `unit` (covers `src/**/*.test.ts`), `cli` (covers `tests/integration/**`), `agent` (real network)
- Fetch stubbing via `globalThis.fetch = vi.fn()` — no special import mocking needed; tests can return `{ ok: true, json: () => Promise.reject(new SyntaxError(...)), text: () => Promise.resolve('<html>...') }` to simulate the Keycloak scenario
- Existing tests in `desktop.test.ts` demonstrate the mock shape needed for new cases

### Coverage Gaps

- No test for `fetchClaudeModels()` receiving a 200 HTML response (Keycloak redirect scenario) — the exact failure path from the bug report
- No test for `checkProxyHealth()` deep-check returning a false-healthy signal on 200 HTML response
- No test distinguishing between: proxy unavailable (connection refused), auth/session expired (HTML), non-JSON response (other content type), backend failure (non-2xx JSON error)
- No test asserting that `ConfigurationError` message content includes re-auth guidance when Keycloak HTML is detected

---

## 5. Configuration and Environment

### Environment Variables

- No env var overrides found for the model discovery endpoint (`http://127.0.0.1:4001/v1/llm_models`)
- `authServerUrl` and `authRealm` — Keycloak/SSO fields in profile config (`src/env/types.ts`); accessible for constructing actionable re-auth messages

### Configuration Files

- `DEFAULT_DAEMON_PORT = 4001` — hardcoded constant in `src/cli/commands/proxy/index.ts`; governs the local proxy address
- `PREFERRED_CLAUDE_MODELS` — curated model list in `desktop.ts`; no impact on this fix
- Profile config in `src/env/types.ts` — holds `authServerUrl`/`authRealm` for Keycloak context

### Feature Flags and Deployment Concerns

- No feature flags found for model discovery or SSO redirect handling.
- No deployment manifests reference the model discovery endpoint directly.
- Secrets management: Keycloak credentials are managed through the profile config; no vault references found in scope.

---

## 6. Risk Indicators

- **Primary crash confirmed in `desktop.ts`**: `fetchClaudeModels()` calls `response.json()` unconditionally when `response.ok` is true. Node.js `fetch` follows redirects by default; a 302→200 Keycloak HTML page satisfies `response.ok === true`, so the existing `if (!response.ok)` guard never fires. Fix requires: (a) `redirect: 'manual'` fetch option OR (b) Content-Type check before calling `response.json()`.
- **Secondary vulnerability in `health-check.ts`**: `checkProxyHealth()` deep-check on `/v1/llm_models` branches only on `401`/`403`/non-ok status. Same 302→200 HTML scenario causes it to return `{ healthy: true, level: 'deep', code: 'ok' }` — a false-healthy signal. This must be fixed in the same changeset to avoid misleading health reports.
- **No Content-Type inspection anywhere in the HTTP fetch chain for model discovery**: unlike `managed-mcp-remote.ts` which uses a different HTTP stack, `fetchClaudeModels` uses raw `fetch` with no response validation beyond `response.ok`.
- **No `redirect: 'manual'` or `redirect: 'error'` option set**: the fix should explicitly set one of these on the `fetch` call to intercept the redirect before it resolves to an HTML page, or validate `Content-Type: application/json` after following the redirect.
- **No test for non-JSON 200 responses**: `desktop.test.ts` and `health-check.test.ts` both lack the test case required by acceptance criterion (4). This is the largest test coverage gap.
- **Error message quality risk**: current `SyntaxError` from `response.json()` is unhandled and propagates as an unformatted crash. Acceptance criterion (2) requires Keycloak-specific detection — the fix must inspect response body text for HTML/OAuth patterns before surfacing the re-auth message.
- **`authServerUrl`/`authRealm` availability in error path**: constructing an actionable re-auth message requires reading from profile config inside `fetchClaudeModels` or passing it in from the call site in `index.ts`. This plumbing does not currently exist and must be designed carefully.
- **`managed-mcp-remote.ts` uses a different HTTP abstraction (`HTTPClient.getRaw`)**: the safe pattern there is not directly portable to `fetchClaudeModels` which uses raw `fetch`. The fix must adapt the pattern rather than copy it verbatim.

---

## 7. Summary for Complexity Assessment

This task touches three files across two architectural layers: the Connector layer (`desktop.ts` and `health-check.ts`) and the Utility/Error layer (`errors.ts` or equivalent for new error message constants). The primary change is surgical — adding a Content-Type guard or `redirect: 'manual'` option in `fetchClaudeModels()` and a parallel fix in `checkProxyHealth()`'s deep-check path — but acceptance criterion (2) adds meaningful scope: detecting Keycloak/OAuth HTML specifically and surfacing a re-auth message requires reading profile config (`authServerUrl`, `authRealm`) inside or adjacent to the error path, which currently has no plumbing for it.

The task follows established patterns (throw `ConfigurationError`, catch in `printProxyError`, mock `globalThis.fetch` in tests) so there is no architectural novelty. However, the four-way error discrimination required by acceptance criterion (3) — proxy unavailable vs. auth/session expired vs. invalid non-JSON vs. backend failure — means the implementation must introduce distinct error classification logic rather than a single catch-all. This is moderately complex: the failure modes require inspecting HTTP status codes, response body content-type headers, and response body text (HTML fingerprint detection), each in the right order.

Test coverage for the affected area is present but has exactly the gap this task must close. `desktop.test.ts` already demonstrates the `globalThis.fetch = vi.fn()` mock pattern; new test cases for the four error scenarios are straightforward to add. The key risk is the `health-check.ts` secondary fix — it is easy to miss since it is not the primary crash site but is exercised by the same Keycloak redirect path. Failing to fix it would leave a false-healthy signal in place. Overall complexity is low-to-medium: well-scoped, established patterns, clear test targets, one non-trivial design decision around surfacing Keycloak profile context in the error message path.
