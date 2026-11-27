# Technical Research

**Task**: mcp oauth token persistence codemie-mcp-proxy McpOAuthProvider stdio-http-bridge src/mcp/auth
**Generated**: 2026-11-17
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16983 (Bug): codemie-mcp-proxy: MCP OAuth tokens are not persisted to disk, forcing re-authorization on every session start.

Summary: `codemie-mcp-proxy` keeps MCP OAuth tokens in memory only. Each new proxy process (spawned per MCP server, per session start) starts with no token, gets a 401, and opens a browser authorization page - up to 3 windows per server with Claude Code, and the MCP server often fails with `CONNECT_TIMEOUT`.

Root cause (confirmed on main @ HEAD): `McpOAuthProvider` (`src/mcp/auth/mcp-oauth-provider.ts`) states "All state is memory-only (no persistent storage)" (line 5); `_clientInfo`/`_tokens` are plain instance fields (lines 29-30), and `clientInformation()`/`saveClientInformation()`/`tokens()`/`saveTokens()` (lines 65-81) are synchronous with no I/O. No `src/mcp/auth/mcp-token-store.ts` (or equivalent disk-backed store) exists on `main`.

Candidate fix already drafted: community PR #708 implements this - a new encrypted disk-backed `mcp-token-store.ts` keyed per full server URL, with changes to `mcp-oauth-provider.ts` and `stdio-http-bridge.ts` to load/save via it. PR #708 is open and unmerged.

Steps to reproduce: (1) Configure two MCP servers as `codemie-mcp-proxy` stdio wrappers in `.mcp.json`. (2) Start Claude Code, complete browser authorization for both. (3) Exit and restart Claude Code. (4) Observe: both servers re-open browser authorization windows instead of reusing the prior token.

Suggested fix: Land (or adapt) PR #708 to persist OAuth tokens/client info to disk, keyed per server URL.

Reference: GitHub issue https://github.com/codemie-ai/codemie-code/issues/643
Acceptance criteria: none on the ticket.
(Full ticket text also saved at C:/code/codemie-dev/docs/stories/2026-11-17-EPMCDME-16983-mcp-oauth-tokens-not-persisted/ticket.md)

---

## 2. Codebase Findings

Repo `codemie-code` v0.16.9, branch `main` == `origin/main` at `7f28135e` (2026-11-16). TypeScript/ESM, Node >=20, Vitest.

### Existing Implementations

**Purpose A: "A restarted proxy reuses the earlier OAuth login instead of opening the browser."** Already implemented on `main`, landed by commit `623aa8a8` "fix(proxy): reliable MCP OAuth login sequence and optional login persistence (#678)", 2026-11-09, released in v0.16.7 (tags v0.16.7/8/9 contain it; CHANGELOG.md:90 "MCP OAuth login runs in a reliable sequence, with optional login persistence"). The ticket and issue #643 (0.15.x reports) predate it; issue #643 is still OPEN.
- `src/mcp/auth/token-store.ts:81` `loadPersistedLogin(resource: URL)` / `:118` `persistLogin` / `:158` `forgetPersistedLogin`. Per-endpoint file `~/.codemie/mcp-auth/<sha256(resource.href)[0:16]>.enc`; dir `0700`, file `0600`; content AES-256-GCM via `deriveMachineEncryptionKey/encryptWithKey/decryptWithKey` (`src/utils/credential-crypto.ts`); atomic write (`<path>.<pid>.tmp` + `renameSync`); `FILE_VERSION = 3`; `EXPIRY_SKEW_MS = 60_000`. Payload: access token, token_type, scope, obtainedAt, expiresAt, refresh_token + client registration (`client`). Not written when there is neither `expires_in` nor a refresh token (`:122`). Load returns undefined (and deletes file) when expired and not renewable (`:94-97`); any read/decrypt error returns undefined (`:112`). Kill switch: `MCP_PROXY_PERSIST_TOKENS=off` (`:60`).
- `src/mcp/auth/mcp-oauth-provider.ts:37` constructor takes `serverUrl?: URL` (memory-only when omitted); `:106` `applyTokens` splits refresh token into `_grant` and persists on every `saveTokens`/refresh; `:119` `restorePersistedLogin()`; `:128` `tokenNeedsRenewal()`; `:149` `renewSilently()` (discovery + `refreshAuthorization`, an `OAuthError` forgets the persisted file, other errors keep it); `:215-225` `invalidateCredentials` (`'all'` deletes persisted file; `'client'`/`'tokens'` do not touch disk). `restorePersistedLogin` does NOT restore `_clientInfo`; the client registration lives only inside `_grant` and is used for refresh. A new interactive login re-registers a client.
- `src/mcp/stdio-http-bridge.ts:105` passes `this.serverUrl` (URL) to the provider; `:176-189` on first message calls `restorePersistedLogin()`, then `renewSilently()` if `tokenNeedsRenewal()`, else discards the token, then `ensureCallbackServer()`; `:281-300` `cookieFetch` renews before sending an expired token and on a 401 from the endpoint URL (`isEndpointRequest`, `:328`) before the SDK sees the 401; `:346-370` `reauthenticate()` shares one attempt across concurrent requests (refresh first, browser second).
- Rules applied: key = full `resource.href` (not host-only, so servers sharing a host with different paths get separate files); one file per endpoint ("one writer per file", `token-store.ts:8-11`); the PKCE verifier stays memory-only (`mcp-oauth-provider.ts:199-205`).

