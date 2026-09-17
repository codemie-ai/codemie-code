# Technical Research

**Task**: sso credentials proxy auth (EPMCDME-14132)
**Generated**: 2026-09-02
**Research path**: filesystem (codegraph MCP not available in this environment)

---

## 1. Original Context

https://jiraeu.epam.com/browse/EPMCDME-14132

TITLE: CodeMie CLI: suggested profile login command does not resolve missing SSO credentials for proxy connect desktop
TYPE: Bug | PRIORITY: Major | STATUS: Ready for dev

SUMMARY: When `codemie proxy connect desktop` cannot find SSO credentials for the active `default` profile, it suggests running `codemie profile login --url https://codemie.lab.epam.com/code-assistant-api`. That command completes successfully and reports "Credentials stored securely". However, running `codemie proxy connect desktop` again still fails with the same "No SSO credentials found" error. The issue is resolved only after running `codemie profile status` and completing the re-authentication/refresh flow from there.

STEPS TO REPRODUCE:
1. `codemie proxy connect desktop` -> error: "No SSO credentials found for profile 'default'. Run: codemie profile login --url https://codemie.lab.epam.com/code-assistant-api"
2. Run the suggested command, complete browser SSO -> "SSO authentication successful / Credentials stored securely"
3. `codemie proxy connect desktop` -> SAME error still shown
4. `codemie profile status`, confirm re-authentication when prompted
5. `codemie proxy connect desktop` -> proxy starts successfully

EXPECTED: After successful `profile login --url ...`, credentials should be available for the active profile and `proxy connect desktop` should start. Alternatively, if profile login is not sufficient, the CLI should suggest the correct command.

ACCEPTANCE CRITERIA:
- `codemie profile login --url <apiUrl>` stores/refreshes SSO credentials so `proxy connect desktop` can use them immediately for the active profile.
- If profile login is not the correct recovery command, `proxy connect desktop` displays an accurate recovery instruction.
- After successful SSO auth, `proxy connect desktop` no longer reports missing SSO credentials for the same active profile.
- Credential storage and lookup behavior is consistent between `profile login`, `profile status`, and `proxy connect desktop`.
- Verified on Windows PowerShell with the `default` profile.
- No regression for existing SSO login, profile status, profile refresh, or proxy connection flows.

---

## 2. Codebase Findings

### 2.0 Root-cause chain — CONFIRMED

The prior-session hypothesis is confirmed in full. Exact evidence:

**Write path (raw URL).** `src/providers/plugins/sso/sso.auth.ts:136`

```ts
await store.storeSSOCredentials(credentials, this.codeMieUrl);
```

`this.codeMieUrl` is assigned from `config.codeMieUrl` at `sso.auth.ts:80` — for `profile login --url <X>` that is the verbatim `--url` flag value (`src/cli/commands/profile/auth.ts:64`: `const codeMieUrl = url || config.codeMieUrl;`).

**Read path (normalized URL).** `src/providers/plugins/sso/sso.auth.ts:31-38`

```ts
function normalizeToBase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}
```

Applied at `sso.auth.ts:181` (`const baseUrl = normalizeToBase(url);`) and consumed by the retrieve call at `sso.auth.ts:183`.
*Correction to prior notes: the `retrieveSSOCredentials` call is at :183; :181 is the `normalizeToBase` assignment.*

**Storage key (no path stripping).** `src/utils/security.ts:303-312`

