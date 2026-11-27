# Spec: surface network-level error code in `codemie sdk` commands (EPMCDME-16977, #548)

## Problem
For failures with no HTTP response (e.g. `ERR_FR_TOO_MANY_REDIRECTS`), the SDK interceptor (`node_modules/codemie-sdk/dist/index.js:174,229`) throws `ApiError("HTTP 500 error", 500, {})` and drops the axios `code` and `cause`. `handleSdkError` (`src/cli/commands/sdk/utils/cli-utils.ts:88`) prints "API error: HTTP 500 error". The SDK cannot be changed. Reproduced end to end against a local 302-to-self server (/tmp/evidence/before.txt).

## Approach
A small helper in `src/utils/` wraps the public `axios.defaults.adapter` before `CodeMieClient` is created. The wrapper records the response-less network error (code, sanitized message) in a module store. `handleSdkError` reads the store when it receives an `ApiError` with statusCode 500, empty response and message "HTTP 500 error". It prints `API error: <code>: <sanitized message>`. The helper is applied in both client factories (`src/utils/auth.ts` getAuthenticatedClient, `src/utils/sdk-client.ts` getCodemieClient). The captured raw error is also logged with `logger.debug` through `sanitizeLogArgs`. It relies on axios being deduped to a single copy (1.18.1 today). No SDK private fields are used.

## Acceptance criteria
1. Unit: `handleSdkError` with a captured error `code: ERR_FR_TOO_MANY_REDIRECTS` and the SDK-shaped ApiError prints output containing that code and not "HTTP 500". This is the first failing test.
2. SDK-level: a real `CodeMieClient` (cookie construction as in the SSO path) against a local server that 302-redirects to itself fails. `handleSdkError` output contains `ERR_FR_TOO_MANY_REDIRECTS` and not "HTTP 500".
3. With nothing captured, the output stays exactly "API error: HTTP 500 error". A real HTTP 500 that has a response is unchanged.
4. The store entry is cleared once it is read. A capture never leaks into an unrelated later error. Only errors with no `response` are captured.
5. Printed and logged text contains no URLs, headers, cookies or tokens (sanitized).
6. The `handleSdkError(error: unknown, operation: string): never` signature is unchanged, and the 9 command files are not edited.
7. The 401/403, 404, Zod and generic branches keep their current behavior (the existing 401 test passes).
8. Tests use Vitest (`npx vitest run --project unit <file>`). Code follows the project rules: ES modules, `.js` extensions, `@/` alias, project error classes, `logger.debug`, no `console.log`.
9. (Review finding 1, stale capture) The capture store is cleared at the start of every request, in addition to clear-on-read. A test proves a capture left unread by an earlier request is not attached to a later, unrelated empty-body HTTP 500, which still prints "API error: HTTP 500 error".
10. (Review finding 2, single axios copy) A test proves the repo's `axios` and the SDK's `axios` resolve to the same module, and that a client built after the install uses the wrapped adapter. Whether `axios.create()` copies `defaults.adapter` at creation is verified and recorded in the plan. When the install has no effect (for example a second axios copy), a `logger.debug` entry says so. The output then stays "API error: HTTP 500 error".
11. (Review finding 3, one install point) The install is idempotent and has a single shared entry point that both client factories (`getAuthenticatedClient`, `getCodemieClient`) call before constructing `CodeMieClient`. Tests go through each factory (not by installing the helper themselves) and show the capture works for a client built by each.
12. (Adapter shape) The plan checks how axios 1.x exposes `defaults.adapter`. It may be an array of adapter names, not a function. If so, the wrapper resolves it with `axios.getAdapter` rather than wrapping the value directly. A test covers the default adapter shape.

## Non-goals
- Changing the SDK in node_modules.
- Auth-proxy and CONNECT-tunnel handling.
- Fixing the JWT branch of `src/utils/auth.ts`, which passes `external_token` and throws "auth_server_url and auth_realm_name are required" in this SDK version (separate defect).
- A generic "no HTTP response received" fallback wording (heuristic-only).
- Reaching into SDK private interceptors or clients.
- Editing `.codemie/codemie-cli.config.json`.

## Decisions
- Capture through a wrapper over public `axios.defaults.adapter` over reaching into SDK private interceptors or a heuristic only in `handleSdkError` — user.
- Without a capture, keep "API error: HTTP 500 error" over new generic wording — user.
- Output format is `API error: <code>: <sanitized message>`, chosen over printing the full axios error.
- The helper lives in `src/utils/` and is applied in both client factories over patching only one.
- Add a `logger.debug` of the sanitized raw captured error over staying silent — user.
- Clear the store on read and capture only errors with no `response`, to limit stale or concurrent mismatches.

## Open risks
- A second axios copy on a future install (the SDK pins 1.15.0) makes the capture go empty, and the message reverts to "HTTP 500 error".
- With concurrent requests, "latest error" can mismatch the failing call. Mitigation: match the ApiError shape and clear on read.
- The CLI-level repro of the exact message needs SSO credentials, so the SDK-level test stands in for it.
- The JWT-branch defect remains.
