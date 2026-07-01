# Hybrid Auth Analysis: Integration Test Files

## Summary Table

| Test File | Current Auth Mode | Hybrid Possible | Effort | Key Blocker |
|---|---|---|---|---|
| `agent-task-session.test.ts` | **Already hybrid** (SSO default / JWT on CI) | N/A (reference) | — | — |
| `agent-interactive-session.test.ts` | JWT-only (`INCLUDE_JWT_TESTS`) | Partial | High | PTY wizard flows are JWT-only by design; non-interactive asserts could be split |
| `agent-jwt-basic.test.ts` | JWT-only (`INCLUDE_JWT_TESTS`) | Yes | Medium | TC-016/017/021 are generic enough; TC-019 (no-auth negative) is inherently JWT-only |
| `agent-jwt-models.test.ts` | JWT-only (`INCLUDE_JWT_TESTS`) | Yes | Medium | Model selection is auth-agnostic; profile writes need dual paths |
| `cli-commands/doctor.test.ts` | Mixed: SSO-implicit + JWT-gated block | Partial | Low | Base doctor tests already auth-agnostic; TC-003 JWT block can be extended |
| `cli-commands/error-handling.test.ts` | Auth-agnostic | N/A (already hybrid) | None | Never touches auth |
| `cli-commands/models.test.ts` | JWT-only (`INCLUDE_JWT_TESTS`) | Yes | Low | Only needs `writeJwtProfile` → add SSO path with `sso-autotest` profile |
| `cli-commands/profile.test.ts` | Mixed: fake-profile tests + JWT-gated TC-004 | Partial | Low | Profile CRUD tests use fake profiles; only TC-004 needs dual paths |
| `cli-commands/skills.test.ts` | Mixed: SSO auto-detect + JWT-gated TC-012/013 | Partial | Medium | TC-012 requires SSO cookies for catalog API regardless of JWT; TC-013 hybridisable |

---

## The Reference Hybrid Pattern (`agent-task-session.test.ts`)

This file is the canonical example. Key structural elements to replicate:

- **Line 78**: `const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);`
  - Defaults `true` so local developers get SSO without any config change.
  - Set to `false` in CI (or `.env.test.local`) for JWT mode.

- **Lines 89–138 (`beforeAll`)**: Single `if (!CI_IS_LOCAL_RUN)` branch.
  - JWT path: `fetchJwtToken()`, `mkdtempSync()` → `jwtHome`, `writeJwtProfile(jwtHome, { jwtToken })`.
  - SSO path: reads/writes `~/.codemie/codemie-cli.config.json`, sets `sso-autotest` profile.

- **Lines 141–156 (`afterAll`)**: Parallel teardown.
  - JWT: `rmSync(jwtHome, ...)`.
  - SSO: restores `originalActiveProfile`.

- **Lines 176–210 (test body)**: Separate `spawnSync` calls per mode.
  - SSO: `cleanEnv()` (strips all `CODEMIE_*`), no `--jwt-token` arg, `cwd: tempTestDir`.
  - JWT: `jwtCleanEnv()` (allowlist), `--jwt-token jwtToken` arg, `cwd: jwtHome`, `CODEMIE_HOME: jwtHome`.

- **Lines 277–283, 300–303**: `if (CI_IS_LOCAL_RUN)` guards for SSO-only assertions (`sync.conversations.conversationId`, `syncedAt`).

### The two `cleanEnv()` functions are NOT the same

| Function | Location | Strategy | When to use |
|---|---|---|---|
| `cleanEnv()` (SSO) | `agent-task-session.ts:62` | Denylist — strips `CODEMIE_*` from full `process.env` | SSO mode; relies on real `~/.codemie` |
| `jwtCleanEnv()` | `helpers/jwt-auth.ts:54` | Allowlist — only PATH + OS vars | JWT mode; prevents any credential leak |

---

## Per-File Analysis

### 1. `agent-interactive-session.test.ts`

**Current auth mode:** JWT-only. Outer `describe` at line 47 uses `describe.runIf(INCLUDE_JWT_TESTS)`. All test homes are created with `writeJwtProfile(testHome, { jwtToken })`.

