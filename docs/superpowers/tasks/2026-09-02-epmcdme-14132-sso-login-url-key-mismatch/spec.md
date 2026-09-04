# EPMCDME-14132 — Consolidate SSO credential storage-key normalization

## Problem

`codemie proxy connect desktop` fails with `No SSO credentials found for profile 'default'` and suggests:

```
codemie profile login --url https://codemie.lab.epam.com/code-assistant-api
```

That command reports `SSO authentication successful / Credentials stored securely`, but the proxy still fails with the same error. Only `codemie profile status` followed by re-authentication resolves it. Following the CLI's own advice can never work.

## Root cause

Credential storage-key asymmetry between the write and read paths:

| Path | Location | Key derived from |
|---|---|---|
| Write | `sso.auth.ts:136` — `storeSSOCredentials(credentials, this.codeMieUrl)` | raw URL |
| Read | `sso.auth.ts:183` — `retrieveSSOCredentials(normalizeToBase(url))` | protocol + host |

`CredentialStore.getUrlStorageKey` (`src/utils/security.ts:303`) only lowercased the URL and stripped a trailing slash, so the URL **path** stayed part of the SHA-256 input. A URL containing `/code-assistant-api` therefore wrote a key no lookup could read.

`profile status` recovered because its re-auth path `promptForReauth` (`sso.setup-steps.ts:289`) passes `config.codeMieUrl`, which carries no API path and hashes to the key the lookup reads.

Two open PRs already fix this:

- **#525** (`1b836521`, Anton Yeromin) — normalizes inside `getUrlStorageKey`. +17/−3, one file.
- **#506** (`1c5bf84a`, Nikolay Sulimov) — normalizes at the caller in `sso.auth.ts` store + clear. +3/−2.

#506 is functionally subsumed by #525. Neither has tests.

## Scope

**In scope**

- #525's storage-boundary normalization
- #506's explanatory call-site comment in `sso.auth.ts`
- The regression tests neither PR has

**Out of scope**

- #506's caller-level normalization code — redundant once the chokepoint is fixed
- The missing-`codeMieUrl` gap: profiles without `codeMieUrl` hard-fail `profile refresh` (`profile/auth.ts:124`), `promptForReauth` (`sso.setup-steps.ts:289`) and `proxy connect --claude-desktop` (`connect-orchestrator.ts:631`), leaving those users no recovery path at all. Separate ticket.
- Documentation. `docs/AUTHENTICATION.md:272-277` already documents both URL forms as equivalent, so the fix restores code to an already-documented contract.

## Design

Normalize the URL to `protocol//host` inside `getUrlStorageKey` before hashing, with a `try/catch` fallback to the previous lowercase-and-trim behaviour for strings that do not parse as URLs.

This is a single chokepoint every caller passes through, so SSO store, retrieve and clear agree on one key regardless of path. It also subsumes a second asymmetry: logout cleared the raw key (`sso.auth.ts:212`) while credential expiry cleared the normalized one (`:200`).

The JWT namespace (`storeJWTCredentials` / `retrieveJWTCredentials` / `clearJWTCredentials`) shares `getUrlStorageKey` and normalizes at no extra cost. `storeJWTCredentials` currently has zero call sites, so this is inert today, but it prevents a future JWT writer reintroducing the mismatch.

## Test strategy

The primary failure mode is a **false green**, not a wrong fix. `keytar` is a real dependency that resolves at runtime, and `retrieveSSOCredentials` consults the real OS keychain *before* the file store. `CREDENTIALS_DIR` and `FALLBACK_FILE` are computed at module import, so `setupTestIsolation()` cannot redirect them — though the vitest project config sets `CODEMIE_HOME` before import, which does isolate the file store. A stale keychain entry from an interrupted run can therefore make the bug test pass against unfixed code.

Mitigation: mock `keytar` with an in-memory map in the test file, making the tests deterministic and keychain-independent.

Three tests:

1. **Key invariant** — storing under a `/code-assistant-api` URL and under the bare base URL produces the same storage key, asserted by one file appearing in `CREDENTIALS_DIR` rather than two. Storage-medium independent.
2. **Ticket regression** — credentials stored via a path-bearing URL are retrievable through `getStoredCredentials()`. This is the reported bug.
3. **Clear symmetry** — `clearStoredCredentials(apiUrl)` removes credentials stored under the bare base URL, guarding the logout-vs-expiry asymmetry.

## Verification already performed

The bug reproduces on `origin/main` @ `1d5cc22b`. Applying `1b836521`, reverting, and re-applying produced **2 failed → 3 passed → 2 failed** — an A/B/A control isolating the patch as the only variable and ruling out a stale keychain entry.

## Acceptance criteria

- `profile login` with a path-bearing `--url` stores credentials `proxy connect desktop` can use immediately.
- Storage and lookup behaviour is consistent across `profile login`, `profile status` and `proxy connect desktop`.
- No regression in existing SSO login, profile status, profile refresh or proxy connection flows.
- Platform-independent: the credential code has no platform-specific branch, so macOS verification satisfies the ticket's Windows PowerShell criterion.

## Attribution

`1b836521` is cherry-picked, preserving Anton Yeromin's authorship in git history. The commit carrying the call-site comment and the tests credits Nikolay Sulimov via a `Co-authored-by` trailer.
