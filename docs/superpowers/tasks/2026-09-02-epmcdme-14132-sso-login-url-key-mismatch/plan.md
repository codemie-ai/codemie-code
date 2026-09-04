# EPMCDME-14132 SSO Credential Key Normalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate PRs #525 and #506 into one PR that fixes the SSO credential storage-key asymmetry and ships the regression tests neither PR has.

**Architecture:** The fix is a single chokepoint change — normalize the URL to `protocol//host` inside `CredentialStore.getUrlStorageKey` before hashing, so every caller (SSO and JWT, store/retrieve/clear) derives the same key regardless of URL path. The fix arrives by cherry-picking commit `1b836521` to preserve Anton Yeromin's authorship; the tests and a call-site comment land in a second commit crediting Nikolay Sulimov.

**Tech Stack:** TypeScript (ES modules), Vitest 4.x, keytar (OS keychain), Node crypto.

**Spec:** `docs/superpowers/tasks/2026-09-02-epmcdme-14132-sso-login-url-key-mismatch/spec.md`

## Global Constraints

- Conventional Commits, enforced by commitlint. Subject ≤ 100 chars. Allowed scopes include `utils`, `providers`, `tests`. No ticket key in the subject — reference it in the body footer.
- Pre-commit (`.husky/pre-commit`) runs `npx lint-staged` → `npm run typecheck` → `npm run validate:secrets`. `lint-staged` runs `eslint --max-warnings=0` and **`vitest related --run`** on staged `.ts` files. **A commit containing failing tests will be blocked.** RED must therefore be demonstrated by running tests *before* committing, never by committing a red test.
- A container engine must be running for `validate:secrets` (podman/docker — already up).
- Never use `--no-verify`.
- Do **not** call `setupTestIsolation()` in this test file. It assigns `CODEMIE_HOME` in `beforeAll`, which runs *after* `src/utils/security.ts` is imported and has already frozen `CREDENTIALS_DIR`/`FALLBACK_FILE` at module scope. The vitest project config already sets `CODEMIE_HOME` to a temp dir before import; using the helper would make the test inspect a different directory than the code writes to.
- Test hostnames must be unique to this file (`codemie-14132.example.com`), because the vitest `CODEMIE_HOME` is shared across files in the `cli` project.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/security.ts` | `getUrlStorageKey` — the single key-derivation chokepoint. Modified by cherry-pick only. |
| `src/providers/plugins/sso/sso.auth.ts` | Call-site comment at the store call documenting the key/lookup contract. Comment only, no behavior change. |
| `tests/integration/sso-credential-key-normalization.test.ts` | Create. The three regression tests. |
| `tests/integration/sso-login-url-key-mismatch.test.ts` | Delete (untracked scratch reproduction, superseded by the file above). |

---

### Task 1: Regression tests (RED)

**Files:**
- Create: `tests/integration/sso-credential-key-normalization.test.ts`
- Delete: `tests/integration/sso-login-url-key-mismatch.test.ts` (untracked)

**Interfaces:**
- Consumes: `CredentialStore.getInstance()`, `storeSSOCredentials(credentials, baseUrl?)`, `CodeMieSSO#getStoredCredentials(url?, allowFallback?)`, `CodeMieSSO#clearStoredCredentials(baseUrl?)`, `getCodemiePath(...paths)`, type `SSOCredentials`.
- Produces: nothing consumed by later tasks.

**Test-first: yes** — all three tests must fail against unfixed `main`: the key-invariant test sees two distinct `.enc` files instead of one; the regression test gets `null` from `getStoredCredentials`; the clear-symmetry test finds credentials still present after `clearStoredCredentials`.

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Regression tests for EPMCDME-14132 — SSO credential storage-key normalization.
 *
 * keytar is mocked with an in-memory map. retrieveSSOCredentials consults the real
 * OS keychain before the file store, so an unmocked run can pass against unfixed
 * code purely on a stale keychain entry left by an earlier run.
 *
 * setupTestIsolation() is deliberately not used: it sets CODEMIE_HOME in beforeAll,
 * after security.ts has frozen CREDENTIALS_DIR at module scope. The vitest project
 * config already points CODEMIE_HOME at a temp dir before import.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir } from 'fs/promises';

