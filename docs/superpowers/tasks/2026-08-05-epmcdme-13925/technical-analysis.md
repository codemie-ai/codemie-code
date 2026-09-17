# Technical Research

**Task**: release skill agent tests validation
**Generated**: 2026-08-05T00:00:00.000Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-13925 — Adjust codemie-code release skill to include agent tests in the release process. The codemie-code release skill should be updated to include agent test execution as part of the release process. When the release skill is running, it should attempt to include the agent tests run step if technically possible. If agent tests cannot be run automatically because of restrictions related to how the agent runs tests, the release skill should clearly notify the user that agent tests must be run manually. In that case, the release process must not proceed until the user confirms that the agent tests were executed.

---

## 2. Codebase Findings

### Existing Implementations

- `scripts/release.sh` — the release skill orchestrator: bash script handling version bump (`npm version`), git commit/tag, `git push`, GitHub release creation via `gh`. Uses idempotent step-skipping and `read -p` interactive prompts at key gates. Currently has **no test execution steps**.
- `vitest.config.ts` — defines three Vitest projects:
  - `unit` — `src/**/*.test.ts`
  - `cli` — `tests/integration/` excluding `agent-*`
  - `agent` — `tests/integration/agent-*.test.ts` (requires network + auth)
- `tests/setup/agent-build-setup.ts` — `globalSetup` for the `agent` Vitest project:
  - Runs `npm run build` and `npm link`
  - Installs Claude CLI at `CLAUDE_SUPPORTED_VERSION`
  - Validates SSO or JWT credentials
  - Sets `SSO_AVAILABLE=false` and **skips gracefully** when provider is not `ai-run-sso` or credentials are absent
- `package.json` — defines `npm run test:integration:agent` → `vitest run --project agent`
- `src/agents/core/BaseAgentAdapter.ts` — base agent adapter (`run()` method); not directly involved in the release flow

### Architecture and Layers Affected

| Layer | Component | Change needed |
|---|---|---|
| Release script | `scripts/release.sh` | Add agent test gate with fallback |
| Test infrastructure | `tests/setup/agent-build-setup.ts` | Read-only reference — understand skip logic |
| Test runner config | `vitest.config.ts` | Read-only reference |
| npm scripts | `package.json` | Read-only reference |

Only one file needs modification: `scripts/release.sh`.

### Integration Points

- `npm run test:integration:agent` — the command to invoke agent tests from the release script
- `SSO_AVAILABLE` env var — set by `agent-build-setup.ts`; when `false`, agent tests are skipped at the test level but the `vitest` process may still exit `0` (no real test failures, just skips)
- `CI_IS_LOCAL_RUN` — controls auth mode (`true` = SSO, `false` = JWT/CI)
- `tests/.env.test.local` — holds `CI_CODEMIE_URL`, SSO/JWT credentials; must exist for tests to run with live credentials
- `CLAUDE_SUPPORTED_VERSION` — Claude CLI version required by `agent-build-setup.ts`

### Patterns and Conventions