```ts
private getUrlStorageKey(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '').toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sso-${hash}`;
}
```

Lowercase + trailing-slash strip only. **The path is part of the SHA-256 input.**

**Empirically verified on the dev machine** (Thread C): `~/.codemie/credentials/sso-cb66bf94….enc` = `sha256("https://codemie.lab.epam.com")`, while `sha256("https://codemie.lab.epam.com/code-assistant-api")` → `sso-986c4ba1…`, a file nothing ever reads.

**Why `profile status` recovers.** `promptForReauth` at `src/providers/plugins/sso/sso.setup-steps.ts:288` reads `config.codeMieUrl` **only** (bails at :289-292 if absent) — the portal root, path-free — so its write key equals the read key.

**Why the suggestion is self-defeating.** `src/cli/commands/proxy/connect-orchestrator.ts:234-243`

```ts
export async function verifySsoCredentials(baseUrl: string, profileName: string): Promise<void> {
```
```ts
console.error(chalk.red(`✗ No SSO credentials found for profile '${profileName}'.`));
console.error(`  Run: codemie profile login --url ${baseUrl}`);
process.exit(1);
```

The `baseUrl` interpolated into the *write* suggestion is the same path-bearing `config.baseUrl` that just failed the *read*. Call sites: `connect-orchestrator.ts:648` and `src/cli/commands/proxy/index.ts:152`, both `verifySsoCredentials(config.baseUrl, profile)`.

**Documented intent already matches the fix, code diverges.** `docs/AUTHENTICATION.md:270-277` promises the root and `/code-assistant-api` URL forms are "equivalent and safe". `openwiki/concepts/configuration-and-local-state.md:99` states storage is "keyed by a hash of the **normalized** base URL". Both describe behavior the code does not implement.

### 2.1 CRITICAL — a fix for this bug already exists on a remote branch

`1b836521 fix(utils): normalize URL to host before hashing credential storage key` (Anton_Yeromin, 2026-09-02 10:07 +0200) exists **only** on `remotes/origin/fix/sso-credential-url-normalization`; it is **not** an ancestor of HEAD. Its commit message is a near-verbatim restatement of EPMCDME-14132. It changes only `src/utils/security.ts` (+17/-3): parses with `new URL()`, keys on `${protocol}//${host}`, falls back to the old lowercase/trailing-slash behavior on parse failure, adds a why-comment.

**It ships no tests and no documentation updates**, both of which the repo guides require. This must be resolved by the caller before any implementation work begins — the options are to extend that branch, or to supersede it. Duplicating it silently is the worst outcome.

### 2.2 Existing Implementations

| File | Role |
|---|---|
| `src/utils/security.ts` | `CredentialStore` singleton; `getUrlStorageKey` (:303); SSO store/retrieve/clear (:314/:337/:372); JWT variants (:400/:432/:485); AES-256-GCM crypto (:511-544) |
| `src/providers/plugins/sso/sso.auth.ts` | `CodeMieSSO`; sole SSO **write** (:136); sole SSO **read** `getStoredCredentials` (:174-205); `normalizeToBase` (:31-38) |
| `src/cli/commands/proxy/connect-orchestrator.ts` | `verifySsoCredentials` (:234-248); config resolution (:184, :207, :627-628); call site (:648) |
| `src/cli/commands/proxy/index.ts` | `proxy start` guard (:152); deprecated `proxy connect desktop` alias (:325-343) |
| `src/cli/commands/profile/auth.ts` | `handleLogin` (:61-99), `handleLogout` (:101-117), `handleRefresh` (:119-135) |
| `src/providers/plugins/sso/sso.setup-steps.ts` | `validateAuth` (:223), `promptForReauth` (:268-311), `getAuthStatus` (:320) |
| `src/utils/config.ts` | `ConfigLoader`; workspace flattening (:135-136); split-on-write (:562-591) |
| `src/env/types.ts` | `ProviderProfile` (:51-98), `WorkspaceConfig` (:105-144), `MultiProviderConfig` (:176-184), `LegacyConfig` (:149-171) |
| `src/migrations/007-decouple-provider-workspace-config.migration.ts` | Moved `codeMieUrl` into `workspace`; template for any new migration |
| `src/providers/core/codemie-auth-helpers.ts` | `ensureApiBase` (:22-28) — the *opposite* normalization (appends the path) |

### 2.3 Architecture and Layers Affected

Guide-mandated flow is `CLI → Registry → Plugin → Core → Utils` (`.ai-run/guides/architecture/architecture.md`), never skipping or reversing.

- **Utils** — `src/utils/security.ts` (`CredentialStore`, the key-derivation choke point), `src/utils/config.ts`
- **Plugin (SSO)** — `src/providers/plugins/sso/{sso.auth.ts, sso.setup-steps.ts, sso.models.ts, sso.health.ts, proxy/sso.proxy.ts}`
- **Core** — `src/providers/core/codemie-auth-helpers.ts`, `auth-validation.ts`
- **CLI** — `src/cli/commands/{proxy,profile,doctor,skills,hook}`
- **Cross-cutting** — `src/migrations/` (startup), `src/telemetry/runtime/`

`src/utils/security.ts` currently imports nothing from `providers/` except `providers/core/types.js`. A fix inside `getUrlStorageKey` respects the layering; importing `normalizeToBase` from the SSO plugin into Utils would **reverse** it and violate the guide.

### 2.4 Complete caller inventory (research question 2)

**Writers** — `storeSSOCredentials`:

| Location | URL expression | Form |
|---|---|---|
| `sso.auth.ts:136` | `this.codeMieUrl` ← `config.codeMieUrl` / `--url` | **RAW** |

That is the **only** SSO writer in `src/`. `storeJWTCredentials` (`security.ts:402`) has **zero call sites** anywhere in `src/` or `tests/` — a dead writer.

**Readers** — every SSO read funnels through `sso.auth.ts:174-205`, which normalizes internally at :181, so all lookup keys are already protocol+host. The URL each caller hands in:

| Location | URL expression | Shape handed in |
|---|---|---|
| `connect-orchestrator.ts:238` | `baseUrl` ← `config.baseUrl` | **API URL, path-bearing** |
| `sso.proxy.ts:91` | `this.config.targetApiUrl` | API URL, path-bearing |
| `sso.proxy.ts:105` | `this.config.syncCodeMieUrl` | portal |
| `sso.setup-steps.ts:232`, `:322` | `config.codeMieUrl \|\| config.baseUrl` | portal, falls back to API URL |
| `sso.health.ts:62` | `config.codeMieUrl` | portal |
| `sso.models.ts:62`, `:83`, `:113` | ctor arg / `codeMieUrl \|\| baseUrl` | mixed |
| `sdk-client.ts:57`, `require-auth.ts:34`, `skills-search-client.ts:142` | `config.codeMieUrl \|\| config.baseUrl` | mixed |
| `skills-metrics.ts:370`, `managed-mcp-remote.ts:133`, `test-metrics.ts:97` | portal-derived | portal |
| `inspect-desktop.ts:128`, `DesktopTelemetryRuntime.ts:216` | `syncCodeMieUrl \|\| targetApiUrl` | portal or API URL |
| `hook.ts:425,532,978,1236` | `getConfigValue('CODEMIE_URL', config)` | portal |
| 10 agent plugin `*.models.ts` / `*.incremental-sync.ts` | `env.CODEMIE_URL` | portal |

**Direct `CredentialStore` reads that bypass `normalizeToBase` entirely** (RAW, path-bearing):

| Location | Method | URL |
|---|---|---|
| `sso.proxy.ts:759` | `retrieveJWTCredentials` | `this.config.targetApiUrl` |
| `JWTAuthCheck.ts:39`, `:67` | `retrieveJWTCredentials` | `config.baseUrl` |

**Clear path**:

| Location | URL | Form |
|---|---|---|
| `sso.auth.ts:200` (expiry eviction) | `baseUrl` (normalized) | NORMALIZED |
| `sso.auth.ts:212` (`clearStoredCredentials`) | caller-supplied | **RAW** |
| ← `profile/auth.ts:106-109` (`logout`) | `config.codeMieUrl \|\| config.baseUrl` | RAW |
| ← `profile/auth.ts:132` (`refresh`) | `config.codeMieUrl` | RAW |

### 2.5 Every write/read asymmetry found (not just the reported one)

1. **Primary (EPMCDME-14132)** — write `sso.auth.ts:136` RAW vs read `sso.auth.ts:181-183` NORMALIZED.
2. **Self-defeating suggestions** — `connect-orchestrator.ts:241`, `sso.setup-steps.ts:237`, `sso.proxy.ts:95-97` all interpolate a *lookup* URL into a *write* command. (Safe variants: `sso.proxy.ts:108-110` uses the portal URL; `sso.health.ts:68` and `profile/auth.ts:67` use no path-bearing URL.)
3. **Logout can miss** — `sso.auth.ts:212` clears RAW while the expiry path clears NORMALIZED; when `codeMieUrl` is unset, `logout` clears the path-bearing key and leaves the real credential in place.
4. **Global-fallback is unreachable** — writes with a URL never populate the global `sso-credentials` slot (`security.ts:318`), yet reads fall back to it (`sso.auth.ts:187`). Nothing in `src/` performs a no-URL write, so this fallback only ever matches legacy blobs.
5. **JWT namespace has readers but no writer** — identical latent key bug, currently inert.
6. **`codeMieUrl` vs `baseUrl` inconsistency** — `promptForReauth` uses `config.codeMieUrl` only (`setup-steps.ts:288`) while `validateAuth`/`getAuthStatus`/`sdk-client`/`require-auth` use `config.codeMieUrl || config.baseUrl`, so validation can evaluate a different key than re-auth writes.

### 2.6 Config shape and `workspace.codeMieUrl` (research question 4)

**Yes, ConfigLoader flattens.** `src/utils/config.ts:135-136`:

```ts
const workspace = await this.resolveWorkspace(workingDir);
Object.assign(config, this.removeUndefined(workspace));
```

`resolveWorkspace` (:209-221) is a whole-object override (local `workspace` if non-null, else global, else `{}`). The returned type is `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig` (`src/env/types.ts:206`). **Consumers therefore read the flat `config.codeMieUrl`, never `profile.workspace.codeMieUrl`** — the reads at `sso.setup-steps.ts:288` and `profile/auth.ts:124-134` are correct as written and need no change. The inverse split on write is `splitProfileAndWorkspace` + `WORKSPACE_KEYS` (:562-591), used by `saveProfile` (:594-616).

Three config shapes exist in the wild: v1 flat legacy; v2 with `codeMieUrl` per-profile (pre-migration-007); v2 with `workspace.codeMieUrl` (post-007).

**If `codeMieUrl` is undefined for a profile**, these hard-fail:
- `profile refresh` — `profile/auth.ts:124-128`, "❌ Not configured for SSO authentication"
- `promptForReauth` — `sso.setup-steps.ts:289-292`, "✗ No CodeMie URL configured"
- `proxy connect --claude-desktop` — `connect-orchestrator.ts:631-636`, "Selected profile is missing CodeMie URL"

while `validateAuth`, `getAuthStatus`, `sdk-client`, `require-auth`, `skills-search-client` silently degrade to `config.baseUrl` — i.e. exactly the path-bearing form. So a `codeMieUrl`-less profile is *both* unable to recover via `status`/`refresh` *and* routed onto the broken key. Confirms and extends the prior hypothesis.

### 2.7 Integration Points

- `keytar@^7.9.0` (non-optional dependency), OS keychain service `codemie-code`, account `sso-<sha256>`
- Encrypted file store `~/.codemie/credentials/sso-<sha256>.enc`; legacy global `~/.codemie/sso-credentials.enc`
- Proxy daemon (`src/providers/plugins/sso/proxy/`) re-reads `CredentialStore` at runtime (`sso.proxy.ts:757-758`)
- `codemie-sdk` via `src/utils/sdk-client.ts:57`; telemetry runtime; doctor checks; 10 agent plugins reading `env.CODEMIE_URL`

### 2.8 Patterns and Conventions the fix must follow

- `CredentialStore` is a private-constructor singleton (`security.ts:288-301`) — always `getInstance()`. `getUrlStorageKey` is `private`, so a change inside it is invisible to all callers.
- `CodeMieSSO` is instantiated behind dynamic `await import(...)` at `connect-orchestrator.ts:236`, `sso.proxy.ts:89`, `require-auth.ts:32` for test mockability — preserve that shape or existing `vi.mock` suites break.
- Error style: `chalk.red('✗ …')` + indented `  Run: …` + `process.exit(1)`; orchestrator failures throw `ConfigurationError` through `printProxyError`; setup-steps return `{ valid: false, error }` rather than throwing.
- Migrations: one file per change, zero-padded `id` matching the filename, `MigrationRegistry.register(new X())` at module scope, added to `src/migrations/index.ts`, idempotent, returns `{ success, migrated }`.
- `.js` import extensions, explicit return types on exports, single quotes, `logger.debug`/`logger.success` (never `console.log`), `sanitizeLogArgs()` before logging.

---

## 3. Documentation Findings

### Guides and Architecture Docs

| Guide | Relevance |
|---|---|
| `.ai-run/guides/security/security-practices.md` | Highest. "Use `CredentialStore` (singleton) for all persistent secret storage. Never store tokens in plaintext files." Documents the `store/retrieve/delete` API contract the fix must keep intact. "Always sanitize before logging." File-permission table: `~/.codemie/` `0o700`, credentials `0o600`. |
| `.ai-run/guides/quality-gates.md` | Defines the merge gate. Lint: "even one warning fails the gate." Unit tests: "**Skip if**: never." Full CI: "**Skip if**: never before merge." |
| `.ai-run/guides/architecture/architecture.md` | "`CLI → Registry → Plugin → Core → Utils` — never skip layers, never reverse direction." Utils "does **not** contain business logic or plugin specifics." |
| `.ai-run/guides/standards/git-workflow.md` | Branch `EPMCDME-<NNNN>` (current branch conforms). Conventional Commits; valid scopes include `utils`, `providers`, `cli`, `proxy` — `sso` and `security` are **not** valid. Ticket goes in the body footer, not the subject. Squash-and-Merge. Review checklist mandates "**Public docs / READMEs updated when behavior changes.**" |
| `.ai-run/guides/development/development-practices.md` | Specific error classes, `createErrorContext()`, `formatErrorForUser()`; never expose internals or log tokens. |
| `.ai-run/guides/standards/code-quality.md` | "Comment the *why*, not the *what*"; explicit return types; no `console.log`. |
| `.ai-run/guides/usage/project-config.md` | Precedence `CLI args > Env > Project > Global > Defaults`, so `--url` outranks the profile URL. Precedent for normalization-based URL comparison: "Apply that project-context overlay only when the global and local CodeMie URLs match **after normalization**." |
| `.ai-run/guides/testing/testing-patterns.md` | See §4. |

**One caveat for the security reviewer**: security-practices.md contains "**Do not silently normalize** (hash, truncate, hex-prefix) an identifier the server may treat as authoritative." That rule is scoped to *attribution headers and the `user` body field*, not to the local storage key — but a reviewer may raise it. State explicitly in the PR that the normalization is local-storage-key only and never reaches the wire.

### Architectural Decisions

- **No ADR directory exists in this repo** (confirmed by `find`, and corroborated by three prior technical-analysis artifacts under `docs/superpowers/tasks/`).
- Closest recorded decision on URL identity: `src/migrations/007-…:5-11` — "`codeMieUrl` … always sourced from a single profile together, never mixed across profiles", establishing `codeMieUrl`/`codeMieProject`/`codeMieIntegration` as an atomic identity trio.
- Closest recorded decision on auth UX: `docs/superpowers/tasks/2026-08-06-non-interactive-sso/technical-analysis.md:97` — "implicitly favors fail-fast + explicit re-run over in-flow interactive prompting."
- Reinforcing precedent: `2fd6cb5f Revert "fix(proxy): handle SSO session expiry — auto-reauth …" (#325)` — a previous auto-reauth attempt in this area was **reverted**. Prefer fail-fast messaging over auto-recovery.

### Why the two URL forms exist (history)

- `51bfa731 fix: display base codemie url instead of api url for sso profiles` (Dec 2025) deliberately split `CODEMIE_URL` (portal root, display) from `CODEMIE_BASE_URL` (`/code-assistant-api`, auth validation). **This split is the origin of the asymmetry.**
- `69fabaa9 fix(cli): normalize root base-url to code-assistant-api path (#483)` (Aug 2026) added the auto-append and **shipped with a `docs/AUTHENTICATION.md` update** — project precedent that a URL-normalization fix carries a docs change.
- Per-URL keying dates to `4aafb40b`; extended to JWT by `1d141fd3 feat(providers): add JWT Bearer Authorization provider (#152)`.
- No CHANGELOG file exists; history is git log plus `chore: bump version` commits. HEAD is `1d5cc22b chore: bump version to 0.15.0`.

### Inline decision comments (highest-value finds)

- `sso.auth.ts:27-31` — JSDoc on `normalizeToBase`: "Normalize URL to base (protocol + host). E.g., https://host.com/path -> https://host.com"
- `sso.auth.ts:184-196` — records the global fallback and its origin check
- `security.ts:302-311` — JSDoc on `getUrlStorageKey` says only "Generate a storage key for a given base URL" and **never mentions normalization**. The silent divergence from `sso.auth.ts:33` is the bug.
- `sso.models.ts:45-47` — "Required because SSO credentials are stored per-URL" — clearest statement of per-URL design intent
- `AgentCLI.ts:228-232` — rationale for the *opposite* normalization; worth citing in the PR to show the two are separate concerns
- `security.ts:534` — "Legacy CBC format … (backward compat for existing stored credentials)" — precedent that this file already carries a back-compat read path

### Docs needing update

- `docs/AUTHENTICATION.md` (L38, L97 show `--url` with the bare portal URL; L270-277 promise both forms are equivalent) — **yes**, should state that `--url` accepts either form and both resolve to one credential entry.
- `docs/COMMANDS.md` (L594, L1283 `profile login [--url]`; L210-240 `proxy connect desktop` prerequisites; L197 troubleshooting) — **yes, light**; the prerequisite list omits that credentials must exist for the profile's URL.
- `openwiki/**` — **no**, generated, and already documents the fixed behavior.

---

## 4. Testing Landscape

### Existing Coverage

| File | Covers | vitest project |
|---|---|---|
| `tests/integration/sso-per-url-credentials.test.ts` | 20 tests: per-URL store/retrieve/clear, global fallback + URL-match guard, `validateAuth`/`getAuthStatus`, expiry auto-clear, multi-profile | cli |
| `tests/integration/sso-login-url-key-mismatch.test.ts` | EPMCDME-14132 repro — **untracked** (`git status` → `??`) | cli |
| `src/utils/__tests__/security.test.ts` | `sanitize*` helpers only — **zero `CredentialStore` tests** | unit |
| `src/providers/plugins/sso/__tests__/sso.auth.test.ts` | `deriveExpiresAt` only (3 tests) | unit |
| `src/providers/core/__tests__/codemie-auth-helpers.test.ts` | `ensureApiBase` — closest sibling to the bug | unit |
| `src/providers/core/__tests__/auth-validation.test.ts` | `promptForReauth` **dispatch** against a fake setupSteps object | unit |
| `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` | flag→target mapping; `verifySsoCredentials` is `vi.fn()`-mocked at :19 | unit |
| `src/cli/commands/proxy/__tests__/index.test.ts:117-121` | **Asserts the buggy suggestion string verbatim**: `'  Run: codemie profile login --url https://codemie.lab.epam.com/code-assistant-api'` | unit |
| `tests/integration/cli-commands/profile.test.ts` | 2 smoke tests only; **no login/status/refresh coverage** | cli |

### Answer to research question 5 — would storage-boundary normalization break `sso-per-url-credentials.test.ts`?

**No. Zero assertions break.** Every `storeSSOCredentials` call in that file passes either no URL or `TEST_BASE_URL_1`/`TEST_BASE_URL_2` (lines 39-40), which are already protocol+host only — normalization is a no-op on them. The path-bearing `TEST_API_URL_1/2` (lines 41-42) appear only inside credential *payloads* and in `getStoredCredentials` *lookups*, never as a storage key.

Three tests look at-risk but actually *depend on* normalization already happening one layer up, and stay green:
- `:205` `getStoredCredentials(TEST_API_URL_1)` → `:207` `expect(retrieved).not.toBeNull()`
- `:219` `getStoredCredentials(\`${TEST_BASE_URL_1}/\`)` → `:221` not-null
- `:232` `getStoredCredentials(\`${TEST_BASE_URL_1}/some/path\`)` → `:234` not-null — **this test already encodes the intended post-fix behavior**

The only URL-separation assertion, `:173` `expect(retrieved).toBeNull()`, separates two different **hosts**, which normalization preserves.

### The untracked reproduction test

68 lines, 3 tests, uses the real `CredentialStore` + `CodeMieSSO` with `setupTestIsolation()`, cleans both keys in `afterEach`. Correctly placed for the `cli` project.
- `:41` "finds credentials after login with the URL the proxy error suggests" — **RED**
- `:51` "leaves the stored credentials unreachable by any lookup URL" — **RED**
- `:60` control, stores under `BASE_URL` — **GREEN**

Verdict: a valid executable reproduction. Two caveats: tests 1 and 2 are near-duplicates (2 subsumes 1); and `loginStoresUnder()` is a hand-rolled stand-in for `CodeMieSSO.authenticate()` rather than the real code path — so it **will** catch a regression if the fix lands in `getUrlStorageKey`, but **not** if the fix lands at `sso.auth.ts:136`. (Not executed during this research.)

### Testing Framework and Patterns

Single `vitest.config.ts`, three `defineProject` entries, no workspace file:
- **unit** — `src/**/*.test.ts`; `globals: true`, node, 30s timeouts, `isolate: true`; the only project with a coverage block
- **cli** — `tests/integration/**/*.test.ts` minus `agent-*`; 30s test / **10s hook** timeout; `sequence.groupOrder: 1`
- **agent** — `tests/integration/agent-*.test.ts`; real network; 180s/300s timeouts; **no `globals: true`**

All three share `env: { CODEMIE_HOME: join(tmpdir(), \`codemie-test-home-${process.pid}\`) }` and the `@` → `/src` alias.

Mandatory conventions from `.ai-run/guides/testing/testing-patterns.md`:
- Location: `src/[module]/__tests__/*.test.ts` for unit, `tests/integration/*.test.ts` for integration; naming `[feature].test.ts`
- ":180 — Integration tests use real dependencies (file system, config) and no mocking unless testing external services."
- ":72 — Import the module under test **inside the test body or inside `beforeEach`** using dynamic `import()`, AFTER the spy is set up. Static imports are cached before `beforeEach` runs and bypass spies."
- ":100 — lazy-getter rule: a static field initialised from a path utility at class-load time cannot be intercepted by a `beforeEach` spy. **Directly applicable to `CREDENTIALS_DIR`.**
- ":145 — Never hardcode POSIX-style path or `file://` URL literals in test expectations."
- Coverage: 80%+ overall, **90%+ for `src/utils/`** and core logic
- **TDD / RED-first is not mandated by this guide** (no "RED"/"TDD" text in it). Separately, `AGENTS.md` states "Only write or run tests when the user explicitly asks for it" — this is in tension with quality-gates.md and the 90% `src/utils/` bar; **the caller should resolve which governs.**

Where a new test belongs: a key-derivation test → **unit**, `src/utils/__tests__/` (also where the 90% bar applies); an end-to-end store-then-retrieve → **cli**, `tests/integration/`.

### Coverage Gaps

- `security.ts:303-312` `getUrlStorageKey` — **zero direct tests**, and `private`, so only reachable via the public API
- `security.ts:314-334`/`:337-370`/`:372-397` — SSO store/retrieve/clear have **no unit tests**; violates the 90% `src/utils/` bar
- `security.ts:400-508` — JWT variants carry the identical latent bug; covered only by a stubbed `getInstance`
- `sso.auth.ts:31-38` `normalizeToBase` — not exported, no direct test
- `sso.auth.ts:136` — the write line. **Completely untested**; no test invokes `CodeMieSSO.authenticate()` (it opens a browser + local HTTP server)
- `sso.auth.ts:174-205` `getStoredCredentials` — integration-only; fallback/URL-match/expiry branches (:186-202) untested
- `connect-orchestrator.ts:234-248` `verifySsoCredentials` — **never executed by any test**; `connect-wiring.test.ts:19` replaces it with `vi.fn()`
- `profile/auth.ts:61-135` — `handleLogin`, `handleLogout`, `handleRefresh` all untested
- `sso.setup-steps.ts:268-311` real `promptForReauth` — untested

---

## 5. Configuration and Environment

### Configuration Files

| Path | Governs |
|---|---|
| `~/.codemie/codemie-cli.config.json` | Global v2 config: profiles, activeProfile, workspace |
| `<cwd>/.codemie/codemie-cli.config.json` | Project-local override, same schema |
| `~/.codemie/migrations.json` | Migration history (`src/migrations/tracker.ts:13`) |
| `~/.codemie/credentials/sso-<sha256>.enc` | Per-URL SSO credential (the bug's artifact) |
| `~/.codemie/credentials/jwt-sso-<sha256>.enc`, `jwt-credentials.enc` | JWT variants |
| `~/.codemie/sso-credentials.enc` | Legacy/global no-URL SSO fallback |
| `~/.codemie/proxy-daemon.json` | Daemon state (`targetUrl`, `syncCodeMieUrl`, `profile`) |

### Environment Variables

| Var | Purpose | Location |
|---|---|---|
| `CODEMIE_HOME` | Relocates the entire CodeMie home, hence **all credential paths** | `src/utils/paths.ts:356-361` |
| `CODEMIE_URL` | Sets `codeMieUrl` — the lookup URL for most callers | `src/utils/config.ts:441` |
| `CODEMIE_BASE_URL` | Sets `baseUrl` — **the value `proxy connect` hands to the lookup** | `src/utils/config.ts:418-419` |
| `CODEMIE_DEBUG` | Gates SSO HTTP logging | `src/utils/config.ts:430-432` |
| `CODEMIE_AUTH_METHOD` | Auth method override | `src/utils/config.ts:442` |
| `CODEMIE_JWT_TOKEN` | JWT bearer for the proxy | `sso.proxy.ts` |
| `CODEMIE_INSECURE` | Disables TLS verification | `sdk-client.ts:92`, `auth.ts:39` |

**No env var disables keytar, and none overrides the credential storage key or directory other than `CODEMIE_HOME`.** Note that `CODEMIE_URL` and `CODEMIE_BASE_URL` are independent and different callers pick different ones — this feeds the bug.

### Credential Backend

Keytar-first, **always-also-file** (not fallback-only on write). `security.ts:256-259`:

```ts
const SERVICE_NAME = 'codemie-code';
const ACCOUNT_NAME = 'sso-credentials';
const FALLBACK_FILE = getCodemiePath('sso-credentials.enc');
const CREDENTIALS_DIR = getCodemiePath('credentials');
```

Keytar load failure is a **dynamic-import catch only** (`security.ts:265-278`), cached per process — no platform check, no kill switch. Individual keytar calls are additionally try/catch-swallowed, so a keychain that loads but throws (locked vault, ACL) silently degrades to file. Encryption is AES-256-GCM with a legacy-CBC read path; the key is `sha256(hostname + platform + arch)` (:540-544) — **renaming the machine invalidates every stored credential.**

### Windows / PowerShell (research question 7)

**Windows is not a special case for this bug.** No `win32` branch exists in `security.ts`, `paths.ts`, or `config.ts`; credentials go to `%USERPROFILE%\.codemie\credentials\sso-<hash>.enc` exactly as on POSIX. `USERPROFILE`/`APPDATA` are never read for credential paths (only by proxy connectors: `vscode.ts:72-75`, `codex-desktop.ts:62-64`, `desktop.ts:713`). The only Windows branch in the SSO path is browser launch (`sso.auth.ts:113-119`, uses `explorer.exe` to avoid WDAC/AppLocker failures) — storage is unaffected.

The one Windows-relevant risk: `keytar` is a plain non-optional dependency with no prebuild pinning here; `scripts/postinstall.mjs` and `install/windows/install.ps1` do nothing for keytar/node-gyp. If keytar failed to build on a user's Windows box, the `.enc` file is the **sole** store — so any migration or compat path must rewrite the file, not just the vault entry. No documented Windows keytar caveat exists in `README.md` or `docs/`.

### Deployment and Release

Published to npm as `@codemieai/code` v0.15.0, installed globally (`npm install -g`), plus GUI/script installers. 15 minor releases shipped. Every installed user has a `~/.codemie/credentials/sso-<sha256>.enc` plus a matching keychain entry under service `codemie-code`. See §6 for why this is nonetheless low-risk.

---

## 6. Risk Indicators

**R1 — Duplicate work already exists on `origin/fix/sso-credential-url-normalization` (commit `1b836521`).** Not an ancestor of HEAD. Changes only `src/utils/security.ts` (+17/-3), ships **no tests and no docs**, both required by `.ai-run/guides/quality-gates.md` and the git-workflow review checklist. **Must be resolved by the caller before implementation.** Highest-priority risk in this analysis.

**R2 — Blast radius of normalizing in `getUrlStorageKey`: assessed as effectively nil for SSO, but this contradicts a surface-level reading.** Threads A and C disagreed; resolving on the write-path evidence:
- The **only** SSO writer is `sso.auth.ts:136`. Existing stored keys therefore derive from either (a) a path-free portal URL, for which old key `baseUrl.replace(/\/$/,'').toLowerCase()` and new key `${protocol}//${host}` are **byte-identical**, or (b) an explicit path-bearing `--url`, whose credentials are **already unreadable** — that is the bug.
- All SSO reads already normalize at `sso.auth.ts:181`, so no reader's key changes.
- Conclusion: **no existing SSO user is silently logged out.** Thread C's "logs out the entire installed base" is not supported by the writer enumeration.
- Residual uncertainty worth one verification pass: a stored credential whose URL had a path *and* whose profile also matched it in some legacy flow. Cheap insurance is a read-time legacy-key fallback in `retrieveSSOCredentials` rather than a full migration.

**R3 — If a migration is chosen anyway, `src/migrations/runner.ts:63-72` records skipped migrations as applied**, so a migration running before the user's first login is marked done and never re-runs. A key-rewrite migration must therefore not be the *only* compat path. No existing migration touches credentials — this would be the first, and it would need to rewrite both the `.enc` file and the keytar account.

**R4 — JWT namespace carries the identical latent bug and would change keys.** `retrieveJWTCredentials` at `sso.proxy.ts:759` and `JWTAuthCheck.ts:39,67` read with raw path-bearing URLs and **never** normalize; `storeJWTCredentials` (`security.ts:402`) has **zero call sites**. Changing the shared `getUrlStorageKey` is a no-op today, but the fix must consciously decide whether JWT normalizes too, or a future JWT writer will silently re-introduce the mismatch.

**R5 — Three self-defeating error messages, not one.** `connect-orchestrator.ts:241`, `sso.setup-steps.ts:237`, `sso.proxy.ts:95-97`. Acceptance criterion 2 ("displays an accurate recovery instruction") is not satisfied by fixing storage alone if the messages are left inconsistent. Note `src/cli/commands/proxy/__tests__/index.test.ts:117-121` **asserts the current path-bearing string verbatim** and must be updated if the message changes.

**R6 — Test-suite isolation is broken for credential tests, creating a false-green risk during verification.** `FALLBACK_FILE` and `CREDENTIALS_DIR` (`security.ts:258-259`) are module-level consts frozen at import time, so `setupTestIsolation()`'s `beforeAll` mutation of `CODEMIE_HOME` arrives too late; files actually land in the vitest-level `${tmpdir}/codemie-test-home-${pid}/credentials`, **shared across every file in the `cli` project**. This is exactly the failure mode `testing-patterns.md:100-109` warns about. Compounding it: **keytar is not mocked anywhere in the repo**, `node_modules/keytar` is installed, and retrieval tries the keychain **first** (`security.ts:345-356`) — so a stale real-OS-keychain entry from an earlier run can mask a file-store miss and make a broken fix look green.

**R7 — `~/.codemie/credentials/*.enc` is written with no explicit mode.** `security.ts:548-552` calls `fs.writeFile` without `{ mode: 0o600 }`; observed on disk as `-rw-r--r--` (0644) with `drwxr-xr-x` on the directory. `.ai-run/guides/security/security-practices.md` mandates `0o700`/`0o600`. Pre-existing and out of scope, but a security reviewer touching this file will see it.

**R8 — Zero test coverage on every line the fix touches.** `getUrlStorageKey`, `normalizeToBase`, `sso.auth.ts:136`, `verifySsoCredentials`, `handleLogin`/`handleLogout`/`handleRefresh`, real `promptForReauth` — none are executed by any test. `src/utils/` is held to a 90% bar by the testing guide. Any regression here is invisible to CI today.

**R9 — Logout asymmetry is a latent second bug.** `sso.auth.ts:212` clears with a RAW URL while `sso.auth.ts:200` clears NORMALIZED. Post-fix, logout begins clearing the same key the reader uses — a behavior *improvement* that nonetheless broadens what `logout` deletes and should be covered by acceptance criterion 6 ("no regression").

**R10 — `codeMieUrl`-less profiles are unrecoverable by design.** `profile refresh` (`profile/auth.ts:124`), `promptForReauth` (`setup-steps.ts:289`), and `proxy connect --claude-desktop` (`connect-orchestrator.ts:631`) all hard-fail, while five other call sites silently fall back to the path-bearing `config.baseUrl`. Users in this state cannot use the `profile status` workaround the ticket describes.

**R11 — Governance tension on tests.** `AGENTS.md`: "Only write or run tests when the user explicitly asks for it" vs `quality-gates.md`: unit tests "**Skip if**: never". The caller must decide which governs before the implementation phase commits to a test plan.

**R12 — Docs must ship with the fix.** `docs/AUTHENTICATION.md:270-277` already *promises* the post-fix behavior, so the code is what diverges. Repo precedent (`69fabaa9`) is that URL-normalization fixes carry a docs update, and the git-workflow review checklist requires "Public docs / READMEs updated when behavior changes."

**R13 — Orphan test directories.** `tests/unit/**` (3 files) and `tests/skills/pattern-invocation.test.ts` match **no** vitest project glob and are never executed by `test:unit`, `test:integration`, `test:all`, or `ci`. Do not place new tests there.

**R14 — Machine-identity-derived encryption key.** `sha256(hostname + platform + arch)` (`security.ts:540-544`) means a hostname change invalidates all stored credentials. Unrelated to this bug but a confounder when reproducing "credentials vanished" reports.

### Quality gate (must pass before merge)

```
npm run license-check
npm run lint
npm run build
npm run test:unit
npm run test:integration
```

Equivalently `npm run ci`; before pushing, `npm run ci:full` (= `commitlint:last && ci`). Husky additionally runs `lint-staged` (eslint `--max-warnings=0` **and `vitest related --run`**), `typecheck`, and `validate:secrets` (Docker-gated) on commit. Note `quality-gates.md` documents stale command *bodies* (`vitest run src`); the `npm run` **names** are correct.

---

## 7. Summary for Complexity Assessment

**Layers and change surface.** The defect is a single-line key-derivation asymmetry in the Utils layer: `getUrlStorageKey` (`src/utils/security.ts:303-312`) hashes the full URL including its path, while every SSO reader first strips the path via `normalizeToBase` (`src/providers/plugins/sso/sso.auth.ts:31-38`). The minimal correct fix is confined to one private method in one file — a proof point being that a colleague's already-pushed branch implements exactly that in +17/-3 lines. However, the acceptance criteria reach past storage into error-message UX (three self-defeating "run `profile login --url <lookupUrl>`" strings at `connect-orchestrator.ts:241`, `sso.setup-steps.ts:237`, `sso.proxy.ts:95-97`), into a snapshot-style test that asserts the current buggy string verbatim (`src/cli/commands/proxy/__tests__/index.test.ts:117-121`), and into documentation (`docs/AUTHENTICATION.md`, `docs/COMMANDS.md`) that the repo's own review checklist and its `69fabaa9` precedent require updating. Realistic surface: **1 source file for the core fix, 2-4 more if the messages are harmonized, 1-2 test files, 2 doc files.** Architecturally the fix is well-placed — `security.ts` is the single choke point every caller funnels through, and fixing it there resolves all six enumerated asymmetries at once, whereas fixing at call sites would not.

**Technical novelty and risk.** Low novelty: the codebase already contains the exact normalization logic (`normalizeToBase`), already documents the fixed behavior as the intended contract (`docs/AUTHENTICATION.md:270-277`, `openwiki/concepts/configuration-and-local-state.md:99`), and already carries a backward-compat read path in the same file (`security.ts:534`, legacy CBC). The single genuinely hard question — whether normalizing the storage key silently logs out the installed npm base — resolves to **no**, on the evidence that the sole SSO writer is `sso.auth.ts:136` and that for path-free portal URLs the old and new keys are byte-identical; the only keys that change belong to credentials that were already unreachable. Two research threads initially disagreed on this, so it should be re-verified rather than assumed, but a cheap read-time legacy-key fallback in `retrieveSSOCredentials` de-risks it entirely without the complexity of the repo's first-ever credential migration (which would also be undermined by `runner.ts:63-72` marking skipped migrations as applied). A secondary decision the fix cannot dodge: the JWT namespace shares `getUrlStorageKey`, has readers that never normalize, and has **no writer at all** — inert today, a re-introduced bug tomorrow.

**Test posture and scoring drivers.** The affected area is effectively **untested**: `getUrlStorageKey`, `normalizeToBase`, the write at `sso.auth.ts:136`, `verifySsoCredentials`, and all three `profile` auth handlers have zero executing coverage, against a guide-mandated 90% bar for `src/utils/`. A valid but untracked 2-RED/1-GREEN reproduction exists at `tests/integration/sso-login-url-key-mismatch.test.ts`; the sibling `sso-per-url-credentials.test.ts` was checked assertion-by-assertion and **nothing in it breaks** under storage-boundary normalization — one of its tests (`:232`) already encodes the desired post-fix behavior. Verification is the sharpest risk, not implementation: keytar is unmocked repo-wide, the real OS keychain is read *first*, and `CREDENTIALS_DIR` freezes at module-import time so `setupTestIsolation()` cannot redirect it — a stale keychain entry can make a broken fix appear green. **Complexity drivers to weigh: R1 (a competing fix already exists on a remote branch — a coordination decision, not an engineering one), R6 (false-green verification risk), R4 (JWT scope decision), R5/R12 (scope creep from the acceptance criteria into messages and docs), and R11 (an unresolved guide conflict over whether tests may be written at all).** Absent R1, this is a small, well-understood, low-blast-radius fix; R1 is what should dominate the score.
