# CLI Integration Test Design

**Last updated:** 2026-06-22
**Branch:** `test/cli-integration-tests`

---

## Overview

Integration tests for the `codemie-claude` CLI binary. Tests are end-to-end: they spawn the compiled binary as a child process (or PTY), drive it with real environment variables, and assert on exit codes, stdout, and session/metrics artefacts written to `CODEMIE_HOME`.

Tests are split into two Vitest configurations:

| Project | Includes | GlobalSetup |
|---|---|---|
| `unit` | `src/**/*.test.ts` | none |
| `cli` | `tests/integration/**/*.test.ts` (excl. `agent-*`) | none |
| `agent` | `tests/integration/agent-*.test.ts` | `tests/setup/agent-build-setup.ts` (build + SSO auth) |

All three projects are defined in a single `vitest.config.ts` using `defineConfig({ test: { projects: [...] } })` with `defineProject`.

CLI-commands tests (`cli-commands/*.test.ts`) exercise commands that need no network auth (health, help, version, doctor, etc.).  
Agent tests (`agent-*.test.ts`) exercise commands that require authentication and make real network calls.

---

## Auth Model

### `CI_IS_LOCAL_RUN` dual-mode

Tests gate on the `CI_IS_LOCAL_RUN` flag (read via `getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true)`):

| Value | Mode | Auth mechanism |
|---|---|---|
| `true` (default) | SSO / local dev | Existing `sso-autotest` profile in `~/.codemie` |
| `false` | JWT / CI pipeline | Bearer token fetched from `CI_CODEMIE_AUTH_URL` |

This replaces the old `INCLUDE_JWT_TESTS=true` gate that ran JWT tests only. Tests that can exercise both modes are now **dual-mode** and run in every environment. Tests that are logically specific to the JWT mechanism are marked **JWT-only** and wrapped in `describe.runIf(!CI_IS_LOCAL_RUN)`.

### JWT-only describe convention

```ts
describe.runIf(!CI_IS_LOCAL_RUN)(
  'TC-NNN — description [JWT-only, skipped when CI_IS_LOCAL_RUN=true]',
  () => { ... },
);
```

The skip reason is embedded in the describe name so it appears in test output when the suite is skipped.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CI_IS_LOCAL_RUN` | optional | `true` = SSO mode (default), `false` = JWT mode |
| `CI_CODEMIE_URL` | both modes | CodeMie frontend URL (API base derived as `CI_CODEMIE_URL/code-assistant-api`) |
| `CI_CODEMIE_MODEL` | optional | Model override (default: `claude-sonnet-4-6`) |
| `CI_CODEMIE_USERNAME` | JWT mode | Username for token fetch |
| `CI_CODEMIE_PASSWORD` | JWT mode | Password for token fetch |
| `CI_CODEMIE_AUTH_URL` | JWT mode | Keycloak/auth server base URL |
| `CI_AGENT_MAX_WORKERS` | optional | `maxWorkers` for agent test runner (default: 2) |
| `DEFAULT_TIMEOUT` | optional | Command timeout in seconds (default: 60) |
| `CODEMIE_HOME` | set per-test | Isolated temp dir; overrides `~/.codemie` for the test run |

Local dev: set these in `.env.test.local` at the repo root (gitignored).

---

## Directory Layout

```
tests/
  helpers/
    index.ts              # Re-exports all helpers
    cli-runner.ts         # CLIRunner, createCLIRunner, createAgentRunner
    jwt-auth.ts           # fetchJwtToken, writeJwtProfile, jwtCleanEnv
    sso-auth.ts           # writeSsoProfile, ssoCleanEnv, copySsoCredentials,
                          # setupSsoAutotestProfile, teardownSsoAutotestProfile
    pty-session.ts        # spawnPty, PtySession
    metrics.ts            # getLatestMetricsRecord
    temp-workspace.ts     # TempWorkspace, createTempWorkspace, getTempDir, resolveLongPath
    interactive-helpers.ts # waitForOutput, cleanKill (legacy; prefer spawnPty)
    test-env.ts           # getTestEnvFlag, getTestEnvFlagOrDefault
    session-poll.ts       # pollForSession
  setup/
    agent-build-setup.ts  # Vitest globalSetup: npm run build + SSO credential auth
    load-test-env.ts      # Imports .env.test.local at the top of each test file
  integration/
    agent-task.test.ts          # TC-016 dual-mode
    agent-task-session.test.ts  # Session/metrics artefact validation
    agent-model.test.ts         # TC-020, TC-021, TC-022, TC-024
    agent-skills.test.ts        # TC-025
    agent-assistant.test.ts     # TC-014, TC-015, TC-026
    agent-jwt-token.test.ts     # TC-017, TC-027  [JWT-only]
    agent-negative.test.ts      # TC-018 [JWT-only], TC-019 [dual-mode]
    agent-setup.test.ts         # TC-029 [SSO-only]
    agent-shortcuts.test.ts     # Slash command smoke tests
    cli-commands/
      doctor.test.ts
      help.test.ts
      version.test.ts
      list.test.ts
      profile.test.ts
      skills.test.ts
      workflow.test.ts
      self-update.test.ts
      error-handling.test.ts