**Can it be made hybrid?** Partial.

**TC-level breakdown:**

| TC | Description | Hybridisable | Notes |
|---|---|---|---|
| TC-014 | setup assistants PTY wizard | Yes (with effort) | Wizard UI is auth-agnostic; SSO env needs `CI_CODEMIE_ASSISTANT_NAME` |
| TC-015 | invalid assistant ID (negative) | Yes | Only `--jwt-token` arg differs |
| TC-024 | in-session /model switch PTY | Yes | `--profile jwt-autotest` → `--profile sso-autotest` |
| TC-025 | skill slash command PTY | Yes (with effort) | Needs `CI_CODEMIE_SKILL_NAME` for SSO env |
| TC-026 | assistants chat non-interactive | Yes | Drop `--jwt-token` and `CODEMIE_JWT_TOKEN` env |

**What would need to change:**

- TC-015, TC-026: Remove `--jwt-token jwtToken` arg and `CODEMIE_JWT_TOKEN: jwtToken` from env. Replace `CODEMIE_HOME: testHome` with no override (SSO uses `~/.codemie`).
- TC-024: Replace `--profile jwt-autotest` with `--profile sso-autotest`.
- TC-014, TC-025: As above, plus ensure `CI_CODEMIE_ASSISTANT_NAME` / `CI_CODEMIE_SKILL_NAME` point at a dev-env resource.

**Problems and risks:**

1. The file defines its own `cleanEnv()` (lines 33–45) that is actually identical to `jwtCleanEnv()` — not the SSO variant. In a hybrid file, two named functions are needed, or imports from the helpers index.
2. `waitFor(/\d+ assistants total/, 60_000)` (line 89) and `waitFor(/\d+ skills total/, 60_000)` (line 347) make live API calls. Network failures produce different failure modes in SSO vs JWT.
3. `CI_CODEMIE_ASSISTANT_NAME` and `CI_CODEMIE_ASSISTANT_ID` (line 421) are currently JWT CI env vars. SSO mode on a developer machine would need these pointing at a dev-environment assistant.

**Estimated effort:** High. Five TC scenarios, PTY timing sensitivity, separate `CI_CODEMIE_ASSISTANT_NAME` / `CI_CODEMIE_SKILL_NAME` env vars needed per mode.

---

### 2. `agent-jwt-basic.test.ts`

**Current auth mode:** JWT-only. Guard at line 30: `describe.runIf(INCLUDE_JWT_TESTS)`.

**Can it be made hybrid?** Yes, for TC-016, TC-017. TC-018 and TC-019 must stay JWT-only.

**TC-level breakdown:**

| TC | Description | Hybridisable | Notes |
|---|---|---|---|
| TC-016 | agent runs with token | Yes | Core assertion (exit 0, session file) is auth-agnostic |
| TC-017 | agent with profile + token override | Yes | SSO provider assertion differs: `/ai-run-sso/i` vs `/bearer-auth/i` |
| TC-018 | invalid JWT token negative | No | JWT-specific negative path — no SSO equivalent |
| TC-019 | no profile / no JWT negative | No | Safe only with empty JWT home; unsafe against real `~/.codemie` |

**What would need to change:**

- TC-016 `beforeAll`: add SSO profile write branch; SSO spawn uses `cleanEnv()`, no `--jwt-token`.
- TC-017: SSO path uses `--profile sso-autotest` without `--jwt-token`; provider assertion branches on `CI_IS_LOCAL_RUN`.

**Problems and risks:**

1. TC-016 writes sessions to `join(testHome, 'sessions')`. SSO mode sessions go to `~/.codemie/sessions`. The sessions-dir path must be conditional.
2. TC-019 would be dangerous to hybridise — the "no config" negative test assumes a clean slate, which is not true on a developer machine with `~/.codemie` populated.

**Estimated effort:** Medium.

---

### 3. `agent-jwt-models.test.ts`

**Current auth mode:** JWT-only. Guard at line 48: `describe.runIf(INCLUDE_JWT_TESTS)`. Uses local `writeModelProfile()` (lines 24–45) to create profiles with specific models.

**Can it be made hybrid?** Yes.