const keychain = new Map<string, string>();

vi.mock('keytar', () => ({
  setPassword: vi.fn(async (service: string, account: string, password: string) => {
    keychain.set(`${service}:${account}`, password);
  }),
  getPassword: vi.fn(async (service: string, account: string) =>
    keychain.get(`${service}:${account}`) ?? null),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(`${service}:${account}`)),
}));

import { CredentialStore } from '../../src/utils/security.js';
import { CodeMieSSO } from '../../src/providers/plugins/sso/sso.auth.js';
import { getCodemiePath } from '../../src/utils/paths.js';
import type { SSOCredentials } from '../../src/providers/core/types.js';

const BASE_URL = 'https://codemie-14132.example.com';
const API_URL = `${BASE_URL}/code-assistant-api`;

function credentials(): SSOCredentials {
  return {
    cookies: { codemie_access_token: 'test-token' },
    apiUrl: API_URL,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

async function listCredentialFiles(): Promise<string[]> {
  try {
    return (await readdir(getCodemiePath('credentials'))).sort();
  } catch {
    return [];
  }
}

describe('EPMCDME-14132: credential storage key is path-independent', () => {
  beforeEach(async () => {
    keychain.clear();
    const sso = new CodeMieSSO();
    await sso.clearStoredCredentials(API_URL);
    await sso.clearStoredCredentials(BASE_URL);
  });

  it('derives the same storage key from the API URL and the bare base URL', async () => {
    const store = CredentialStore.getInstance();

    const before = await listCredentialFiles();
    await store.storeSSOCredentials(credentials(), API_URL);
    const afterApiUrl = await listCredentialFiles();
    await store.storeSSOCredentials(credentials(), BASE_URL);
    const afterBaseUrl = await listCredentialFiles();

    expect(afterApiUrl.length - before.length).toBe(1);
    expect(afterBaseUrl).toEqual(afterApiUrl);
  });

  it('finds credentials stored under a path-bearing URL (the reported bug)', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(credentials(), API_URL);

    const found = await new CodeMieSSO().getStoredCredentials(API_URL);

    expect(found).not.toBeNull();
    expect(found?.cookies.codemie_access_token).toBe('test-token');
  });

  it('clears credentials stored under the base URL when given the API URL', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(credentials(), BASE_URL);
    expect(await new CodeMieSSO().getStoredCredentials(API_URL)).not.toBeNull();

    await new CodeMieSSO().clearStoredCredentials(API_URL);

    expect(await new CodeMieSSO().getStoredCredentials(API_URL)).toBeNull();
  });
});
```

- [ ] **Step 2: Delete the superseded scratch reproduction**

```bash
rm tests/integration/sso-login-url-key-mismatch.test.ts
```

- [ ] **Step 3: Run the tests to verify they fail (RED)**

Run: `npx vitest run --project cli tests/integration/sso-credential-key-normalization.test.ts`
Expected: **3 failed**.
- key invariant → `expected [ 'a.enc', 'b.enc' ] to deeply equal [ 'a.enc' ]`
- reported bug → `expected null not to be null`
- clear symmetry → `expected { cookies: … } to be null`

**Do not commit.** Pre-commit runs `vitest related --run` and will reject a red test. The RED evidence is this test run in the transcript.

---

### Task 2: Cherry-pick the fix (GREEN)

**Files:**
- Modify: `src/utils/security.ts` (via cherry-pick, not by hand)

**Interfaces:**
- Consumes: nothing.
- Produces: `getUrlStorageKey` now reduces any parseable URL to `protocol//host` before hashing; unparseable strings keep the previous lowercase-and-trim behavior.

**Test-first: no** — the failing tests were written and demonstrated RED in Task 1. This task is the GREEN half of that cycle. The commit is authored by Anton Yeromin and must not be rewritten.

- [ ] **Step 1: Cherry-pick the fix commit**

