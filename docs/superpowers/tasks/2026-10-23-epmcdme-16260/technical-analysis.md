# Technical Research

**Task**: header-injection proxy x-codemie-repository
**Generated**: 2026-10-23
**Research path**: filesystem

---

## 1. Original Context

Bug EPMCDME-16260 "[CLI Analytics][Preview] codemie-claude fails every model request in folders with non-Latin characters in the path (Invalid authentication session data)".
Root cause per ticket: src header-injection.plugin.ts puts the repository name (parent/current of cwd) into the X-CodeMie-Repository HTTP header. Node only accepts Latin-1 header values and throws ERR_INVALID_CHAR before the request is sent. proxy-errors.ts normalizeError() maps ERR_INVALID_CHAR / ERR_HTTP_INVALID_HEADER_VALUE to AuthenticationError, hence the misleading "Invalid authentication session data. Run `codemie profile login`" 401. Same code path sets X-CodeMie-Branch and X-CodeMie-Project from user data (likely affected too, not verified). Header introduced in #190 and #447.
Expected: codemie-claude works in any folder regardless of path characters; session appears in CLI Analytics with repository e.g. clients/репо-тест.
Suggested fix: encode header values (e.g. encodeURIComponent, decoded on backend) or drop values that are not valid header content instead of failing; and don't report invalid header values from CodeMie's own headers as an authentication error.
No acceptance criteria in ticket; Expected result is the closest equivalent.

---

## 2. Codebase Findings

### Existing Implementations
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` (priority 20): `onRequest` writes `X-CodeMie-Repository` (from Desktop resolver `attribution.repository ?? config.repository ?? 'Cowork'`, or `config.repository`), `X-CodeMie-Branch` (`attribution.branch` and `config.branch`), `X-CodeMie-Project` (`config.project`), plus `X-CodeMie-CLI-Model`, `X-CodeMie-Integration`, `X-CodeMie-Client` straight into `context.headers` with no sanitization/encoding.
- `src/providers/plugins/sso/proxy/proxy-errors.ts` lines ~81-101: `normalizeError()` maps `ERR_INVALID_CHAR`, `ERR_HTTP_INVALID_HEADER_VALUE`, or message matching `/header content|header value|cookie/i` to `AuthenticationError('Invalid authentication session data. Run \`codemie profile login\` ...')`. Comment says it was written for corrupted cookie bytes. The regex is not discriminated by header name.
- `src/providers/plugins/sso/proxy/sso.proxy.ts:724` calls `normalizeError` in the request error path (also imports AuthenticationError at :37).
- Value origin: `src/agents/core/BaseAgentAdapter.ts` ~1021-1043 builds ProxyConfig: `repository = env.CODEMIE_REPOSITORY || 'unknown'`, `branch = env.CODEMIE_GIT_BRANCH`, `project = env.CODEMIE_PROJECT`.
- Other outbound sites that put the same user data into headers (same latent bug, outside the proxy path):
  - `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:155-157` (`X-CodeMie-Repository`, `-Branch`, `-Project` from `metric.attributes`).
  - `src/cli/commands/skills/lib/skills-metrics.ts:270-272`.

### Architecture and Layers Affected
Provider plugin layer (SSO proxy: header-injection plugin, proxy-errors, sso.proxy error handling); agent core (BaseAgentAdapter config source); analytics/metrics upload (metrics-api-client, skills-metrics) as secondary header producers.

### Integration Points
Backend (CodeMie analytics API) reads these headers; the ticket's "decoded on backend" option is a cross-repo contract change. Not verifiable from this repo. Existing tests assert raw values (`org/repo`, `feature/x`).

### Patterns and Conventions
Interceptor plugin pattern (`ProxyPlugin`/`ProxyInterceptor`); specific error classes in `proxy-errors.ts`; `.js` import extensions; logger via `logger` (no console).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`docs/ARCHITECTURE-PROXY.md:632` documents `X-CodeMie-Repository` as "Repository name (parent/current format), from `ProxyConfig.repository`"; no mention of encoding or charset. Prior related task analyses: `docs/superpowers/tasks/2026-07-22-epmcdme-12687-...` and `2026-07-10-epmcdme-10897-...`.

### Architectural Decisions
None found on header encoding.

### Derived Conventions
Headers are set as raw strings; absence of header = value not configured (integration test asserts omit).

---

## 4. Testing Landscape

### Existing Coverage
- `tests/integration/proxy-header-contract-extended.test.ts` — header contract through HeaderInjectionPlugin (set/omit repository and branch, integration header).
- `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`, `src/cli/commands/skills/lib/__tests__/skills-metrics.test.ts` (asserts `X-CodeMie-Repository` raw value), `src/utils/__tests__/processes-git.test.ts`.

### Testing Framework and Patterns
Vitest; integration harness `startHarness({repository, branch})` + `callProxy`, captured upstream headers lowercased.

### Coverage Gaps
No tests for non-Latin-1 header values; no unit tests found for `normalizeError` (grep of tests found no reference).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_REPOSITORY`, `CODEMIE_GIT_BRANCH`, `CODEMIE_PROJECT` (read in BaseAgentAdapter).

### Configuration Files
None specific.

### Feature Flags and Deployment Concerns
None found.

---

## 6. Risk Indicators

- Speculative: encoding values (e.g. encodeURIComponent) changes the wire contract; backend must decode, and it is out of this repo. Dropping non-Latin-1 values loses the ticket's expected "clients/репо-тест" attribution.
- Speculative: broad regex `/header content|header value|cookie/i` in `normalizeError` also catches genuine cookie problems; narrowing must not break that existing auth-recovery intent.
- Branch names and project can also contain non-Latin-1 chars (not verified); Desktop-resolver values are also unvalidated.
- Same header write exists in metrics-api-client.ts and skills-metrics.ts; fixing only the proxy leaves analytics upload failing for such paths.
- Also affects `X-CodeMie-CLI-Model`, Integration (user-configured) in principle.
- No unit tests for normalizeError; the contract test would need extension.

---

## 7. Summary for Complexity Assessment

The defect sits in the SSO provider proxy layer: one interceptor (`header-injection.plugin.ts`) writes unvalidated user-derived strings (repository, branch, project) into headers, and `proxy-errors.ts` mislabels Node's invalid-header error as an authentication failure. The core fix touches 2 source files; up to 2 more (`metrics-api-client.ts`, `skills-metrics.ts`) write the same headers outside the proxy.

Technical novelty is low (a small shared encode/sanitize helper and an error-mapping narrowing), but the encode-vs-drop choice has a backend contract dependency not visible in this repo. Test posture: a header contract integration test exists and is extendable; normalizeError has no direct tests. Key risks are the backend decode contract and consistent treatment across the three header-producing sites.

---

## 8. External References

None named by the task
