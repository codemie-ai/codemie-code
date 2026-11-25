# EPMCDME-16983: MCP OAuth login persistence - verify, harden, make the first login finishable

## Context

The ticket says `codemie-mcp-proxy` keeps OAuth tokens in memory only. That is stale: persistence shipped in #678 (v0.16.7) as `src/mcp/auth/token-store.ts` (per-endpoint AES-256-GCM file under `~/.codemie/mcp-auth/`, 0700/0600, atomic write, refresh-token renewal) plus `auth-lock.ts` (technical-analysis.md sections 2 and 6). Verified in this checkout (v0.17.2, HEAD ae4a4584): #678 present, the four files under `src/mcp/auth/` exist, `renewSilently` is at `mcp-oauth-provider.ts:157` and called from `stdio-http-bridge.ts:183` and `:354`. Persistence is not recreated. On 2026-11-25 the user confirmed it live on 0.17.2: after one completed login a `.enc` file existed and the next start initialised in 941 ms with no browser prompt.

What still makes a user re-authorize at every session start is that the first login often never completes:

1. The callback listener gives up after a hard-coded 120 s (`src/mcp/auth/callback-server.ts:33`; the caller `mcp-oauth-provider.ts:82` passes no `timeoutMs`). The timer starts when the listener is pre-started at connect (`stdio-http-bridge.ts:191`), before the 401, the auth-lock wait and the browser opening, so the user's real time is shorter than the timeout. After it fires the browser gets `ERR_CONNECTION_REFUSED` on `/callback` and the login is lost.
2. With `MCP_CLIENT_NAME="Claude Code (jira)"` the gateway IdP showed "Insufficient Scope - scopes not allowed by IDP: claudeai". The page is the gateway's, so the proxy likely sees only a timeout. The proxy sends no `scope`. Verified: the symptom and that the default name "CodeMie CLI" logs in. Hypothesis, unconfirmed: the gateway maps client names to scopes.

## Scope