**What would need to change:**

- `writeModelProfile()` (local helper) creates `bearer-auth` profiles. SSO path would write to `~/.codemie` with `sso-autotest` profile including the `model` field — same pattern as `agent-task-session.ts` lines 107–136.
- TC-020: Runs two `spawnSync` calls (sonnet and haiku). JWT path uses `jwtHome` and `haikuHome` (line 74) — two separate temp dirs. SSO path cannot have two simultaneous `~/.codemie` homes; must run sonnet, edit active profile model, then run haiku sequentially.
- TC-021: Single run, straightforward dual-path like TC-016.

**Problems and risks:**

1. TC-020 SSO path: sequential profile edits to `~/.codemie` between sonnet and haiku runs. If the test crashes mid-run, the profile is left in the haiku-model state. Add a `try/finally` restore.
2. Model names (`claude-haiku-4-5-20251001`) must exist in the SSO environment's model catalog. If the SSO env has a different catalog this could fail.

**Estimated effort:** Medium.

---

### 5. `cli-commands/doctor.test.ts`

**Current auth mode:** Mixed.

- Base `describe` blocks (lines 21–86): Use `setupTestIsolation()` + `createCLIRunner()`. No auth required — tests only check static output patterns. Already auth-agnostic.
- TC-003 (lines 90–121): `describe.runIf(INCLUDE_JWT_TESTS)`. Checks that a JWT profile name appears in `doctor` output.

**Can it be made hybrid?** Partial (TC-003 only; base tests unchanged).

**What would need to change for TC-003:**

- Add `CI_IS_LOCAL_RUN` flag.
- SSO path: write `sso-autotest` profile to a temp home, run `codemie doctor`, assert `/sso-autotest/i` in output.
- The `spawnSync` env at line 101 uses `{ ...process.env, CODEMIE_HOME: testHome, CI: '1' }` — should use `cleanEnv()` to avoid outer SSO credential bleed.

**Problems and risks:**

1. `setupTestIsolation()` has a potential `undefined` assignment bug (see Helpers section below). Not a hybrid concern but a reliability risk.
2. TC-003 SSO path needs the SSO session to be active. If not active, `doctor` will show auth errors rather than the profile name — would need to distinguish between "profile listed" and "profile valid" assertions.

**Estimated effort:** Low.

---

### 6. `cli-commands/error-handling.test.ts`

**Current auth mode:** Auth-agnostic. Runs `codemie invalid-command-xyz` which fails before any auth check.

**Can it be made hybrid?** N/A — already trivially hybrid.

No changes needed. Adding `CI_IS_LOCAL_RUN` branching would be pure noise.

---

### 7. `cli-commands/models.test.ts`

**Current auth mode:** JWT-only. Guard at line 12: `describe.runIf(INCLUDE_JWT_TESTS)`. Calls `codemie models list` with `CODEMIE_JWT_TOKEN` in env.

**Can it be made hybrid?** Yes.

**What would need to change:**

- Import `getTestEnvFlagOrDefault` from helpers, set `CI_IS_LOCAL_RUN`.
- SSO `beforeAll`: write `sso-autotest` profile to `~/.codemie` (pattern from `agent-task-session.ts` lines 107–136).
- SSO `spawnSync` env: `{ ...cleanEnv(), CI: '1' }` (no `CODEMIE_HOME` override, no `CODEMIE_JWT_TOKEN`).
- Replace `describe.runIf(INCLUDE_JWT_TESTS)` with unconditional (since `CI_IS_LOCAL_RUN` defaults to `true`).

**Problems and risks:**

1. `codemie models list` makes a live API call. SSO env must return a model list that satisfies `process.env.CI_CODEMIE_MODEL ?? 'claude'` assertion regex.
2. Current JWT `spawnSync` env (`{ ...process.env, CODEMIE_HOME, CODEMIE_JWT_TOKEN, CI }`) does not strip outer `CODEMIE_*` vars — inconsistent with the reference pattern. Should use `jwtCleanEnv()` for the JWT path.

**Estimated effort:** Low.

---

### 8. `cli-commands/profile.test.ts`

**Current auth mode:** Mixed.

