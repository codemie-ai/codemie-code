# CodeMie Code CLI — Integration Test Cases

**Date:** 2026-05-19  
**Approach:** B — Spec + implementation mapping  
**Framework:** Vitest + `spawnSync` / `execSync` (mirrors existing `tests/integration/` pattern)  
**Auth strategy for CI:** JWT token via password grant (see §Authentication)

---

## Table of Contents

1. [Authentication Strategy](#authentication-strategy)
2. [Test Tiers](#test-tiers)
3. [CLI Management Tests](#cli-management-tests) — no live agent required
4. [Agent Session Tests (JWT)](#agent-session-tests-jwt) — spawns agent binary
5. [Interactive Session Tests](#interactive-session-tests) — stdin/stdout with running agent
6. [Budget & Project Tests](#budget--project-tests)
7. [Implementation Notes](#implementation-notes)

---

## Authentication Strategy

SSO browser login is not usable in CI pipelines. All tests that require authentication obtain a JWT token via the Keycloak password grant:

```
POST https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
client_id=codemie-sdk
username=<CI_CODEMIE_USERNAME>
password=<CI_CODEMIE_PASSWORD>
```

The response `access_token` is passed to agent launchers via `--jwt-token "<token>"`.  
To test project-scoped behaviour use `--profile <name> --jwt-token "<token>"` where the named profile has `codeMieProject` set.

**Required CI environment variables:**

| Variable | Purpose |
|---|---|
| `CI_CODEMIE_USERNAME` | Service-account email |
| `CI_CODEMIE_PASSWORD` | Service-account password |
| `CI_CODEMIE_URL` | CodeMie frontend URL (e.g. `https://codemie.lab.epam.com`) |
| `CI_CODEMIE_API_DOMAIN` | CodeMie API base URL |
| `CI_CODEMIE_PROJECT_ALL_BUDGETS` | Project name that has premium + platform + cli budgets |
| `CI_CODEMIE_MODEL` | Default model for JWT-auth tests (e.g. `claude-sonnet-4-6`) |
| `CI_CODEMIE_SKILL_SOURCE` | A known public skill source (e.g. `owner/repo`) available in the test environment |
| `CI_CODEMIE_ASSISTANT_ID` | A known assistant ID available for the test account |
| `INCLUDE_JWT_TESTS` | Set to `"true"` to enable JWT-authenticated test suites |

**Helper to fetch token** (`tests/helpers/jwt-auth.ts`):

```typescript
// Fetch a fresh JWT token using the password grant
export async function fetchJwtToken(): Promise<string> {
  const resp = await fetch(
    'https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'codemie-sdk',
        username: process.env.CI_CODEMIE_USERNAME!,
        password: process.env.CI_CODEMIE_PASSWORD!,
      }),
    }
  );
  const data = await resp.json();
  if (!data.access_token) throw new Error('JWT token fetch failed');
  return data.access_token;
}
```

**Gating pattern** (mirrors existing `INCLUDE_SSO_TESTS`):

```typescript
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';
describe.runIf(INCLUDE_JWT_TESTS)('My JWT suite', () => { ... });
```

---

## Test Tiers

| Tier | Requires auth | Agent binary | Interactive stdin | Gating env var |
|---|---|---|---|---|
| CLI Management | No (or JWT for some) | No | No | none / `INCLUDE_JWT_TESTS` |
| Agent Session | Yes (JWT) | Yes | No | `INCLUDE_JWT_TESTS` |
| Interactive Session | Yes (JWT) | Yes | Yes | `INCLUDE_JWT_TESTS` |
| Budget / Project | Yes (JWT) | No | No | `INCLUDE_JWT_TESTS` |

---

## CLI Management Tests

Target file: `tests/integration/cli-commands/`  
Runner: `createCLIRunner()` → `node bin/codemie.js <command>`  
Isolation: `setupTestIsolation()` (isolated `CODEMIE_HOME`)

---

### TC-001 — codemie doctor (no profile configured)

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/doctor.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Clean isolated `CODEMIE_HOME` (no config file) |
| **Command** | `node bin/codemie.js doctor` |
| **Expected exit code** | 0 or 1 (non-crash) |
| **Expected output contains** | `Node.js` or `node`, `npm`, `Python`, `uv` |
| **Expected output does NOT contain** | Stack trace, unhandled exception |

**Steps:**
1. `setupTestIsolation()` — empty `CODEMIE_HOME`
2. Run `codemie doctor`
3. Assert output matches system-check header (`/System Check|Health Check|Diagnostics/i`)
4. Assert each dependency name appears: Node.js, npm, Python, uv
5. Assert no unhandled exception in output

**Implementation notes:**
- Already partially covered by existing `doctor.test.ts` — extend it rather than replace
- Windows requires 60 s timeout

---

### TC-002 — codemie doctor --verbose

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/doctor.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Clean isolated `CODEMIE_HOME` |
| **Command** | `node bin/codemie.js doctor --verbose` |
| **Expected exit code** | 0 or 1 |
| **Expected output contains** | Log file path or `CODEMIE_DEBUG` indicator |

**Steps:**
1. `setupTestIsolation()`
2. Run `codemie doctor --verbose`
3. Assert command does not crash
4. Assert output is more verbose than TC-001 (e.g. longer output length, or contains debug path)

---

### TC-003 — codemie doctor with JWT profile

**Category:** CLI Management — Happy flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/doctor.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | `CODEMIE_HOME` contains a `jwt-autotest` profile with `authMethod: jwt` |
| **Command** | `node bin/codemie.js doctor` |
| **Expected output contains** | Active profile name, JWT auth method, token validity |

**Steps:**
1. `fetchJwtToken()` → write `jwt-autotest` profile to isolated config
2. Set profile `authMethod: 'jwt'`, `jwtToken: <token>`, `provider: 'bearer-auth'`, `model: CI_CODEMIE_MODEL`
3. Run `codemie doctor`
4. Assert output contains profile name `jwt-autotest`
5. Assert JWT auth check section appears and shows token not expired

---

### TC-004 — Create profile via codemie setup (JWT / bearer-auth)

**Category:** CLI Management — Happy flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Isolated `CODEMIE_HOME`, JWT token available |
| **Approach** | Write profile config directly to `codemie-cli.config.json` (mirrors existing `claude-cli-task.test.ts`) |
| **Verification** | `node bin/codemie.js profile` lists the new profile |

**Steps:**
1. `fetchJwtToken()` → write profile `jwt-autotest` directly to `~/.codemie/codemie-cli.config.json`:
   ```json
   { "version": 2, "activeProfile": "jwt-autotest",
     "profiles": { "jwt-autotest": { "name": "jwt-autotest",
       "provider": "bearer-auth", "authMethod": "jwt",
       "codeMieUrl": "<CI_CODEMIE_URL>", "baseUrl": "<CI_CODEMIE_API_DOMAIN>",
       "model": "<CI_CODEMIE_MODEL>" } } }
   ```
2. Run `codemie profile` — assert `jwt-autotest` appears in output
3. Run `codemie profile status` — assert profile name and provider shown

---

### TC-005 — List profiles

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Two profiles exist: `jwt-autotest` and `jwt-secondary` |
| **Command** | `node bin/codemie.js profile` |
| **Expected output** | Both profile names appear |

**Steps:**
1. Write config with two profiles
2. Run `codemie profile`
3. Assert both `jwt-autotest` and `jwt-secondary` appear in output

---

### TC-006 — Switch profile

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Two profiles exist, `jwt-autotest` is active |
| **Command** | `node bin/codemie.js profile switch jwt-secondary` |
| **Expected exit code** | 0 |
| **Verification** | `profile status` shows `jwt-secondary` as active |

**Steps:**
1. Write config with two profiles, `activeProfile: 'jwt-autotest'`
2. Run `codemie profile switch jwt-secondary`
3. Assert exit code 0
4. Run `codemie profile status` — assert `jwt-secondary` shown as active
5. Assert config file `activeProfile` = `jwt-secondary`

---

### TC-007 — Delete profile

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Two profiles exist, `jwt-secondary` is NOT active |
| **Command** | `node bin/codemie.js profile delete jwt-secondary -y` |
| **Expected exit code** | 0 |
| **Verification** | `profile` listing no longer shows `jwt-secondary` |

**Steps:**
1. Write config with two profiles
2. Run `codemie profile delete jwt-secondary -y`
3. Assert exit code 0
4. Run `codemie profile` — assert `jwt-secondary` is NOT in output
5. Assert `jwt-autotest` still appears (not accidentally deleted)

---

### TC-008 — Delete active profile (negative)

**Category:** CLI Management — Negative flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | One profile `jwt-autotest` exists and is active |
| **Command** | `node bin/codemie.js profile delete jwt-autotest -y` |
| **Expected** | Error message or non-zero exit code; profile must NOT be deleted |

**Steps:**
1. Write config with one active profile
2. Run `codemie profile delete jwt-autotest -y`
3. Assert exit code ≠ 0 OR output contains warning about deleting active profile
4. Assert profile still exists in config

---

### TC-009 — Profile rename

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Profile `jwt-autotest` exists |
| **Command** | `node bin/codemie.js profile rename jwt-autotest jwt-renamed` |
| **Expected exit code** | 0 |
| **Verification** | `profile` output shows `jwt-renamed`, not `jwt-autotest` |

**Steps:**
1. Write config with `jwt-autotest` profile
2. Run `codemie profile rename jwt-autotest jwt-renamed`
3. Assert exit code 0
4. Run `codemie profile` — assert `jwt-renamed` in output, `jwt-autotest` absent

---

### TC-010 — Profile status (no profiles configured — negative)

**Category:** CLI Management — Negative flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Empty `CODEMIE_HOME`, no config |
| **Command** | `node bin/codemie.js profile status` |
| **Expected** | Informative message (not crash); exit code 0 or 1 |

**Steps:**
1. `setupTestIsolation()` — clean home
2. Run `codemie profile status`
3. Assert no unhandled exception
4. Assert output is defined and non-empty

---

### TC-011 — Skills add (unauthenticated — negative)

**Category:** CLI Management — Negative flow  
**Target file:** `tests/integration/cli-commands/skills.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Empty `CODEMIE_HOME` (no credentials) |
| **Command** | `node bin/codemie.js skills add owner/repo -y` |
| **Expected exit code** | 1 |
| **Expected output** | Auth error: `SSO authentication required` or `No CodeMie URL configured` |

**Steps:**
1. `setupTestIsolation()` — clean home, no credentials
2. Run `codemie skills add owner/repo -y`
3. Assert exit code 1
4. Assert stderr/output contains auth error message
5. Assert skills CLI binary was NOT invoked (no side effects)

**Implementation notes:** Already partially covered by `skills.test.ts` — verify unauthenticated path

---

### TC-012 — Skills add, list, remove (authenticated)

**Category:** CLI Management — Happy flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/skills.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT profile, a known public skill source available |
| **Command sequence** | `skills add`, `skills list`, `skills remove` |

**Steps:**
1. Write `jwt-autotest` profile with JWT token
2. Run `codemie skills add $CI_CODEMIE_SKILL_SOURCE -a claude-code -y`
3. Assert exit code 0
4. Run `codemie skills list -a claude-code`
5. Assert the installed skill name appears in output
6. Run `codemie skills remove -s <skill-name-derived-from-source> -a claude-code -y`
7. Assert exit code 0
8. Run `codemie skills list -a claude-code` again
9. Assert skill no longer listed

---

### TC-013 — Skills add (invalid source — negative)

**Category:** CLI Management — Negative flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/skills.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT profile |
| **Command** | `codemie skills add nonexistent-owner/nonexistent-repo-xyz -y` |
| **Expected exit code** | Non-zero |
| **Expected output** | Error message about not found or invalid source |

---

### TC-014 — Assistants setup, list, remove

**Category:** CLI Management — Happy flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/assistants.test.ts` (new file)

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT profile, at least one assistant available in CodeMie API |
| **Approach** | Directly write assistant registration file rather than driving interactive wizard |

**Steps:**
1. Write `jwt-autotest` profile
2. Run `node bin/codemie.js setup assistants` — use stdin injection or config file approach to select an assistant non-interactively (or use `CODEMIE_ASSISTANT_ID` env override if available)
3. Verify assistant config file written to `~/.codemie/agents/claude/` or equivalent
4. Run `codemie assistants chat <id> "ping"` (or equivalent list command)
5. Assert assistant is reachable / listed
6. Remove assistant registration (run setup again and deselect, or delete config file)
7. Assert assistant no longer listed

**Implementation notes:** The assistant setup wizard is interactive (`inquirer`). For CI, inject answers via `stdin` or use a JSON config file to pre-seed selections.

---

### TC-015 — Assistants chat (invalid assistant — negative)

**Category:** CLI Management — Negative flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/assistants.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT profile |
| **Command** | `node bin/codemie.js assistants chat nonexistent-assistant-id "hello"` |
| **Expected exit code** | Non-zero |
| **Expected output** | Not found or error message |

---

## Agent Session Tests (JWT)

Target files: `tests/integration/agent-jwt-*.test.ts` (new files)  
Runner: `spawnSync('node', [CLAUDE_BIN, '--task', '...', '--jwt-token', token])`  
Isolation: isolated `CODEMIE_HOME` + isolated temp working dir  
Gating: `INCLUDE_JWT_TESTS`

**Common setup (all agent session tests):**
```typescript
beforeAll(async () => {
  jwtToken = await fetchJwtToken();
  // Build dist/ and npm link (same as existing claude-cli-task.test.ts)
});
```

---

### TC-016 — Agent runs successfully with JWT token

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/agent-jwt-basic.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT token, no pre-existing profile needed |
| **Command** | `node bin/codemie-claude.js --task "Say hello" --jwt-token <token>` |
| **Expected exit code** | 0 |
| **Expected** | Non-empty stdout, session file written to `CODEMIE_HOME/sessions/` |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. Run `codemie-claude --task "Say the word READY and nothing else" --jwt-token <token>` in temp dir
3. Assert exit code 0
4. Assert stdout contains `READY` (or equivalent agent output)
5. Assert session `.json` file written to sessions dir

---

### TC-017 — Agent runs with specific profile + JWT token override

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/agent-jwt-basic.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | `jwt-autotest` profile written to config; valid JWT token |
| **Command** | `node bin/codemie-claude.js --profile jwt-autotest --jwt-token <token> --task "Say READY"` |
| **Expected** | Exit 0, output contains `READY`, session uses `jwt-autotest` profile |

**Steps:**
1. Write `jwt-autotest` profile to config (any provider, model set)
2. `fetchJwtToken()` → `jwtToken`
3. Run with `--profile jwt-autotest --jwt-token <jwtToken>`
4. Assert exit code 0
5. Assert session `.json` `provider` field matches `bearer-auth`

---

### TC-018 — Agent with expired/invalid JWT token (negative)

**Category:** Agent Session — Negative flow  
**Target file:** `tests/integration/agent-jwt-basic.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | None |
| **Command** | `node bin/codemie-claude.js --task "Say hello" --jwt-token INVALID_TOKEN_VALUE` |
| **Expected exit code** | Non-zero |
| **Expected output** | Auth error or 401 response message |

**Steps:**
1. Run with `--jwt-token INVALID_TOKEN_VALUE`
2. Assert exit code ≠ 0
3. Assert stderr or stdout contains auth/unauthorized indicator

---

### TC-019 — Agent with no profile and no JWT (negative)

**Category:** Agent Session — Negative flow  
**Target file:** `tests/integration/agent-jwt-basic.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Empty `CODEMIE_HOME` |
| **Command** | `node bin/codemie-claude.js --task "Say hello"` |
| **Expected exit code** | Non-zero |
| **Expected output** | "No profile", "not configured", or setup prompt |

---

### TC-020 — Profile with specific model — verify model used in session

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/agent-jwt-models.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Two profiles: one with `claude-sonnet-4-6`, one with `claude-haiku-4-5-20251001` |
| **Verification** | Session `.json` `model` field matches the profile's configured model |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. Write two profiles: `profile-sonnet` (model: `claude-sonnet-4-6`) and `profile-haiku` (model: `claude-haiku-4-5-20251001`)
3. Run `codemie-claude --profile profile-sonnet --jwt-token <token> --task "Say READY"`
4. Read session `.json` — assert `model` = `claude-sonnet-4-6`
5. Run `codemie-claude --profile profile-haiku --jwt-token <token> --task "Say READY"`
6. Read session `.json` — assert `model` = `claude-haiku-4-5-20251001`

---

### TC-021 — Haiku / Sonnet / Opus model tiers assigned correctly

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/agent-jwt-models.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | JWT profile, model that triggers auto-tier selection |
| **Verification** | Session config contains `haikuModel`, `sonnetModel`, `opusModel` distinct values |

**Steps:**
1. Write profile with model `claude-sonnet-4-6` (triggers `autoSelectModelTiers`)
2. Run agent with `--task "Say READY"`
3. Inspect session `.json` or config passed to agent for `haikuModel` / `sonnetModel` / `opusModel`
4. Assert all three tiers are set and are different model IDs
5. Assert `sonnetModel` = `claude-sonnet-4-6` (the explicitly chosen model)

---

### TC-022 — codemie models list

**Category:** CLI Management — Happy flow  
**Gating:** `INCLUDE_JWT_TESTS`  
**Target file:** `tests/integration/cli-commands/models.test.ts` (new file)

| Field | Value |
|---|---|
| **Preconditions** | `jwt-autotest` profile configured |
| **Command** | `node bin/codemie.js models list` |
| **Expected exit code** | 0 |
| **Expected output** | Table with at least one model name (e.g. `claude-sonnet`) |

**Steps:**
1. Write `jwt-autotest` profile with JWT token
2. Run `codemie models list`
3. Assert exit code 0
4. Assert output contains at least one known model name pattern (`/claude|gpt/i`)

---

### TC-023 — Migrate existing SSO task test to JWT

**Category:** Agent Session — Happy flow (migrate from SSO)  
**Target file:** `tests/integration/claude-cli-task.test.ts` (existing — add JWT variant)

| Field | Value |
|---|---|
| **Preconditions** | Valid JWT token |
| **Gating** | `INCLUDE_JWT_TESTS` (existing test stays under `INCLUDE_SSO_TESTS`) |

**Steps:**  
*(Same steps as existing test — add a `describe.runIf(INCLUDE_JWT_TESTS)` block that:)*
1. Writes a `jwt-autotest` bearer-auth profile (no SSO)
2. Runs `codemie-claude --task "Create java file..." --jwt-token <token>`
3. Validates Java file creation, session file, metrics file, conversation file (identical assertions to existing test)

---

## Interactive Session Tests

Target file: `tests/integration/agent-interactive-session.test.ts` (new file)  
Approach: `spawn()` (async, non-blocking) + write to stdin + read stdout  
Gating: `INCLUDE_JWT_TESTS`  
Timeout: 3–5 minutes per test

**Common pattern:**
```typescript
import { spawn } from 'child_process';

function startAgent(args: string[]): ChildProcess {
  return spawn('node', [CLAUDE_BIN, ...args], {
    env: { ...cleanEnv(), CODEMIE_JWT_TOKEN: jwtToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
```

---

### TC-024 — Change model in-session via /model (slash command)

**Category:** Interactive Session — Happy flow  
**Target file:** `tests/integration/agent-interactive-session.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | JWT token; `codemie-claude` or `codemie-code` binary built |
| **Verification** | After sending `/model <new-model>` (or `/models` depending on agent), subsequent session uses new model |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. `spawn` agent with `--jwt-token <token>` (interactive mode, no `--task`)
3. Wait for agent ready prompt (stdout contains `>` or `Human:` pattern)
4. Write `/model claude-haiku-4-5-20251001\n` to stdin (use `/models` if the agent uses that command variant)
5. Wait for acknowledgement in stdout (model name appears)
6. Write `Say the word CONFIRMED\n` to stdin
7. Wait for response containing `CONFIRMED`
8. Kill process cleanly
9. Assert no error exit

**Implementation notes:**
- Claude Code responds to `/model <name>` to switch models in-session
- Use a polling loop on stdout with a timeout (30–60 s) for each expected output
- Consider using `readline` interface on stdout

---

### TC-025 — Trigger a skill inside a running agent session

**Category:** Interactive Session — Happy flow  
**Target file:** `tests/integration/agent-interactive-session.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | JWT profile; a skill installed for the agent via `skills add` |
| **Verification** | Skill invocation is acknowledged in session output |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. Run `codemie skills add <skill-source> -a claude-code -y` to install a skill
3. `spawn` agent in interactive mode
4. Wait for agent ready
5. Invoke skill via its slash command (e.g. `/<skill-name>\n`)
6. Assert skill response appears in stdout
7. Teardown: `codemie skills remove -s <skill-name> -y`

---

### TC-026 — Trigger assistant chat (non-interactive via CLI)

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/agent-interactive-session.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | JWT profile; assistant registered |
| **Command** | `node bin/codemie.js assistants chat <assistant-id> "Say PONG"` |
| **Expected exit code** | 0 |
| **Expected output** | `PONG` or assistant response |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. Ensure assistant `$CI_CODEMIE_ASSISTANT_ID` is registered in profile
3. Write `jwt-autotest` profile with JWT token and assistant registered
4. Set `CODEMIE_JWT_TOKEN=<token>` in subprocess env (since `--jwt-token` is on agent launchers, not on `codemie assistants chat`)
5. Run `node bin/codemie.js assistants chat $CI_CODEMIE_ASSISTANT_ID "Say PONG"` with JWT token in env
6. Assert exit code 0
7. Assert output contains response from assistant (non-empty, contains `PONG`)

---

## Budget & Project Tests

Target file: `tests/integration/agent-jwt-budget.test.ts` (new file)  
Gating: `INCLUDE_JWT_TESTS`

---

### TC-027 — Project with all 3 budgets — litellm key NOT shown during setup

**Category:** Budget / Project — Happy flow  
**Target file:** `tests/integration/agent-jwt-budget.test.ts`

**Background:** When a user's assigned project has all three budget types (premium, platform, cli), the CodeMie API returns integrations for all of them. The setup wizard should NOT prompt the user to enter LiteLLM API keys in this case — the integration is resolved server-side via the project header.

| Field | Value |
|---|---|
| **Preconditions** | JWT token; `CI_CODEMIE_PROJECT_ALL_BUDGETS` env var set to a project name with all 3 budgets |
| **Verification** | Profile config written with `codeMieIntegration` set (auto-resolved); no `litellmApiKey` in config |

**Steps:**
1. `fetchJwtToken()` → `jwtToken`
2. Call the CodeMie API directly to retrieve integrations for `CI_CODEMIE_PROJECT_ALL_BUDGETS`:
   ```
   GET <CI_CODEMIE_API_DOMAIN>/api/integrations?project=<CI_CODEMIE_PROJECT_ALL_BUDGETS>
   Authorization: Bearer <jwtToken>
   ```
3. Assert response contains 3 integrations (premium, platform, cli)
4. Write a profile that sets `codeMieProject: CI_CODEMIE_PROJECT_ALL_BUDGETS` and `authMethod: jwt`
5. Run agent: `codemie-claude --profile <name> --jwt-token <token> --task "Say READY"`
6. Assert exit code 0
7. Read profile config — assert no `litellmApiKey` field present
8. Assert `codeMieIntegration` is populated with the auto-resolved integration

**Implementation notes:**
- This test validates the server-side routing logic (correct `X-CodeMie-Integration` header is sent)
- The "no litellm key shown" assertion is on the profile config, not on interactive wizard output
- For interactive setup wizard coverage, see the manual test supplement below

---

### TC-028 — Project with all 3 budgets — agent completes task successfully

**Category:** Budget / Project — Happy flow  
**Target file:** `tests/integration/agent-jwt-budget.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Profile with `codeMieProject: CI_CODEMIE_PROJECT_ALL_BUDGETS`, JWT token |
| **Verification** | Agent completes task; `X-CodeMie-Integration` header injected (verifiable via proxy logs or session metadata) |

**Steps:**
1. Write profile with `codeMieProject` set, `authMethod: jwt`
2. `fetchJwtToken()` → `jwtToken`
3. Run `codemie-claude --profile <name> --jwt-token <token> --task "Say READY"`
4. Assert exit code 0
5. Assert session `.json` written; `provider` = `bearer-auth`

---

## Additional Critical Path Tests

### TC-029 — codemie version

**Category:** CLI Management — Happy flow (sanity)  
**Target file:** `tests/integration/cli-commands/version.test.ts` (already exists — verify coverage)

| Field | Value |
|---|---|
| **Command** | `node bin/codemie.js version` |
| **Expected** | Exit 0, output matches `/\d+\.\d+\.\d+/` |

---

### TC-030 — codemie list (installed agents)

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/cli-commands/list.test.ts` (check existing)

| Field | Value |
|---|---|
| **Command** | `node bin/codemie.js list` |
| **Expected** | Exit 0, output lists known agent names (`claude`, `codex`, `gemini`, etc.) |

---

### TC-031 — Agent health check

**Category:** CLI Management — Happy flow  
**Target file:** `tests/integration/agent-jwt-basic.test.ts`

| Field | Value |
|---|---|
| **Command** | `node bin/codemie-claude.js health` |
| **Expected exit code** | 0 |
| **Expected output** | Installation status, binary path |

---

### TC-032 — codemie profile switch to non-existent profile (negative)

**Category:** CLI Management — Negative flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | One profile exists |
| **Command** | `node bin/codemie.js profile switch does-not-exist` |
| **Expected exit code** | Non-zero |
| **Expected output** | Not found error |

---

### TC-033 — codemie profile rename to existing name (negative)

**Category:** CLI Management — Negative flow  
**Target file:** `tests/integration/cli-commands/profile.test.ts`

| Field | Value |
|---|---|
| **Preconditions** | Two profiles: `profile-a`, `profile-b` |
| **Command** | `node bin/codemie.js profile rename profile-a profile-b` |
| **Expected** | Error or non-zero exit; neither profile corrupted |

---

### TC-034 — Agent task mode: file is created and verified (JWT version of existing test)

**Category:** Agent Session — Happy flow  
**Target file:** `tests/integration/claude-cli-task.test.ts` (add JWT block)  
*(See TC-023 — this is the implementation of that migration)*

---

## Implementation Notes

### File layout

```
tests/
  integration/
    cli-commands/
      doctor.test.ts          ← TC-001, TC-002, TC-003
      profile.test.ts         ← TC-004..TC-010, TC-032, TC-033
      skills.test.ts          ← TC-011..TC-013
      assistants.test.ts      ← (no TCs — new file placeholder)
      models.test.ts          ← TC-022           [new file]
      version.test.ts         ← TC-029           [exists]
      list.test.ts            ← TC-030           [exists]
    agent-jwt-basic.test.ts   ← TC-016..TC-019, TC-031  [new file]
    agent-jwt-models.test.ts  ← TC-020, TC-021          [new file]
    agent-jwt-budget.test.ts  ← TC-027, TC-028          [new file]
    agent-interactive-session.test.ts ← TC-014, TC-015, TC-024..TC-026  [new file]
    claude-cli-task.test.ts   ← TC-023, TC-034  [extend existing]
  helpers/
    jwt-auth.ts               ← fetchJwtToken() helper  [new file]
```

### Gating summary

| Test group | Env var | Default |
|---|---|---|
| SSO-based tests (existing) | `INCLUDE_SSO_TESTS=true` | skipped |
| JWT-based tests (new) | `INCLUDE_JWT_TESTS=true` | skipped |
| CLI-only tests (no auth) | always on | run |

### Interactive session test approach

For TC-024 and TC-025 which require stdin/stdout interaction with a running agent:
- Use `spawn()` (async) not `spawnSync()` 
- Wrap stdout in a readline stream
- Use a `waitForOutput(pattern, timeoutMs)` helper that resolves when the pattern matches
- Send stdin lines via `child.stdin.write(line + '\n')`
- Always clean up with `child.kill()` in `afterEach`

### Config writing pattern

All tests that need a pre-configured profile should write directly to `CODEMIE_HOME/codemie-cli.config.json` rather than driving the interactive setup wizard. This mirrors the pattern in the existing `claude-cli-task.test.ts`.

### Build requirement

All agent session tests require a pre-built `dist/`. The `beforeAll` hook should run `npm run build` and `npm link` (same as existing test), or the CI pipeline should build before running the integration test suite.

---

## To Be Implemented in Future

### Missing Entirely

These test cases are specified but have not been created.

#### TC-023 — Migrate existing SSO task test to JWT
#### TC-034 — Agent task mode: file is created and verified (JWT version)

**Why missing:** Both target `tests/integration/claude-cli-task.test.ts`, listed as "extend existing" in the original spec. That file does not exist in the repository. These two TCs represent the same work: add a `describe.runIf(INCLUDE_JWT_TESTS)` block to the existing SSO task test that re-runs the Java file creation scenario using JWT auth instead of SSO.

**What to do:** Create `tests/integration/claude-cli-task.test.ts` (or locate the pre-existing SSO-gated version if it was renamed) and add the JWT variant block per the step-by-step in TC-023 / TC-034.

---

### Present but Unlabeled / Weaker Than Spec

These test cases are functionally covered by existing tests but lack the explicit `TC-XXX` describe label and/or miss specific assertions called out in the spec.

#### TC-001 — codemie doctor (no profile configured)
- **Current state:** The basic `describe('Doctor Command', ...)` block in `cli-commands/doctor.test.ts` covers the dependency checks, but there is no `TC-001` label and no explicit assertion for the `/System Check|Health Check|Diagnostics/i` pattern.
- **What to do:** Add a `describe('TC-001 — doctor no profile', ...)` block with `setupTestIsolation()` (empty `CODEMIE_HOME`) and assert the diagnostics header pattern.

#### TC-011 — Skills add (unauthenticated — negative)
- **Current state:** `"blocks every subcommand on unauthenticated invocation (spec §7)"` in `cli-commands/skills.test.ts` covers the auth gate but is not labeled TC-011 and does not assert the specific error messages `"SSO authentication required"` or `"No CodeMie URL configured"`.
- **What to do:** Label the existing test as TC-011 and tighten the output assertion to match one of those two expected strings.

#### TC-029 — codemie version
- **Current state:** `version.test.ts` has `"should display version number"` and `"should complete successfully"` which cover the behaviour.
- **What to do:** Add the `TC-029` label to the describe block.

#### TC-030 — codemie list (installed agents)
- **Current state:** `list.test.ts` has `"should list all available agents"` and `"should complete successfully"`.
- **What to do:** Add the `TC-030` label to the describe block.

---

### Assertion Deviations from Spec

These test cases exist and are labeled but their assertions are weaker or different from what the spec prescribes.

#### TC-008 — Delete active profile (negative)
- **Spec assertion:** Exit code ≠ 0 **OR** output contains a warning about deleting the active profile; profile must NOT be deleted.
- **Current assertion:** `"does not crash (exit 0 or 1) when deleting the active profile"` — accepts any exit code, does not check for a warning message.
- **What to do:** Add an assertion that either `result.exitCode !== 0` or `result.output` matches a warning pattern (e.g. `/active profile|cannot delete/i`).

#### TC-020 — Profile with specific model — verify model used in session
- **Spec assertion:** Read the session `.json` file and assert the `model` field equals the profile's configured model ID.
- **Current assertion:** Checks that the `metrics models array` contains the model name — a different data source and a looser match.
- **What to do:** After the agent run, locate the session `.json` in `CODEMIE_HOME/sessions/` and assert `session.model === 'claude-sonnet-4-6'` (and equivalent for haiku), in addition to or instead of the metrics array check.