- `scripts/release.sh` pattern: idempotent step checks, `read -p "... (y/N)"` user confirmation prompts, `|| { echo "⚠ warning"; }` non-fatal fallbacks
- Interactive gate pattern already used in the script for version bump confirmation and GitHub release
- The script does **not** use `set -e`; each step's exit code must be checked explicitly
- Agent tests skip gracefully in `globalSetup` when credentials are unavailable — the vitest process may exit `0` even when no tests ran

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/quality-gates.md` — defines test gates: `npm run test:unit`, `npm run test:integration`, `npm run test:integration:agent`; explicitly notes agent tests require real network and SSO/JWT auth
- `.ai-run/guides/architecture/architecture.md` — 5-layer plugin architecture reference (not directly relevant to bash release script)
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions

### Architectural Decisions

- Agent tests are segregated into their own Vitest project (`agent`) precisely because they require live network and credentials — this segregation is intentional
- `agent-build-setup.ts` silently skips rather than failing hard when credentials are absent — this is deliberate design to avoid blocking CI that lacks SSO

### Derived Conventions

- User confirmation gates in `scripts/release.sh` use `read -p "... Continue? (y/N): " confirm && [[ "$confirm" =~ ^[Yy]$ ]]` pattern
- Non-fatal steps use `|| true` or `|| { echo "warning" >&2; }` — they do NOT block the script
- The release script must explicitly check vitest exit code: `npm run test:integration:agent; exit_code=$?`

---

## 4. Testing Landscape

### Existing Coverage

Agent test files in `tests/integration/`:
- `agent-assistant.test.ts` — assistant integration (real network)
- `agent-jwt-token.test.ts` — JWT auth flow
- `agent-model.test.ts` — model tier routing
- `agent-negative.test.ts` — failure/error path coverage
- `agent-setup.test.ts` — agent setup flow
- `agent-shortcuts.test.ts` — shortcut invocations
- `agent-skills.test.ts` — skill execution
- `agent-task.test.ts` — task-mode tests
- `agent-task-session.test.ts` — task session persistence

Unit: `src/agents/core/__tests__/model-tier-config.test.ts`

### Testing Framework and Patterns

- **Vitest** with three separate projects (unit, cli, agent)
- Agent project: `globalSetup` in `agent-build-setup.ts`, 180 s testTimeout, 300 s hookTimeout, `CI_AGENT_MAX_WORKERS` workers (default 2)
- Credential loading via `dotenv` from `tests/.env.test.local`

### Coverage Gaps

- `scripts/release.sh` has **no tests** — it is a bash script, not unit-testable in Vitest
- No automated test covers the release flow itself; the new gate logic will be verified manually
- The new agent-test invocation in `release.sh` is shell code — coverage for it comes from running the release flow, not from a unit test

---

## 5. Configuration and Environment

### Environment Variables

| Var | Purpose |
|---|---|
| `CI_IS_LOCAL_RUN` | `"true"` = SSO mode (local), `"false"` = JWT/CI mode |
| `SSO_AVAILABLE` | Set by `agent-build-setup.ts`; `"false"` = credentials absent, tests skipped |
| `CI_AGENT_MAX_WORKERS` | Controls agent test parallelism |
| `CLAUDE_SUPPORTED_VERSION` | Claude CLI version required by globalSetup |
| `CI_CODEMIE_URL` | Target CodeMie instance for agent tests |

### Configuration Files

- `vitest.config.ts` — test project definitions, timeout settings
- `tests/.env.test.local` — gitignored; holds live credentials for agent tests
- `~/.codemie/codemie-cli.config.json` — user's active profile; must have `provider: "ai-run-sso"` for local SSO

### Feature Flags and Deployment Concerns

- No feature flags
- Agent tests require a running CodeMie server — not available in every environment
- `gh` CLI required for GitHub release creation (already handled gracefully in current script)

---

## 6. Risk Indicators

- **Silent skip risk**: `vitest run --project agent` may exit `0` even when `SSO_AVAILABLE=false` and no tests actually ran. The release script cannot rely solely on the vitest exit code to confirm tests ran — it must check whether tests were actually executed or skipped due to missing credentials.
- **globalSetup side effects**: `agent-build-setup.ts` runs `npm run build` and `npm link` as part of setup — these produce real side effects inside the release flow. The release.sh already runs build before this point, so this may be acceptable, but it should be verified.
- **No `set -e` in release.sh**: Exit codes must be captured explicitly (`exit_code=$?`). The agent test command failing silently is a real risk if the pattern from non-fatal steps is copy-pasted.
- **Credential availability at release time**: Local developer environments typically have SSO; CI may not. The manual-confirmation fallback must be clear about *why* the tests could not run automatically.
- **`feat/add-release-skill` branch**: Research noted a git history reference to this branch — may contain partial or conflicting work. Check before implementing.
- **no codegraph results for dimension "skill"**: The release "skill" in this context refers to `scripts/release.sh`, not a TypeScript plugin. No skill-layer TS code is involved.

---

## 7. Summary for Complexity Assessment

The change touches a single file: `scripts/release.sh`. The implementation adds a new bash gate that: (1) attempts `npm run test:integration:agent` and captures the exit code, (2) detects if tests were actually executed or silently skipped due to missing credentials, and (3) either blocks on test failure, continues on test pass, or prompts the user for manual confirmation when tests cannot run. This is a contained bash change following existing patterns already present in the script (interactive `read -p` confirmation prompts, explicit exit code checks).

The primary technical risk is the silent-skip behavior of `vitest run --project agent`: the process can exit `0` when `SSO_AVAILABLE=false` with no tests having run. The implementation must detect this scenario — likely by inspecting test output or checking an environment/signal set by `agent-build-setup.ts`. The `SSO_AVAILABLE` env var is set *inside* the vitest process's globalSetup, not exported to the parent shell, so the release script cannot read it directly. The detection strategy requires thought: either parse vitest stdout for "no tests found"/"skipped" text, or pre-check credential availability before invoking vitest.

Test coverage for this change is inherently manual — `scripts/release.sh` is a bash orchestration script and not covered by the Vitest test suite. The new gate will be verified by running a release flow in a controlled environment. No architectural layer changes, no TypeScript changes, no config file changes. Risk level is low-to-medium due to the silent-skip edge case that must be handled correctly.
