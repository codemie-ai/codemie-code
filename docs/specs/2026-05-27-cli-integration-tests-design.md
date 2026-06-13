# CLI Integration Tests — Implementation Design

**Date:** 2026-05-27
**Source spec:** docs/specs/2026-05-19-cli-integration-tests-design.md
**Run:** docs/superpowers/runs/20260527-1352-main/

---

## Goal

Implement integration test cases (TC-001 – TC-034, excluding TC-027) for the `@codemieai/code` CLI, covering CLI management commands, JWT-authenticated agent sessions, interactive stdin/stdout session control, and budget/project configuration. TC-027 was removed — the original self-referential config-write pattern had no meaningful assertion, and a `codemie setup` wizard replacement is deferred (bearer-auth provider is hidden from the interactive wizard).

---

## Architecture

### Test tiers

| Tier | Files | Auth | Binary | Vitest config |
|---|---|---|---|---|
| CLI management | `tests/integration/cli-commands/` | none / JWT | no | default |
| Agent session | `tests/integration/agent-jwt-*.test.ts` | JWT | yes | `vitest.agent.config.ts` |
| Interactive session | `tests/integration/agent-interactive-session.test.ts` | JWT | yes | `vitest.agent.config.ts` |
| Budget / project | `tests/integration/agent-jwt-budget.test.ts` | JWT | yes | `vitest.agent.config.ts` |

### Gating

```typescript
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';
describe.runIf(INCLUDE_JWT_TESTS)('suite name', () => { ... });
```

All JWT-gated suites are skipped by default. Set `INCLUDE_JWT_TESTS=true` in CI to enable.

---

## Helper Layer

### `tests/helpers/jwt-auth.ts` (new)

```typescript
// Fetch a JWT token via Keycloak password grant
export async function fetchJwtToken(): Promise<string>

// Write a bearer-auth profile to ${codemieHome}/codemie-cli.config.json
export function writeJwtProfile(
  codemieHome: string,
  overrides?: Partial<{
    profileName: string;
    model: string;
    codeMieUrl: string;
    baseUrl: string;
    jwtToken: string;
    codeMieProject: string;
  }>
): void
```

`writeJwtProfile` produces:
```json
{
  "version": 2,
  "activeProfile": "jwt-autotest",
  "profiles": {
    "jwt-autotest": {
      "name": "jwt-autotest",
      "provider": "bearer-auth",
      "authMethod": "jwt",
      "codeMieUrl": "<CI_CODEMIE_URL>",
      "baseUrl": "<CI_CODEMIE_API_DOMAIN>",
      "model": "<CI_CODEMIE_MODEL>"
    }
  }
}
```

Config is written to `${codemieHome}/codemie-cli.config.json` — matching `getCodemiePath()` which resolves `CODEMIE_HOME` as the base directory.

### `tests/helpers/interactive-helpers.ts` (new)

Used only by `agent-interactive-session.test.ts`.

```typescript
// Resolves when stdout matches pattern; rejects on timeout or process exit with error
export function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number
): Promise<string>

// Sends SIGTERM and waits for the process to exit cleanly
export function cleanKill(proc: ChildProcess): Promise<void>
```

`waitForOutput` wraps stdout in a `readline` interface and polls line-by-line.

### `tests/helpers/index.ts` (extend)

Add re-exports for `fetchJwtToken`, `writeJwtProfile`, `waitForOutput`, `cleanKill`.

---

## Session-Scoped Build Fixture

Agent session tests require a pre-built `dist/`. A Vitest `globalSetup` runs `npm run build` once per test session — equivalent to a pytest `scope="session"` fixture.

### `tests/setup/agent-build-setup.ts` (new)

```typescript
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export async function setup() {
  const root = resolve(import.meta.dirname, '../..');
  console.log('[agent-integration] Building dist/...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
```

Runs once regardless of how many agent test files are in the session.

---

## Vitest Configuration

### `vitest.agent.config.ts` (new)

Dedicated config for agent integration tests only:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/agent-*.test.ts'],
    globalSetup: ['tests/setup/agent-build-setup.ts'],
    testTimeout: 180_000,   // 3 min — real agent calls over network
    hookTimeout: 300_000,   // 5 min — covers build + token fetch in beforeAll
    reporters: ['verbose'],
    env: { NODE_ENV: 'test' },
  },
});
```

### `package.json` scripts (additions)

```json
"test:integration:agent": "vitest run --config vitest.agent.config.ts",
"test:integration:cli":   "vitest run tests/integration/cli-commands/"
```

The existing `test:integration` script is unchanged.

---

## File Layout

```
tests/
  helpers/
    jwt-auth.ts                    NEW
    interactive-helpers.ts         NEW
    index.ts                       EXTEND (re-exports)

  setup/
    agent-build-setup.ts           NEW

  integration/
    cli-commands/
      doctor.test.ts               EXTEND — TC-002 (--verbose), TC-003 (JWT profile)
      profile.test.ts              EXTEND — TC-004..TC-010, TC-032, TC-033
      skills.test.ts               EXTEND — TC-012 (JWT lifecycle), TC-013 (invalid source)
      assistants.test.ts           NEW    — TC-014, TC-015
      models.test.ts               NEW    — TC-022

    agent-jwt-basic.test.ts        NEW    — TC-016..TC-019, TC-031
    agent-jwt-models.test.ts       NEW    — TC-020, TC-021
    agent-jwt-budget.test.ts       NEW    — TC-028
    agent-interactive-session.test.ts NEW — TC-024..TC-026