- TC-005–010, TC-032–033: Use `runCLI()` with fake `fakeProfile()` data (`codeMieUrl: 'https://test.example.com'`). No real auth. Auth-agnostic.
- TC-004 (lines 264–286): `describe.runIf(INCLUDE_JWT_TESTS)`. Uses `fetchJwtToken()` + `writeJwtProfile()` + `profile status`.

**Can it be made hybrid?** Partial (TC-004 only; TC-005–010, TC-032–033 unchanged).

**What would need to change for TC-004:**

- SSO path: skip `fetchJwtToken()`, write `sso-autotest` profile, run `profile status`, assert `/sso-autotest/i` and `/ai-run-sso|sso/i`.
- Drop `CODEMIE_JWT_TOKEN: jwtToken` from `extraEnv` at line 282.

**Problems and risks:**

1. `runCLI()` (line 25) passes `{ ...process.env, CODEMIE_HOME, ... }` without stripping `CODEMIE_*` — outer session vars could bleed in. This is consistent with all profile tests but worth noting.
2. TC-004 SSO path: `profile status` may make a network call to validate the profile. If SSO session is not active, the test would get a network error instead of expected status output.

**Estimated effort:** Low.

---

### 9. `cli-commands/skills.test.ts`

**Current auth mode:** Three-tier mixed.

1. Lines 107–156: Auth-agnostic (`--help`, unauthenticated negative). Always runs.
2. Lines 162–262: `describe.runIf(HAS_LOCAL_SSO)` — SSO auto-detected at import time. Already SSO-only by design.
3. Lines 269–395: Two JWT-gated blocks.
   - TC-012: `INCLUDE_JWT_TESTS && HAS_LOCAL_SSO` — requires **both** simultaneously.
   - TC-013: `INCLUDE_JWT_TESTS` only.

**Can it be made hybrid?** Partial.

**TC-level breakdown:**

| TC / Block | Hybridisable | Notes |
|---|---|---|
| `--help` / unauthenticated negative | N/A (already unconditional) | No change needed |
| HAS_LOCAL_SSO authenticated block | N/A (already SSO) | No change needed |
| TC-012 JWT + SSO lifecycle | No | Skills marketplace catalog API requires SSO cookies regardless of JWT auth |
| TC-013 invalid source (negative) | Yes | Just drop `CODEMIE_JWT_TOKEN` for SSO path |

**Problems and risks:**

1. TC-012's `INCLUDE_JWT_TESTS && HAS_LOCAL_SSO` guard is the most complex in the entire suite. TC-012 fundamentally depends on SSO cookies for the `skills find --json` catalog call (line 285 uses `{ ...process.env, CI: '1' }`, not an isolated JWT home). Making it "hybrid" in the `CI_IS_LOCAL_RUN` sense is a misnomer — it already needs SSO.
2. `HAS_LOCAL_SSO` detection (lines 162–178) runs at module load time by probing the CLI. This is correct design and should remain as-is.
3. The `skills find --json` call at line 285 uses full `process.env` — if `CODEMIE_HOME` is set in the test runner's env (e.g. from a parent isolation scope), SSO credentials won't be found. Latent risk if ever composed inside a `setupTestIsolation()` context.

**Estimated effort:** Medium (TC-013 is Low; TC-012 is a No due to structural dependency on SSO catalog API).

---

## Shared Helpers — What Would Need Updating

### `tests/helpers/jwt-auth.ts`

No structural changes needed for existing exports. Additions that would benefit every hybrid file:

1. **`writeSsoProfile(codemieHome, overrides?)`** — mirrors `writeJwtProfile()` but writes `ai-run-sso` / `sso` auth method. Currently the SSO profile write is inlined in `agent-task-session.test.ts` lines 107–136. Extracting it prevents per-file duplication.

2. **Export `ssoCleanEnv()` (or rename the inline `cleanEnv()`)** — the CODEMIE_*-stripping variant currently defined inline in `agent-task-session.ts:62`. All hybrid SSO spawns need this. Currently:
   - `agent-task-session.ts:62`: strips `CODEMIE_*` from full env (correct for SSO).
   - `agent-interactive-session.ts:33`: local `cleanEnv()` that is actually identical to `jwtCleanEnv()` — a copy/paste error that would cause JWT credentials to bleed into SSO spawns if used for the SSO path.