```

---

## Helper Layer

### JWT helpers (`helpers/jwt-auth.ts`)

| Helper | Purpose |
|---|---|
| `fetchJwtToken()` | Fetches bearer token from auth server using `CI_CODEMIE_*` env vars |
| `writeJwtProfile(home, { jwtToken })` | Writes a `bearer-auth` profile config to `<home>/codemie-cli.config.json` |
| `jwtCleanEnv()` | Returns a minimal env object (no `CODEMIE_HOME`, no inherited profile) for JWT runs |

### SSO helpers (`helpers/sso-auth.ts`)

| Helper | Purpose |
|---|---|
| `writeSsoProfile(home)` | Writes an `ai-run-sso` profile config to `<home>/codemie-cli.config.json` |
| `ssoCleanEnv()` | Returns a minimal env object for SSO runs (strips inherited auth env vars) |
| `copySsoCredentials(home)` | Copies SSO credential files from `~/.codemie` into the test's isolated `home` |
| `setupSsoAutotestProfile()` | Sets `sso-autotest` as the active profile in `~/.codemie`; returns the original active profile name |
| `teardownSsoAutotestProfile(original)` | Restores the original active profile after the test |

### PTY helper (`helpers/pty-session.ts`)

| Helper | Purpose |
|---|---|
| `spawnPty(file, args, options)` → `PtySession` | Spawns a binary in a node-pty PTY. `options: { cwd: string, env: NodeJS.ProcessEnv }`. Returns a `PtySession`. |

`PtySession` interface:

| Method | Signature | Purpose |
|---|---|---|
| `writeLine` | `(text: string) => void` | Write text followed by `\r\n` (simulates Enter) |
| `write` | `(raw: string) => void` | Send raw bytes (use for control chars like `\x03`) |
| `waitFor` | `(pattern: RegExp, timeoutMs: number, startFromLine?: number) => Promise<string>` | Resolve when a line matches; reject on timeout |
| `exit` | `(timeoutMs?: number) => Promise<void>` | Wait for process to exit; force-kill after timeout (default 15 s) |
| `lines` | `() => string[]` | Return a snapshot of all lines received so far |

Used by interactive tests (TC-024, TC-025) that need to drive a running session with slash commands.

### Metrics helper (`helpers/metrics.ts`)

| Helper | Purpose |
|---|---|
| `getLatestMetricsRecord(sessionsDir)` | Reads `_metrics.jsonl` in `sessionsDir` and returns the latest record as a parsed object |

### Other helpers

| Helper | File | Purpose |
|---|---|---|
| `getTempDir()` | `temp-workspace.ts` | Returns system temp dir, platform-aware |
| `resolveLongPath(p)` | `temp-workspace.ts` | Resolves Windows long path prefix |
| `getTestEnvFlagOrDefault(name, def)` | `test-env.ts` | Reads an env flag as boolean with fallback |
| `pollForSession(dir, opts)` | `session-poll.ts` | Polls for session file creation with timeout |

---

## TC Map

| TC | File | Mode | Description |
|---|---|---|---|
| TC-014 | `agent-assistant.test.ts` | dual | Setup assistants wizard registers assistant as skill |
| TC-015 | `agent-assistant.test.ts` | dual | Assistants chat with invalid ID returns error |
| TC-016 | `agent-task.test.ts` | dual | `--task` exits 0 and agent response appears in stdout |
| TC-017 | `agent-jwt-token.test.ts` | JWT-only | `--profile` + `--jwt-token` overrides active SSO profile; session records `bearer-auth` |
| TC-018 | `agent-negative.test.ts` | JWT-only | Invalid JWT token exits non-zero with auth error |
| TC-019 | `agent-negative.test.ts` | dual | No profile and no token exits non-zero with config error |
| TC-020 | `agent-model.test.ts` | dual | Session records model configured in profile |
| TC-021 | `agent-model.test.ts` | dual | Metrics records configured model in models array |
| TC-022 | `agent-model.test.ts` | dual | `codemie models list` returns the configured model name |
| TC-024 | `agent-model.test.ts` | dual | In-session `/model` slash command records new model in metrics (PTY) |
| TC-025 | `agent-skills.test.ts` | dual | Skill slash command invocation inside running session (PTY) |
| TC-026 | `agent-assistant.test.ts` | dual | Assistants chat non-interactive (random number round-trip) |
| TC-027 | `agent-jwt-token.test.ts` | JWT-only | `--jwt-token` with no profile (empty CODEMIE_HOME) exits 0 and prints agent response |
| TC-029 | `agent-setup.test.ts` | SSO-only | Setup wizard creates SSO profile; config has correct provider, URL, project, model |
| TC-030 | `cli-commands/self-update.test.ts` | no-auth | `self-update --check` exits 0 and outputs current version from package.json |

---

## Gating Patterns

### Dual-mode test (runs in both SSO and JWT)

```ts
const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

