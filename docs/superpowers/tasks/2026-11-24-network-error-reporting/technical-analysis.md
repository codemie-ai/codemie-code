# Technical Research

**Task**: sdk cli-utils handleSdkError network-error
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-16977 (Bug, Major, size M, GitHub issue codemie-ai/codemie-code#548): "codemie sdk assistants list" reports a misleading "API error: HTTP 500 error" on network-level failures that carry no error.response (for example ERR_FR_TOO_MANY_REDIRECTS behind an authenticated enterprise HTTPS proxy). The underlying Axios error is "Maximum number of redirects exceeded", and curl through the same proxy succeeds.
Root cause per the ticket (verify against the current code): ApiRequestHandler.processFailedResponse in the vendored codemie-sdk does `response?.status || 500`; handleSdkError (src/cli/commands/sdk/utils/cli-utils.ts) prints the message without inspecting error.code or cause. PR #571 does not change this classification.
Suggested fix: detect an error without a response and surface the original error code and message instead of "HTTP 500".
Important: the SDK lives in node_modules, so a change there will not end up in the PR. Work out where the fix can be made inside this repository and explain the choice. Authenticated-proxy and CONNECT-tunnel handling is out of scope.
Constraints: Vitest (npx vitest run --project unit <file>); first failing test must reproduce the bug: an error without a response and code ERR_FR_TOO_MANY_REDIRECTS must produce output containing that code, not "HTTP 500". Guides in .ai-run/guides/. Also check what the SDK actually throws (does the thrown error keep code/cause?), and all call sites of handleSdkError.

---

## 2. Codebase Findings

### Existing Implementations
Purpose: report a failed SDK call accurately to the CLI user.
- `src/cli/commands/sdk/utils/cli-utils.ts` `handleSdkError(error, operation)`: logs via logger + sanitizeLogArgs; branches: `ApiError` (401/403 auth hint, 404 not found, else `API error: ${msg}`), `ZodError`, else prints `msg`; then `process.exit(1)`. It never reads `code` or `cause`.
- SDK (`node_modules/codemie-sdk/dist/index.js`, v0.1.648, package.json `^0.1.648`): axios instance created at ~l.165 inside ApiRequestHandler; response interceptor (l.174-176) calls `processFailedResponse` (l.229): `status = response?.status || 500`; 404 -> NotFoundError; 422 -> ApiError; else `new ApiError(message || "HTTP ${status} error", status, data)`. Confirmed ticket cause.
- `ApiError` (l.135): constructor(message, statusCode, response) only; sets name, statusCode, response. **The original axios error, its `code` and `cause` are NOT kept** in the thrown error. So `handleSdkError` receives an `ApiError("HTTP 500 error", 500, {})` indistinguishable from a real 500 with empty body. A fix limited to handleSdkError cannot recover ERR_FR_TOO_MANY_REDIRECTS from what the SDK throws.
- Client construction: `src/utils/auth.ts` ~l.52-55 `new CodeMieClient({...})` (comment notes axios resolves proxies from the environment). The axios instance is `this.client` inside the SDK handler; whether it is reachable from the CodeMieClient was not verified.

### Decisions Already in the Code
- All SDK CLI commands funnel errors through `handleSdkError` (single choke point). Convention: user-facing messages via chalk + console.error, then process.exit(1).
- Imports use `@/` alias and `.js` extensions.

### Task Statements Checked Against the Code
- "`response?.status || 500` in processFailedResponse": holds (l.231).
- "handleSdkError prints message without inspecting code/cause": holds.
- "Suggested fix: detect error without response and surface original code": contradicted in part — by the time handleSdkError runs, the code is already lost (ApiError carries no code/cause). Only a hook before the SDK interceptor, or a heuristic on the shape `ApiError` with statusCode 500, `response` `{}` and message "HTTP 500 error", could work. Unverified: whether the CodeMieClient exposes its axios instance/interceptors, or an option to inject an httpAgent/adapter/axios instance (not searched in the .d.ts).
- PR #571 not changing classification: unverified (not inspected).

### Consumers of Changed Contracts
`handleSdkError` call sites (counts per file): assistants.ts 7, skills.ts 19, datasources.ts 8, integrations.ts 7, assistant-builder/commands.ts 7, categories.ts 6, workflows.ts 6, users.ts 3, llm.ts 2 (counts include the import line); `sdk/index.ts` 0. The signature `(error: unknown, operation: string): never` is used uniformly, e.g. assistants.ts:107 "list assistants". The one existing test is `src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts`. Any change preserving the signature affects all call sites uniformly.

### Architecture and Layers Affected
CLI layer (`src/cli/commands/sdk/**`) and utils (`cli-utils.ts`, `src/utils/auth.ts` as client factory). The SDK is third-party.

### Integration Points
`codemie-sdk` (CodeMieClient, ApiError, axios inside), `chalk`, `zod`, logger/security utils.

### Patterns and Conventions
Error classes in `src/utils/errors.ts` (ConfigurationError). Guides: development-practices (error handling), code-quality, testing-patterns (Vitest).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage). Not read in detail by this pass; AGENTS.md summarises them.

### Architectural Decisions
None found specific to SDK error handling.

### Derived Conventions
Single error-sink function; exit code 1.

---

## 4. Testing Landscape

### Existing Coverage
`src/cli/commands/sdk/utils/__tests__/cli-utils.test.ts`: one test (ApiError 401 shows "Authorization error"). Pattern: spy console.error to capture lines, spy process.exit with a no-op, `vi.restoreAllMocks()` in afterEach.

### Testing Framework and Patterns
Vitest, project `unit`. Note that with exit mocked, handleSdkError continues after the mock; the test pattern above already copes with this.

### Coverage Gaps
No tests for non-ApiError, ZodError, 404 or 500 branches, and none for network errors.

---

## 5. Configuration and Environment

### Environment Variables
Proxy env vars are resolved by axios (per comment in `src/utils/auth.ts`); not otherwise explored.

### Configuration Files
None relevant found.

### Feature Flags and Deployment Concerns
None found.

---

## 6. Risk Indicators

- Speculative: a fix confined to `handleSdkError` that checks `error.code`/`cause` would pass a test that constructs a plain Error with code, yet would not fix the real CLI, since the SDK throws ApiError with no code (Section 2).
- The SDK's thrown ApiError for no-response failures looks identical to a real HTTP 500 with an empty body; any heuristic on it can misclassify.
- Speculative: any in-repo hook before the SDK interceptor depends on SDK internals (version `^0.1.648`) and on access to its axios instance, not verified.
- 9 files call handleSdkError; behaviour change is cross-cutting.
- Test-only gap: the first failing test as specified (error without response and with code) tests handleSdkError input that real runs may never produce.

---

## 7. Summary for Complexity Assessment

The change touches the CLI utility layer (`cli-utils.ts`, one test file) and possibly the client factory in `src/utils/auth.ts`. The call-site surface is large (9 command files) but uniform through a single function, so a signature-preserving change has low blast radius.

The key finding is that the SDK's `ApiError` drops the axios `code` and `cause`, so the ticket's suggested fix in handleSdkError alone is insufficient for real runs. Where in the repo to capture the original error (client factory or interceptor on the SDK's axios instance, if reachable) is unresolved and is the main technical uncertainty. Test coverage for the area is minimal (one test), but the pattern is simple.

---

## 8. External References

None named by the task.
