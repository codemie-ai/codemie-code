# Security checklist outcome — EPMCDME-15411 / EPMCDME-16519

**This is a CRITICAL change** (`.ai-run/guides/security/security-practices.md:18-69`): the *derivation
source* of `X-CodeMie-Project` / `X-CodeMie-Integration` changes from the single shared global
`workspace` identity to the identity of the global profile in use. The PR needs a security-review sign-off.

Self-assessment against the reviewer checklist (`:65-69`):

- [x] **Single injector.** `header-injection.plugin.ts` is unchanged and remains the only injector. It
  still reads `config.codeMieProject` / integration; no competing injection path was added. The
  launcher, the proxy commands and Desktop telemetry only change *which stored profile record* feeds
  `config.codeMieProject`.
- [x] **Auditable derivation.** The value comes from the user's own config file
  (`profiles[name].codeMieProject`, chosen in `codemie setup` or the one-time launch prompt) via one
  resolver, `ConfigLoader.resolveProfileIdentity()`. No OS introspection, no heuristics.
- [x] **No normalization.** Project and integration values pass through unchanged. Control characters
  are stripped only from *display* text (prompt, banner, warning), never from the header value.
- [x] **Logging.** No new log line prints header values, tokens or cookies. The launch prompt logs
  failures by message only (`logger.debug`), the JWT project step never logs the token.
- [x] **Tests: present / absent / not leaked.** Per-profile project resolution and export
  (`config-per-profile-identity.test.ts`), `none` exports no project/URL/integration (AC6), `own`
  ignores inherited `CODEMIE_PROJECT` / integration (AC7, `launch-identity.test.ts`), unowned keeps the
  shared fallback and warns (AC5). Existing header-injection tests are unchanged and pass.
- [x] **No new PII surface.** No identifier is added to URLs or file names.

Additional outcomes required by the spec (Security section):

- **Inherited identity removed from the child environment** for `own`/`none` (`CODEMIE_PROJECT`,
  `CODEMIE_URL`, `CODEMIE_INTEGRATION_ID/ALIAS`, `CODEMIE_SYNC_API_URL`) — `finalizeLaunchIdentity()`;
  `load()` ignores `CODEMIE_URL` / `CODEMIE_INTEGRATION_*` for those states. Verified on a real launch:
  an `own` profile billed its own project with `CODEMIE_PROJECT=wrong-inherited` exported.
- **`CODEMIE_PROJECT_BINDING` is output-only**: written by the launcher (inherited value cleared first),
  read by banner/evidence; never read by `load()`.
- **No credential sent to a foreign host**:
  - *Which credentials, to which API:* `resolveProjectListAuth()` decides this.
    - ai-run-sso uses only the cookie stored for the profile's own `baseUrl`, with no fallback to the
      shared URL.
    - bearer-auth sends the token only to `ensureApiBase(baseUrl)`.
    - Subscription profiles look up the analytics login stored under the profile's resolved CodeMie
      URL, and send it to the API it was issued with: its stored `apiUrl`, else that URL. The lookup
      by URL is the only control here. A compare-with-itself origin check that could never reject
      was removed (PR #758 review, finding 4).
    - Tests: `codemie-auth-helpers.test.ts`. The AC11 case, a JWT on host A with the shared URL on
      host B, makes no request to B.
  - *Redirects:* `HTTPClient` drops `Cookie`, `Authorization` and `Proxy-Authorization`, and ignores
    `Set-Cookie`, on any redirect hop to a different origin (scheme, host or port). This covers every
    `getRaw` caller: the launch project list, the JWT setup lookup and the integrations fetch
    (PR #758 review, finding 1).
    - Tests: `http-client.redirect.test.ts`. A real server returns 302 to a second server, which
      receives no credentials.
    - Change in behaviour: a deployment that redirects authenticated API calls to another origin now
      gets 401 instead of forwarding the credentials.
- **JWT token at setup**: taken from the chosen env var or pasted once (hidden `password` prompt), sent
  only to the URL typed in the same setup run, never stored or logged (`selectJwtProfileProject()`).

Open for the backend owner (unchanged from the spec's Risks): whether a missing `X-CodeMie-Integration`
changes billing or the LiteLLM key, whether the backend verifies project membership for
`X-CodeMie-Project`, and whether fallback sessions may send `project_source: none`.