**Purpose B: "Only one browser login at a time across sibling proxies" (concurrency).**
- `src/mcp/auth/auth-lock.ts:77` `acquireAuthLock()`: `~/.codemie/mcp-auth.lock`, exclusive-create (`'wx'`), JSON `{pid, createdAt}`, 250 ms poll, stale if PID dead or older than 150 s, best-effort give-up after 90 s (`DEFAULT_MAX_WAIT_MS`), release only removes own-pid lock. Taken in `mcp-oauth-provider.ts:190-193` (`redirectToAuthorization`) and released in `waitForAuthorizationCode` finally / `dispose` (`:239-262`).
- `src/mcp/auth/callback-server.ts:33,94` ephemeral localhost server, 120 s timeout, `preferredPort` reuse so a registered redirect URI stays valid within one process (`mcp-oauth-provider.ts:76-77`, `:173-185` `prepareReauthentication`). New process = new `_callbackPort` (undefined at start).

**Purpose C: "Encrypted secret at rest under ~/.codemie" (convention source).** `src/utils/security.ts:200` `CredentialStore` (keytar primary, `~/.codemie/.credentials.enc` fallback, `0600`) and `src/utils/credential-crypto.ts` (machine-derived key = sha256(hostname+platform+arch)). `token-store.ts` reuses the crypto primitives but not `CredentialStore` (see Decisions).

**Purpose D: documentation of the behaviour.** `docs/AUTHENTICATION.md:~312-345` (login flow, lock file, `~/.codemie/mcp-auth`, `0700/0600`, `MCP_PROXY_PERSIST_TOKENS`, machine-key caveat).

**Other touched code**: `bin/codemie-mcp-proxy.js` (entry; boot logger; `package.json` bin `codemie-mcp-proxy`), `src/mcp/proxy-logger.ts` (file log `~/.codemie/logs/mcp-proxy.log`, enabled by `CODEMIE_DEBUG`/`MCP_PROXY_DEBUG`; uses `homedir()` directly, not `getCodemieHome()`), `src/mcp/constants.ts`.

### Decisions Already in the Code
- Persist per endpoint, file-per-resource, rather than one shared file or `CredentialStore` entry — `token-store.ts:8-11`; alternative: single store keyed by host (SSO `deriveUrlStorageKey`, `credential-crypto.ts` host-only key); reason recorded in header (each gateway endpoint demands its own login; one writer per file avoids cross-proxy overwrite).
- Machine-bound AES-256-GCM, explicitly "not a protection against another process as the same user" — `token-store.ts:12-18`; alternative: keytar keychain via `CredentialStore` (what `security-practices.md:86-106` mandates: "Use `CredentialStore` for all persistent secret storage"). Deviation from the guide is not recorded as such; reason stated: unattended per-process read, file portability protection.
- Refresh handled by the provider, not the SDK ("SDK rethrows a refused refresh instead of falling back to a login") — `mcp-oauth-provider.ts:33-36`.
- Convention for paths: `getCodemieHome()` (`src/utils/paths.ts:367`, honors `CODEMIE_HOME`); AGENTS.md pitfall list says `getCodemiePath()` (`paths.ts:385`). `token-store.ts:65` and `auth-lock.ts:78` use `join(getCodemieHome(), ...)`. Test config sets `CODEMIE_HOME` to a temp dir (`vitest.config.ts:12-31`).
- Sync fs API in the provider: `OAuthClientProvider.tokens()`/`saveTokens()` stay synchronous (`mcp-oauth-provider.ts:92-100`); persistence uses `readFileSync`/`writeFileSync`. PR #708 changes these to async.
- Data direction: SDK needs `clientInformation()`; persisted client registration is stored inside the renewal grant and not surfaced to `clientInformation()` (`restorePersistedLogin`, `:119-125`).