```bash
git cherry-pick 1b836521
```

Expected: applies cleanly to `src/utils/security.ts` (verified — the surrounding code is unchanged on current `main`).

- [ ] **Step 2: Confirm authorship was preserved**

```bash
git log -1 --format='%an <%ae> — %s'
```
Expected: `Anton_Yeromin <anton_yeromin@epam.com> — fix(utils): normalize URL to host before hashing credential storage key`

- [ ] **Step 3: Run the tests to verify they pass (GREEN)**

Run: `npx vitest run --project cli tests/integration/sso-credential-key-normalization.test.ts`
Expected: **3 passed**.

---

### Task 3: Call-site comment + commit the tests

**Files:**
- Modify: `src/providers/plugins/sso/sso.auth.ts:136`
- Add: `tests/integration/sso-credential-key-normalization.test.ts` (created in Task 1)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Comment only — no behavior change.

**Test-first: no** — a comment has no observable behavior. The tests it ships alongside were already demonstrated RED (Task 1) and GREEN (Task 2).

- [ ] **Step 1: Add the call-site comment**

In `src/providers/plugins/sso/sso.auth.ts`, above the store call at line 136:

```typescript
        const store = CredentialStore.getInstance();
        // Key must match getStoredCredentials() lookup, which normalizes to protocol+host
        await store.storeSSOCredentials(credentials, this.codeMieUrl);
```

- [ ] **Step 2: Run the affected tests**

Run: `npx vitest run --project cli tests/integration/sso-credential-key-normalization.test.ts`
Expected: **3 passed**.

- [ ] **Step 3: Commit the comment and the tests together**

```bash
git add tests/integration/sso-credential-key-normalization.test.ts src/providers/plugins/sso/sso.auth.ts
git commit -m "$(cat <<'EOF'
test(providers): cover SSO credential storage-key normalization

Adds regression tests for the storage-key asymmetry fixed in the previous
commit: the write path keyed credentials by the raw URL while the read path
normalized to protocol+host, so `profile login --url <api-url>` wrote a key
the proxy could never read.

keytar is mocked with an in-memory map because retrieveSSOCredentials reads
the real OS keychain before the file store, which lets a stale entry mask
the bug. Carries over the call-site comment from PR #506.

Refs: EPMCDME-14132
Closes: #506
Closes: #525

Co-authored-by: Nikolay Sulimov <crowar@gmail.com>
EOF
)"
```

- [ ] **Step 4: Verify both commits are present and green**

```bash
git log --oneline -2
npx vitest run --project cli tests/integration/sso-credential-key-normalization.test.ts
```
Expected: two commits (cherry-pick by Anton, test commit by you); 3 tests passing.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| #525 storage-boundary normalization | Task 2 |
| #506 call-site comment | Task 3 Step 1 |
| Key-invariant test | Task 1 |
| Ticket-regression test | Task 1 |
| Clear-symmetry test | Task 1 |
| keytar mocked to defeat false greens | Task 1 Step 1 |
| Anton's authorship preserved | Task 2 (cherry-pick, verified Step 2) |
| Nikolay credited | Task 3 Step 3 (`Co-authored-by`) |
| Exclude #506's caller normalization | Not implemented anywhere — correct |
| Exclude docs changes | No task touches `docs/AUTHENTICATION.md` — correct |
| Exclude missing-`codeMieUrl` gap | No task touches it — correct |

**Placeholder scan:** none. Every code step carries literal content.

**Type consistency:** `credentials()` returns `SSOCredentials` matching the interface used by `storeSSOCredentials`. `listCredentialFiles()` returns `string[]`, compared against `string[]`. `getStoredCredentials` returns `SSOCredentials | null`, asserted with `not.toBeNull()` / `toBeNull()`.

**Known deviation from strict TDD:** commits are not made at the RED point, because `lint-staged` runs `vitest related --run` on pre-commit and would reject the commit. RED is evidenced by the Task 1 Step 3 test run rather than by a red commit. This is a repo constraint, not a shortcut.