3. **`saveAndSwitchSsoProfile()` / `restoreOriginalProfile()` helpers** — the read-modify-write of `~/.codemie/codemie-cli.config.json` in `beforeAll`/`afterAll` (lines 95–155) is boilerplate that every SSO-path hybrid file would need. Extracting it reduces copy-paste risk.

### `tests/helpers/test-env.ts`

No changes required. `getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true)` already serves all hybrid files.

### `tests/helpers/session-poll.ts`

No changes required. `pollForSession(sessionsDir, testUuid)` is path-agnostic.

### `tests/helpers/test-isolation.ts` (potential bug)

`setupTestIsolation()` uses:
```typescript
testHome = mkdirSync(join(tmpdir(), prefix), { recursive: true }) ||
           join(tmpdir(), prefix + Math.random().toString(36).slice(2, 9));
```
`mkdirSync` with `{ recursive: true }` returns `string | undefined` (returns `undefined` if directory already exists). This could assign `undefined` to `testHome` on some Node versions, causing `process.env.CODEMIE_HOME = "undefined"` (literal string). Not directly a hybrid concern but a reliability risk in `doctor.test.ts` and `profile.test.ts`.

### `tests/helpers/cli-runner.ts`

`CLIRunner.runSilent()` inherits `process.env` via `execSync` without any filtering. Tests using `createCLIRunner()` rely on `setupTestIsolation()` having already set `process.env.CODEMIE_HOME`. For hybrid tests using `CLIRunner`, either:
- Add an optional `env` parameter to `runSilent()`.
- Use direct `spawnSync` with explicit env instead of `CLIRunner`.

---

## Recommended Priority and Order

### Priority 1 — Quick wins (no or minimal effort)

1. **`cli-commands/error-handling.test.ts`**: No work needed. Already hybrid.
2. **`cli-commands/models.test.ts`**: Single describe, clear dual-path. Add `CI_IS_LOCAL_RUN`, SSO `beforeAll` branch. (~1 hour)

### Priority 2 — Helper extraction first (multiplier for everything else)

4. **Extract shared helpers**: Add `writeSsoProfile()`, export `ssoCleanEnv()` (the CODEMIE_*-stripping variant), add `saveAndSwitchSsoProfile()` to `tests/helpers/jwt-auth.ts` (or a new `sso-auth.ts`). (~2 hours)

### Priority 3 — Medium-effort hybridisations (after Priority 2)

5. **`agent-jwt-basic.test.ts` TC-016, TC-017**: Dual-path `beforeAll` + spawn. TC-018 and TC-019 stay JWT-only. (~3 hours)
6. **`agent-jwt-models.test.ts`**: Dual-path. TC-020 needs careful sequential profile editing for SSO haiku run. (~3–4 hours)
7. **`cli-commands/doctor.test.ts` TC-003**: Add SSO path to JWT-gated describe. (~1 hour)
8. **`cli-commands/profile.test.ts` TC-004**: Add SSO path. (~1 hour)
9. **`cli-commands/skills.test.ts` TC-013**: Add SSO path to invalid-source test. (~2 hours)

### Priority 4 — High effort

10. **`agent-interactive-session.test.ts`**: Staged approach recommended:
    - TC-015 and TC-026 (non-interactive) first. (~2 hours)
    - TC-024 (/model switch PTY). (~3 hours)
    - TC-014 and TC-025 (PTY wizard flows) last — most complex due to live catalog API calls and PTY timing sensitivity. (~4–6 hours each)

### Do Not Hybridise

| File / TC | Reason |
|---|---|
| `agent-jwt-basic.test.ts` TC-018 | Tests JWT-specific invalid-token negative path |
| `agent-jwt-basic.test.ts` TC-019 | "No config" negative is unsafe against real `~/.codemie` on developer machines |
| `cli-commands/skills.test.ts` TC-012 | Catalog API requires SSO cookies even when JWT auth is active — structurally impossible to run without SSO |