1. **Close the stale premise (recommendation only, no action taken in the repo).** Recommend closing PR #708 as superseded by #678 (second, weaker store; `CONFLICTING`; makes provider methods async) and answering issue #643 with the #678 pointer once the reporter confirms on >= 0.16.7. Record this in the PR description of this work.
2. **Configurable, longer login wait.** `MCP_PROXY_AUTH_TIMEOUT_SECONDS` accepts a decimal integer of seconds in 10..3600 (digits only, trimmed). Zero, negatives, fractions, non-numeric, empty and out-of-range values (including ones that would overflow a timer, `setTimeout` max 2^31-1 ms) fall back to the 300 s default, with a debug log. Even small accepted values (10 s) may be too short for a slow interactive login, and the real window is shorter than the setting because the clock starts at connect; the docs say so, with no startup warning. One helper in `src/mcp/constants.ts`, next to `getMcpClientName`, returns the whole set `{callbackTimeoutMs, lockMaxWaitMs, lockStaleMs}` = T, 0.75 T, 1.25 T (exact in ms for integer T, so max-wait < callback < stale holds over the whole range: 7500/10000/12500 ms at T = 10, 2.7 M/3.6 M/4.5 M ms at T = 3600, all far below the timer limit). `startCallbackServer` uses the same helper for its default instead of the `120_000` literal, and the provider passes the resolved value explicitly. `acquireAuthLock` takes an options object `{maxWaitMs, staleAfterMs}` (no second env parse in `auth-lock.ts`), and the lock file records the holder's own `staleAfterMs`, which `isStale` uses (old files without it fall back to the default stale age), so a sibling with a different setting never deletes a live lock. The 250 ms lock poll is unchanged: its overshoot of max-wait is far below the 2500 ms gap to the callback timeout at T = 10.
3. **Actionable, safe login failure.**
   - `callback-server.ts` throws two typed errors with a `code`, messages unchanged (a timeout still reads `OAuth authorization timed out after 0.25s` for 250 ms; an OAuth error still reads `OAuth error: <code> — <description>`): a timeout error carrying `timeoutMs`, and an OAuth callback error carrying `oauthError` and `description`. The existing message-format test stays valid.
   - `McpOAuthProvider.waitForAuthorizationCode` is the one place that catches them (the `Callback server closed` rejection passes through untouched), writes the hint with `console.error` (visible with debug off, as the existing browser notice at `:216`), and rethrows the original error. Timeout hint: names `MCP_PROXY_AUTH_TIMEOUT_SECONDS` and the effective `MCP_CLIENT_NAME`, and says that if the gateway page showed `insufficient_scope`, `MCP_CLIENT_NAME` is what to change. `insufficient_scope` hint: names `MCP_CLIENT_NAME` only and does not present a longer timeout as the fix. The client name shown is the stdio proxy's env, which may differ from what the SSO daemon registered.
   - The callback error page HTML-escapes the code and description, treats them as untrusted, truncates each to 200 characters, strips control characters, and is served with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`. The same sanitised text goes into the thrown error and any log line. New messages and logs never contain tokens, secrets, authorization codes, state or the callback URL. Existing bridge logging is checked, not rewritten.
   - `docs/AUTHENTICATION.md` documents the env var and its 10..3600 range (noting that even 10 s may be too short for a slow interactive login and that the real window is shorter than the setting because the clock starts at connect), the timing limitation (lock-queue time and pre-login steps come out of the window), the `insufficient_scope` symptom, and separates VERIFIED behavior from HYPOTHESES about client-name/scope mapping.
4. **Refresh-rotation race.** On an `OAuthError` refusing a refresh in `renewSilently`, peek at the persisted login through a new side-effect-free `token-store` function (never deletes, unlike `loadPersistedLogin`). If its refresh token differs from the refused one, adopt that grant with its own client information and the persisted access token and expiry (one private `seed(login)` shared with `restorePersistedLogin`, adoption enabled by a private flag only). If the adopted access token still needs renewal (same skew test as the store), renew exactly once with the adopted grant; otherwise no second refresh request. If that single retry fails: a grant-ending refusal (`OAuthError` with `invalid_grant`, `invalid_client` or `unauthorized_client`) forgets the persisted file only if its refresh token still equals the one just refused (a new `token-store` compare-then-forget; the small window between check and unlink is accepted); any other failure (network, 5xx, other `OAuthError` codes) keeps the grant and the file. Never retry twice. If the persisted token is unchanged or absent, the existing forget behavior stays. Update the `token-store.ts` "one writer per file" header. No cross-process refresh lock.
5. **Documented deviations.** The `token-store.ts` header and `docs/AUTHENTICATION.md` state that the store deliberately does not use `CredentialStore` (unattended per-process reads, no keychain prompt; `security-practices.md:86-106` says otherwise) and that 0700/0600 and the machine-bound key protect on POSIX only (`chmodSync` is largely a no-op on Windows). Persistence calls stay behind the `token-store` functions. The stale `in-memory` header of `mcp-auth.test.ts` is corrected. `.ai-run/guides/` is reported as stale (security-practices.md), not edited; the PR description names the guide maintainers as owner.
6. **Tests, written and run in this task** (explicit user request, overriding the AGENTS.md default). Vitest in `src/mcp/__tests__/`; each test sets its own temp `CODEMIE_HOME` and restores env afterwards (the config's single per-process temp path does not isolate tests from each other).
   - `token-store`: round trip, expiry skew, no write without `expires_in` or refresh token, corrupt/undecryptable file, `MCP_PROXY_PERSIST_TOKENS=off`, POSIX modes, the peek never deletes, compare-then-forget.
   - `auth-lock`: acquire/release, stale by dead PID and by age, give-up after max-wait, per-lock `staleAfterMs` read under a different env.
   - Timeout input: unset, valid, 10 and 3600 accepted; 0, 9, 3601, -1, 1.5, `abc`, empty, `Infinity`, an overflowing value rejected; ordering at both bounds (7500/10000/12500 ms at T = 10); `startCallbackServer()` default and the provider's explicit value; a delayed-auth path with fake timers (callback accepted just before the timeout, rejected after). The existing `startCallbackServer({ timeoutMs: 250 })` tests stay unchanged: that is a direct millisecond option, not a value of this env var.
   - Callback errors: typed timeout and `insufficient_scope` told apart without message matching; hint content and stderr with debug off; `Callback server closed` passes through; `<script>` and a newline in `error_description` render escaped, truncated and logged as one line.
   - Provider: restore, `tokenNeedsRenewal`, `renewSilently` success, refusal forgets, transient error keeps the grant, adoption with a valid access token makes no second request, exactly one retry, a refused retry does not unlink a newer file.
   - Two-start regression at the provider boundary: provider A persists a login, provider B on the same temp home restores it, needs no renewal and never opens a browser. A bridge-level two-start needs a live OAuth server and is not automated; manual verification is below.
   Run only the `src/mcp` tests, lint with zero warnings, and typecheck.
7. **Implementation constraints.** No commit, push, branch, PR, or Jira/GitHub action. The final report states what was verified in the actual checkout, files changed, test/lint/typecheck results, remaining risks, and the criteria needing manual verification.

## Acceptance criteria

1. `MCP_PROXY_AUTH_TIMEOUT_SECONDS` unset: the callback server waits 300 s, including a direct `startCallbackServer()` call. A valid integer in 10..3600 is honoured. Anything else (zero, negative, fraction, non-numeric, empty, out of range) falls back to 300 s.
2. For every accepted value, auth-lock max-wait < callback timeout < stale age, and no derived value exceeds the timer limit. A lock file's own recorded stale age is used by every reader.
3. Two cases. (a) A timed-out login prints a hint naming both `MCP_PROXY_AUTH_TIMEOUT_SECONDS` and the effective `MCP_CLIENT_NAME`. (b) An `insufficient_scope` callback prints a client-name action and does not present the timeout as its fix. Both appear on stderr with debug off, are told apart by error type (tests do not match message text), and contain no token, secret, code, state or callback URL.
4. The callback error page HTML-escapes, truncates (200 characters) and control-strips the code and description, and is served with the CSP and `nosniff` headers.
5. After a refusal, the persisted login is peeked without deleting. A different refresh token is adopted with its own client information; renewal runs once and only if the adopted access token needs it; a refused retry never removes a file holding a newer refresh token; a transient retry failure keeps the grant. An unchanged or absent persisted token keeps today's forget behavior.
6. An endpoint with a valid persisted login restores in a new provider without renewal or browser (automated at the provider boundary).
7. `docs/AUTHENTICATION.md` documents the env var and its 10..3600 range, the note that small values may be too short and the real window is shorter than the setting, the timing limitation, the `insufficient_scope` symptom with verified vs hypothesis separated, the `CredentialStore` deviation and the POSIX-only modes.
8. The tests in Scope 6 exist and pass in `src/mcp`; lint (zero warnings) and typecheck pass.

Manual verification (not automated): a bridge-level two-start, i.e. start the proxy against the real gateway, complete one login, restart and see no browser prompt (`MCP_PROXY_DEBUG=true`, `[mcp-proxy][tokens]` lines); and one 2-4 minute first login with the debug log, noting whether the MCP client restarts the proxy.

## Related tickets

EPMCDME-14795 (same symptom, reported on 0.14.1/Windows, Ready for dev, unlinked) has AC4 "platform secure storage (Credential Manager/Keychain/Secret Service)". This spec deliberately does not do that, so AC4 stays with 14795. Recommended, not performed: link or deduplicate 14795 and 16983 in Jira, and close PR #708 and answer issue #643.

## Non-goals

- Merging or porting PR #708, or adding a second token store.
- Moving the store to `CredentialStore`/keytar, or migrating existing `~/.codemie/mcp-auth/*.enc` files.
- Changing the gateway, its IdP scope mapping or DCR behavior; sending a `scope` param; blocking or rewriting `MCP_CLIENT_NAME` values; a startup warning on custom client names.
- Changing the MCP client's 30 s `CONNECT_TIMEOUT` or its proxy-restart behavior, or claiming the longer wait fixes it.
- Redesigning when the callback clock starts.
- Windows ACL handling (icacls).
- A cross-process lock around refresh.
- An unrelated rewrite of bridge logging.
- Any git, Jira or GitHub action (closing #708/#643 and linking 14795 are recommendations only).

## Decisions

- Callback timeout default 300 s over keeping 120 s or starting the clock at browser open — user
- Env override `MCP_PROXY_AUTH_TIMEOUT_SECONDS` over a hard-coded value — user
- Auth-lock max-wait and stale thresholds derived from the one timeout (0.75x / 1.25x) over independent constants — user
- Document the `insufficient_scope` symptom and add an actionable hint over doing nothing in code — user
- No startup warning or `MCP_CLIENT_NAME` blocklist over warning on every custom name — user
- Tests written and run in this task over deferring them — user
- Refresh-rotation race: adopt a sibling's newer persisted grant over a cross-process refresh lock or doing nothing — user, answers AR-3
- Rotation recovery peeks without deleting and renews only if the adopted token needs it, over an unconditional second renewal — user, answers AR-3
- Forget a refused grant only if the file still holds the refused token, and keep it on transient failure, over the old unconditional forget — user, answers AR-3
- Timeout input is a decimal integer in 10..3600 s, anything else falls back to 300 s, over any positive number (the lower bound was 1 in the previous round and is 10 again by the user's decision, because a 1 s setting cannot complete an interactive login) — user, answers AR-5
- Keep the callback clock armed at connect and document the shorter real window over arming it at lock acquisition — user, answers AR-6
- The client's 30 s restart behavior is a recorded out-of-scope risk with a follow-up outside this repo, over a fix or a promise here — user, answers AR-7
- HTML-escape, truncate and control-strip callback error text, with CSP and `nosniff`, over reflecting it as-is — user, answers AR-1
- Typed callback errors, with the hint composed and written to stderr in `waitForAuthorizationCode`, over matching message text — user, answers AR-2
- The lock file records the holder's stale age over each reader judging by its own setting
- One helper returns all three derived timings over separate constants in two files
- `acquireAuthLock` takes an options object over module constants
- Document the `CredentialStore` deviation over migrating the store
- Document Windows POSIX-only modes over adding icacls handling
- No client-name-to-scope mapping in the proxy over guessing gateway behavior

## Risks and assumptions

- Assumption: the gateway shows `insufficient_scope` on its own page and does not redirect it to `/callback`, so the timeout hint is the one users meet. Unconfirmed; the client-name-to-scope mapping needs gateway-side confirmation.
- If the MCP client restarts the proxy during a login (30 s `CONNECT_TIMEOUT`, issue #643), the old listener dies and the browser still gets `ERR_CONNECTION_REFUSED`. A longer wait cannot fix that and the spec does not claim to. Unverified; recommend a follow-up outside this repo.
- The clock starts at connect: a proxy queued behind siblings for up to 0.75 T (225 s) has about 0.25 T (75 s) minus pre-lock time left once its browser opens. Accepted and documented, not fixed.
- Even small accepted settings (10 s) may be too short for a slow interactive login, and the real window is shorter than the setting because the clock starts at connect. Documented, no startup warning.
- A 300 s default means a stuck login holds the shared lock longer.
- Whether the gateway rotates refresh tokens, with reuse detection, is unknown; it decides how often the race matters. Adoption cannot repair a family the gateway already revoked.
- Compare-then-forget has a small check-to-unlink window; accepted.
- The `OAuthError` code names are an assumption to confirm against the installed SDK during implementation.
- "Up to 3 windows per server" on current versions remains unverified.