### Task Statements Checked Against the Code
- "McpOAuthProvider states 'All state is memory-only (no persistent storage)' (line 5)" — **contradicted**: header now reads "The login (tokens, plus the refresh token and the client it was issued to) is also persisted per endpoint, see token-store.ts" (`mcp-oauth-provider.ts:3-5`).
- "`_clientInfo`/`_tokens` plain fields (lines 29-30); `tokens()`/`saveTokens()` etc. synchronous with no I/O (lines 65-81)" — **partly holds**: `_clientInfo`/`_tokens` are still plain fields (`:45-46`) and the four SDK methods are still synchronous, but `saveTokens` -> `applyTokens` calls `persistLogin` (`:106-117`), and `restorePersistedLogin` loads (`:119`). Line numbers in the ticket do not match HEAD.
- "No `mcp-token-store.ts` (or equivalent disk-backed store) exists on main" — **contradicted**: `src/mcp/auth/token-store.ts` (164 lines) exists since `623aa8a8`; only the filename differs from PR #708's.
- "Confirmed on main @ HEAD" — **contradicted** for local HEAD `7f28135e` (post-#678). Reported versions in issue #643 are 0.15.4-0.15.9, before the fix. Whether the symptom still reproduces on 0.16.7+ is **unverified** (needs a manual run with two stdio servers; this analysis did not run it).
- "PR #708 is open and unmerged; implements keyed-per-full-URL encrypted store" — **holds** (gh: state OPEN, `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, base `main`, last activity 2026-11-05, bot AUTO_CLOSE_WARNING 2026-11-13: auto-close no earlier than 2026-11-19). PR adds `mcp-token-store.ts` at `~/.codemie/credentials/mcp-<sha256(url)>.enc` (no `0600`/`0700` modes, no atomic write, no expiry, no refresh-token handling, makes provider methods async, `serverUrl` passed as string). It **keeps in place** nothing new but would **duplicate** purpose A's `token-store.ts` and write a second file location for the same login (consumers below).
- PR #708 review (collaborator, 2026-11-05, on the PR): saved client registration reused with a new callback port can make a later login fail; says "PR #678 handles the same case (`preferredPort` ... `prepareReauthentication`)". The review itself shows #678 predates and overlaps #708.
- "Up to 3 windows per server with Claude Code, `CONNECT_TIMEOUT`" — **unverified** (client behaviour outside this repo; issue text says Claude Code restarts the proxy after a version-probe timeout). In-repo mitigation for simultaneous logins is `auth-lock.ts`; the 90 s lock wait is bounded below the 120 s callback timeout (`auth-lock.ts:22-26`).
- "Acceptance criteria: none" — nothing to check.

### Consumers of Changed Contracts
Contracts the ticket's suggested fix (adopting PR #708) would change: `McpOAuthProvider` constructor argument type, sync -> async SDK provider methods, and the on-disk location/format of the login.
- `new McpOAuthProvider(this.serverUrl)` — `stdio-http-bridge.ts:105` (URL today; #708 passes a string).
- `tokens()` sync reads — `stdio-http-bridge.ts:335` (`withCurrentToken`), `mcp-oauth-provider.ts` internal `tokenNeedsRenewal` uses `_tokens` directly. A Promise-returning `tokens()` would break `withCurrentToken`.
- `invalidateCredentials(...)` — `mcp-oauth-provider.ts:173-185` (`prepareReauthentication` calls `'client'`) and the SDK.
- Persisted file: read/written only by `token-store.ts`; also encrypted-format dependency on `credential-crypto.ts` (`decryptWithKey` also consumed by the statusline bundle, `credential-crypto.ts:1-17` warns about keeping it import-free).
- Tests: `src/mcp/__tests__/mcp-auth.test.ts` (`new McpOAuthProvider()` without URL, synchronous assertions at `:131-166`, `:177-215`); `mcp-bridge-logger.test.ts:198-203` mocks `restorePersistedLogin`/`tokenNeedsRenewal`.
- Docs referencing the current store: `docs/AUTHENTICATION.md` (~`:321-340`).
- Existing users with `~/.codemie/mcp-auth/*.enc` (v3 format): would be orphaned by a different path/format (searched: no migration code).

### Architecture and Layers Affected
MCP proxy sub-system only: bin entry -> `StdioHttpBridge` (transport/bridge) -> `McpOAuthProvider` (auth provider) -> `token-store.ts` (persistence) + `auth-lock.ts` (cross-process coordination) + `callback-server.ts`. Outside the five-layer plugin architecture used by agents/providers; no registry/plugin involvement. `mcp-auth.plugin.ts` (SSO proxy URL rewriting) is a different component and does not store tokens.

### Integration Points
- `@modelcontextprotocol/client` (`auth`, `UnauthorizedError`, `StreamableHTTPClientTransport`, `refreshAuthorization`, `discoverOAuthServerInfo`, `selectResourceURL`, `OAuthError`).
- `~/.codemie/mcp-auth/` (tokens), `~/.codemie/mcp-auth.lock`, `~/.codemie/logs/mcp-proxy.log`.
- External: the real MCP gateway's OAuth endpoints; MCP clients (Claude Code etc.) spawning one proxy per server.

### Patterns and Conventions
- Module-level functions, no singleton, in `src/mcp/auth/`; best-effort I/O that never throws into the auth flow; `proxyLog`/`logger.debug` for diagnostics; ESM `.js` import suffixes; env kill-switch variable `MCP_PROXY_*`.
- Secrets: `sanitizeLogArgs` for logs (AGENTS.md); `token-store.ts` logs only URL and validity minutes, no token values.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md:86-106,244-255`: use `CredentialStore`; `0600` for credential files; no plaintext tokens.
- `docs/AUTHENTICATION.md` MCP section documents the existing persistence, lock and env var (already up to date with `token-store.ts`).
- `.ai-run/guides/integration/external-integrations.md:181` lists only the MCP Auth Plugin (not the token store). `openwiki/integrations/mcp-and-desktop-clients.md:39` cites `mcp-auth.test.ts`.

### Architectural Decisions
None recorded as ADRs. Header comments of `token-store.ts` and `auth-lock.ts` are the only rationale. CHANGELOG.md:90 records #678.

### Derived Conventions
Per-endpoint hashed `.enc` files under a `~/.codemie` subdirectory with `0700/0600` and atomic rename; synchronous fs in provider path.

---

## 4. Testing Landscape

### Existing Coverage
- `src/mcp/__tests__/mcp-auth.test.ts` (304 lines): `startCallbackServer`, provider metadata/storage round trip, `invalidateCredentials` scoping, callback lifecycle; provider built without `serverUrl` (memory-only), header still says "in-memory".
- `src/mcp/__tests__/mcp-bridge-logger.test.ts` (462 lines): proxy logger and bridge wiring with the provider fully mocked.

### Testing Framework and Patterns
Vitest, `globals: true`, `src/**/*.test.ts` in the `unit` project; `CODEMIE_HOME` forced to a per-process temp dir (`vitest.config.ts`); `vi.hoisted` mocks; `child_process.execFile` mocked for browser launch; temp HOME dirs. Guide: `.ai-run/guides/testing/testing-patterns.md`. AGENTS.md: tests only on explicit request.

### Coverage Gaps
No test file references `token-store`, `persistLogin`, `loadPersistedLogin`, `forgetPersistedLogin`, `renewSilently`, `restorePersistedLogin` (provider side), `auth-lock`, or `MCP_PROXY_PERSIST_TOKENS` (grep across repo: only source, docs, and the two mock lines in `mcp-bridge-logger.test.ts:202-203`). Bridge reauthenticate/renew paths (`stdio-http-bridge.ts:281-370`) uncovered (mocked out). No multi-process concurrency test.

---

## 5. Configuration and Environment

### Environment Variables
- `MCP_PROXY_PERSIST_TOKENS` (`off` disables read and write), `MCP_CLIENT_NAME` (DCR `client_name`), `MCP_PROXY_DEBUG`/`CODEMIE_DEBUG` (file logging), `CODEMIE_HOME` (base directory override).

### Configuration Files
None; behaviour is env-driven. Paths: `~/.codemie/mcp-auth/*.enc`, `~/.codemie/mcp-auth.lock`.

### Feature Flags and Deployment Concerns
Persistence is on by default; `proxy-logger.ts` and `bin/codemie-mcp-proxy.js` log under `homedir()/.codemie/logs` ignoring `CODEMIE_HOME`. Key is machine-derived (hostname+platform+arch): a hostname change makes files undecryptable, which falls back to a fresh login (`token-store.ts:112`). No keytar, so no OS-keychain prompt. Release cadence is frequent (0.16.9 on 2026-11-16).

---

## 6. Risk Indicators

- The ticket's stated root cause and "no store exists on main" do not match `main`; persistence shipped in v0.16.7 (#678). The work item as written targets an already-fixed defect (task_context statements checked in Section 2).
- Speculative: if the symptom still reproduces on >= 0.16.7, the cause lies elsewhere than "no persistence"; candidates visible in code: `persistLogin` skipping writes when the server returns neither `expires_in` nor a refresh token (`token-store.ts:122-125`); `loadPersistedLogin` discarding expired non-renewable tokens (`:94-97`); `renewSilently` deleting the file on any `OAuthError` (`mcp-oauth-provider.ts:171-174`); a hostname/arch change making files undecryptable; `MCP_PROXY_PERSIST_TOKENS=off`; the user running an old global install. Needs a reproduction with `MCP_PROXY_DEBUG=true` log (`[mcp-proxy][tokens]` lines).
- Adopting PR #708 as written would add a second token store (`~/.codemie/credentials/mcp-<hash>.enc`, not `0600`, no refresh handling) alongside `token-store.ts` for the same purpose (Purpose A), a conflicting merge state (`CONFLICTING`) against #678's changes in the same three files, and sync -> async changes to provider methods consumed at `stdio-http-bridge.ts:335`.
- PR #708 auto-close window: no earlier than 2026-11-19; issue #643 stays open on GitHub.
- Test coverage of the existing persistence and lock is absent (Section 4); any behaviour change rests on no regression net, and `mcp-auth.test.ts` header still describes the provider as in-memory.
- Deviation from the `security-practices.md` rule ("use `CredentialStore`") exists in `token-store.ts` without a recorded reason in the guide; machine key is not a secret (acknowledged in `token-store.ts:15-18`).
- Cross-process: file-per-endpoint write is atomic by rename, but read-modify-write of refresh tokens across two proxies for the SAME endpoint (e.g. restarted proxy overlapping an old one) has no lock; refresh-token rotation by the server could invalidate the sibling's grant (`renewSilently` -> forget file on `OAuthError`).
- Windows: `chmodSync` modes are largely no-ops; permission claims in docs hold on POSIX only.

---

## 7. Summary for Complexity Assessment

The code path the ticket describes (proxy bridge -> `McpOAuthProvider` -> disk) already persists the OAuth login on `main`: `src/mcp/auth/token-store.ts` (encrypted, per-endpoint, `0700/0600`, atomic write, refresh-token renewal, kill switch `MCP_PROXY_PERSIST_TOKENS`) and `auth-lock.ts` (cross-process login serialization) shipped in #678 / v0.16.7 (2026-11-09), and `stdio-http-bridge.ts` already restores, renews silently and re-authenticates in place. The ticket's root cause, line references, and "no store exists" claim are contradicted by HEAD (`7f28135e`, v0.16.9); the reports in issue #643 are against 0.15.x. The layers involved would be the MCP proxy bridge, auth provider, and the persistence module only.

Candidate PR #708 is open, in conflicting state, and implements an overlapping and less complete store in a different location; merging it would duplicate rather than add the capability. Whether any residual reproduction exists on current versions is unverified.

Test posture: the persistence, renewal and lock code have no unit tests; the existing auth tests exercise the memory-only provider and the callback server, and bridge tests mock the provider. Technical novelty is low (existing patterns), but the ticket's premise needs resolution before sizing: the scope ranges from "no code change, verify and close" to "tests/hardening of existing persistence", depending on a reproduction that has not been done.

---

## 8. External References

None named by the task as a path. Named external URLs were consulted via `gh` (read-only):
- https://github.com/codemie-ai/codemie-code/issues/643 — OPEN; reported on 0.15.9 (also 0.15.4/6/7); symptoms: 401 on every session start, 2-3 windows per server because Claude Code restarts the proxy after a version-probe timeout, `CONNECT_TIMEOUT`. Collaborator comment 2026-11-06: "added to our backlog" (before #678 merged on 2026-11-09). No later comment.
- PR #708 (branch `fix/mcp-oauth-token-persistence-643`): OPEN, `CONFLICTING`/`DIRTY`, files: `src/mcp/__tests__/mcp-auth.test.ts`, `src/mcp/auth/mcp-oauth-provider.ts`, `src/mcp/auth/mcp-token-store.ts` (new), `src/mcp/stdio-http-bridge.ts`; its PR text claims 48/48 vitest passing and manual verification on a pre-#678 build. Not in this checkout; read via `gh pr diff 708`.