beforeAll(async () => {
  if (!CI_IS_LOCAL_RUN) {
    jwtToken = await fetchJwtToken();
  } else {
    originalActiveProfile = setupSsoAutotestProfile();
  }
}, 30_000);

afterAll(() => {
  if (CI_IS_LOCAL_RUN) teardownSsoAutotestProfile(originalActiveProfile);
});

// Inner beforeAll (per-describe):
beforeAll(() => {
  testHome = mkdtempSync(join(getTempDir(), 'codemie-test-'));
  if (!CI_IS_LOCAL_RUN) {
    writeJwtProfile(testHome, { jwtToken });
  } else {
    writeSsoProfile(testHome);
    copySsoCredentials(testHome);
  }
  result = spawnSync(
    process.execPath,
    CI_IS_LOCAL_RUN
      ? [CLAUDE_BIN, '--task', 'Say READY']
      : [CLAUDE_BIN, '--task', 'Say READY', '--jwt-token', jwtToken],
    {
      env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: testHome },
      encoding: 'utf-8',
      timeout: 120_000,
    },
  );
}, 180_000);
```

### JWT-only test

```ts
describe.runIf(!CI_IS_LOCAL_RUN)(
  'TC-NNN — description [JWT-only, skipped when CI_IS_LOCAL_RUN=true]',
  () => {
    let jwtToken: string;
    beforeAll(async () => { jwtToken = await fetchJwtToken(); }, 30_000);
    // ... tests using jwtToken
  },
);
```

### Interactive PTY test (dual-mode)

```ts
// TC-024, TC-025 — interactive sessions driven via node-pty
// spawnPty is synchronous; no await needed.
const session = spawnPty(
  process.execPath,
  [CLAUDE_BIN, ...(CI_IS_LOCAL_RUN ? [] : ['--jwt-token', jwtToken])],
  {
    env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: testHome },
    cwd: testHome,
  },
);
await session.waitFor(/\$/, 30_000);         // prompt
session.writeLine('/model claude-haiku-4-5');
await session.waitFor(/switched|model/i, 30_000);
await session.exit();
```

---

## Global Setup (`tests/setup/agent-build-setup.ts`)

Runs once per agent test session (`vitest.config.ts` agent project → `globalSetup`):

1. Loads `.env.test.local`.
2. Runs `npm run build` to produce `dist/`.
3. Ensures `~/.local/bin` is in `PATH` (needed on some Windows CI runners).
4. Installs or skips the native `claude` binary.
5. If `CI_IS_LOCAL_RUN=true`, authenticates the `sso-autotest` profile so SSO credentials are valid for the test session.

---

## Multi-profile Override Pattern (TC-017)

TC-017 exercises the `--profile` + `--jwt-token` runtime override. The test writes a two-profile config where the **active** profile is SSO and the **non-active** profile is `bearer-auth`. Running with `--profile profile-jwt-override --jwt-token <token>` must:

1. Select the non-active profile (not the active SSO one).
2. Use the supplied token for auth.

The observable proof is the `provider` field in the session file. Because `--jwt-token` does **not** mutate the config's `provider` key, the session will record `bearer-auth` only if the non-active JWT profile was actually selected. If the active SSO profile were used instead, `provider` would be `ai-run-sso`.

Config shape written by `writeTwoProfileConfig(testHome)`:

```json
{
  "version": 2,
  "activeProfile": "profile-sso-active",
  "profiles": {
    "profile-sso-active":  { "provider": "ai-run-sso",   "authMethod": "sso" },
    "profile-jwt-override": { "provider": "bearer-auth", "authMethod": "jwt" }
  }
}
```

Assertion: `session.provider` matches `/bearer-auth/i`.

---

## Conventions

- Every test writes to an isolated `mkdtempSync(...)` temp dir, set as `CODEMIE_HOME`.
- `afterAll` always `rmSync(testHome, { recursive: true, force: true })`.
- `spawnSync` is used for non-interactive `--task` invocations; `spawnPty` for interactive sessions.
- `testTimeout: 180_000` and `hookTimeout: 300_000` in the `agent` project of `vitest.config.ts`.
- TC numbers appear in the `describe` name so they are visible in test output.