vitest.agent.config.ts             NEW
```

**`claude-cli-task.test.ts`** — skipped. TC-023 / TC-034 are deferred; a comment in `agent-jwt-basic.test.ts` records the deferral.

---

## Test Patterns

### CLI management tests

Use `spawnSync` directly (mirrors `skills.test.ts`):

```typescript
const result = spawnSync(process.execPath, [CLI_BIN, 'profile', 'switch', 'jwt-secondary'], {
  cwd: workspace,
  env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
  encoding: 'utf-8',
  timeout: 30_000,
});
expect(result.status).toBe(0);
```

### Agent session tests

`cleanEnv()` is a local inline helper in each agent test file that returns `{ PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH }` — a minimal env that prevents leaking real credentials from the developer's shell into subprocesses.

```typescript
const CLAUDE_BIN = path.resolve(__dirname, '../../bin/codemie-claude.js');

beforeAll(async () => {
  jwtToken = await fetchJwtToken();
  // dist/ is guaranteed by vitest.agent.config.ts globalSetup
});

const result = spawnSync(process.execPath, [CLAUDE_BIN, '--task', 'Say READY', '--jwt-token', jwtToken], {
  cwd: tmpWorkspace,
  env: { ...cleanEnv(), CODEMIE_HOME: testHome },
  encoding: 'utf-8',
  timeout: 120_000,
});
```

### Interactive session tests

```typescript
const proc = spawn(process.execPath, [CLAUDE_BIN, '--jwt-token', jwtToken], {
  env: { ...cleanEnv(), CODEMIE_HOME: testHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

await waitForOutput(proc, />\s*$|Human:/i, 30_000);
proc.stdin!.write('/model claude-haiku-4-5-20251001\n');
await waitForOutput(proc, /claude-haiku/i, 30_000);
proc.stdin!.write('Say CONFIRMED\n');
await waitForOutput(proc, /CONFIRMED/i, 60_000);
await cleanKill(proc);
```

### Skills lifecycle test (TC-012)

No `CI_CODEMIE_SKILL_SOURCE` env var needed. The `beforeAll` fetches the first available skill from the CodeMie marketplace API using the JWT token, then uses that source for `skills add` / `skills remove`:

```typescript
// In beforeAll — discover a skill source dynamically
const resp = await fetch(`${process.env.CI_CODEMIE_API_DOMAIN}/api/skills`, {
  headers: { Authorization: `Bearer ${jwtToken}` },
});
const skills = await resp.json();
skillSource = skills[0].source; // e.g. "owner/repo"
skillName   = skills[0].name;
```

TC-013 (invalid source) uses the hardcoded string `'nonexistent-owner/nonexistent-repo-xyz'` — no discovery needed.

## Environment Variables

Required for JWT-gated tests (`INCLUDE_JWT_TESTS=true`):

| Variable | Purpose |
|---|---|
| `CI_CODEMIE_USERNAME` | Service-account email |
| `CI_CODEMIE_PASSWORD` | Service-account password |
| `CI_CODEMIE_URL` | CodeMie frontend URL |
| `CI_CODEMIE_API_DOMAIN` | CodeMie API base URL |
| `CI_CODEMIE_PROJECT_ALL_BUDGETS` | Project name with all 3 budget types |
| `CI_CODEMIE_MODEL` | Default model (e.g. `claude-sonnet-4-6`) |
| `CI_CODEMIE_ASSISTANT_ID` | Known assistant ID for the test account |
| `INCLUDE_JWT_TESTS` | Set to `"true"` to enable JWT suites |

---

## Test Case Map

| TC | File | Type |
|---|---|---|
| TC-001 | `doctor.test.ts` | existing (verify coverage) |
| TC-002 | `doctor.test.ts` | extend |
| TC-003 | `doctor.test.ts` | extend (JWT-gated) |
| TC-004..TC-010, TC-032, TC-033 | `profile.test.ts` | extend |
| TC-011 | `skills.test.ts` | existing (verify coverage) |
| TC-012..TC-013 | `skills.test.ts` | extend (JWT-gated) |
| TC-014..TC-015 | `assistants.test.ts` | new (JWT-gated) |
| TC-016..TC-019, TC-031 | `agent-jwt-basic.test.ts` | new (JWT-gated) |
| TC-020..TC-021 | `agent-jwt-models.test.ts` | new (JWT-gated) |
| TC-022 | `models.test.ts` | new (JWT-gated) |
| TC-023, TC-034 | `claude-cli-task.test.ts` | deferred |
| TC-024..TC-026 | `agent-interactive-session.test.ts` | new (JWT-gated) |
| TC-028 | `agent-jwt-budget.test.ts` | new (JWT-gated) |
| TC-029 | `version.test.ts` | existing (verify coverage) |
| TC-030 | `list.test.ts` | existing (verify coverage) |
