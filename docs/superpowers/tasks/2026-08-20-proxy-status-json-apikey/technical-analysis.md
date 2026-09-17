# Technical Research

**Task**: proxy status cli command
**Generated**: 2026-08-20
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14308: Add API Key info and JSON output option to codemie proxy status. Enhance the `codemie proxy status` command so users can see API Key information in the status output (static value `codemie-proxy`) and can optionally retrieve the same status information as valid JSON via a new `--json` flag. Existing human-readable output must remain the default when `--json` is not passed. Acceptance criteria: output includes API Key info (static value `codemie-proxy`); new `--json` flag added; `--json` returns valid JSON including the API Key info; without `--json` existing human-readable output is preserved; no regressions otherwise.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/index.ts` — defines `createProxyCommand()`; the `status` subcommand (lines ~190-238) is the target for the new `--json` flag and the API Key line.
- `src/cli/commands/proxy/health-check.ts` — `checkProxyHealth()`; returns `ProxyHealthResult { healthy, level, code, reason }`, used to build the `Status:` line.
- `src/cli/commands/proxy/daemon-manager.ts` — `DaemonState` interface includes `gatewayKey: string`. `checkStatus()`/`readState()` read persisted daemon state. `spawnDaemon()` defaults `gatewayKey` to the literal `'codemie-proxy'` (line 98: `const gatewayKey = opts.gatewayKey ?? 'codemie-proxy';`).
- `src/bin/proxy-daemon.ts` — daemon entrypoint; also defaults `--gateway-key` to `'codemie-proxy'` (line 63).
- `src/cli/commands/proxy/connect-orchestrator.ts` — already surfaces `state.gatewayKey` to users as "API key" text when connecting external clients (e.g. line 473: `4. Enter API key: ${state.gatewayKey}`).
- `src/cli/commands/sdk/utils/cli-utils.ts` — existing `outputJson(data: unknown): void` helper (`console.log(JSON.stringify(data, null, 2))`), used by the `sdk` command tree; a candidate for reuse or a local equivalent in `proxy/`.
- `src/cli/commands/skills/list.ts` and `src/cli/commands/skills/find.ts` — existing `--json` flag precedent: `.option('--json', 'emit machine-readable JSON instead of the formatted output')`, branching `if (options.json) {...} else {...}`.
- `src/cli/commands/proxy/__tests__/index.test.ts` — existing `describe('proxy status', ...)` block (from ~line 500) asserting exact `console.log` call strings; the file mocks `checkStatus`/`checkProxyHealth`/`daemon-manager.js`/`health-check.js`.

### Architecture and Layers Affected

CLI command layer (`src/cli/commands/proxy/index.ts`, Commander-based) → daemon-manager layer (`daemon-manager.ts`, state persisted at `~/.codemie/proxy-daemon.json`) → health-check layer (`health-check.ts`, HTTP calls to the running daemon) → daemon process (`src/bin/proxy-daemon.ts`). Only the CLI command layer needs code changes; daemon-manager/health-check already expose the data needed (`gatewayKey` on `DaemonState`).

### Integration Points

- `proxy/index.ts` imports `checkStatus`, `readState`, `spawnDaemon`, `stopDaemon` from `daemon-manager.ts`, and `checkProxyHealth` from `health-check.ts`.
- `connect-orchestrator.ts` also reads `state.gatewayKey`, confirming `gatewayKey` is the established source of the "API key" concept elsewhere in the CLI — no new field or config is needed.

### Patterns and Conventions

- Commander pattern: `.command('status').option(...).action(async (opts) => {...})`, consistent across all `proxy` subcommands.
- Human-readable output uses `console.log` + `chalk` (`chalk.green`, `chalk.yellow`); no existing JSON branch inside `proxy/index.ts` itself.
- Repo-wide `--json` convention (from `skills/list.ts`, `skills/find.ts`): boolean option literally named `--json`, with the JSON branch checked first in the action handler, formatted output as the `else`.
- `outputJson()` in `sdk/utils/cli-utils.ts` is the reusable JSON-printing helper (`JSON.stringify(data, null, 2)` via `console.log`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/exposed-api.md` documents `CodeMieProxy`/`getPluginRegistry` at the plugin-architecture level but does not document the `proxy status` CLI subcommand or its output contract.
- `.ai-run/guides/usage/project-config.md`, `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/standards/code-quality.md` exist but none cover a repo-wide `--json` output convention specifically.

### Architectural Decisions

None found — no ADRs under `docs/` reference `proxy status`.

### Derived Conventions

- New Commander options are added inline via `.option('--flag <desc>', 'description')` chained on `.command('status')`.
- JSON output convention: `--json` flag + `if (options.json) {...} else {...}` branch, matching `skills/list.ts` / `skills/find.ts`.
- The "API Key" the ticket describes is exactly the existing `gatewayKey` value already defaulted to `'codemie-proxy'` in `daemon-manager.ts` and `bin/proxy-daemon.ts`, and already labeled "API key" for users in `connect-orchestrator.ts`. The natural implementation is to print `state.gatewayKey` labeled "API Key" in the human-readable branch, and include it (plus the other status fields already computed: healthy/status, url, port, profile, clientType, project, uptime) in the JSON object emitted for `--json`.

---

## 4. Testing Landscape

### Existing Coverage

`src/cli/commands/proxy/__tests__/index.test.ts` has a `describe('proxy status', ...)` block with a test asserting exact `console.log` call strings, using a `DaemonState` mock (`gatewayKey: 'local-key'`) and mocking `checkStatus`/`checkProxyHealth` via dynamic `await import(...)` of `daemon-manager.js`/`health-check.js`/`index.js`.

### Testing Framework and Patterns

Vitest (`vitest run --project unit`, `--project cli`). Pattern: `vi.mock(...)` + dynamic `await import(...)` for mocked modules (per AGENTS.md dynamic-import-mocking convention), `vi.spyOn(console, 'log')` + `vi.mocked(...)` assertions on exact log strings.

### Coverage Gaps

No existing test exercises the "Status: stopped" branch, `--deep` combined with unhealthy states, or any `--json` output. The new `--json` flag and API Key line are entirely new test surface.

---

## 5. Configuration and Environment

### Environment Variables

None tied to `proxy status`; the gateway key is passed as a CLI arg (`--gateway-key`) to the daemon process, not via env var.

### Configuration Files

Only the runtime state file `~/.codemie/proxy-daemon.json` (written/read by `daemon-manager.ts` via `writeState`/`readState`, `DEFAULT_STATE_FILE = join(getCodemieHome(), 'proxy-daemon.json')`).

### Feature Flags and Deployment Concerns

None found.

---

## 6. Risk Indicators

- Zero existing test coverage for `--json` output or the "stopped" status branch — new tests (if requested) have no template to copy verbatim; must be written from the existing `console.log`-assertion pattern.
- `proxy/index.ts`'s status handler builds its human-readable lines incrementally across multiple conditional branches (running/stopped, healthy/unhealthy, `--deep`); the JSON payload must be assembled consistently regardless of which branch is taken, or the JSON output will silently omit fields depending on daemon state.
- No repo-wide documented JSON-schema/contract for `--json` outputs — the shape must be inferred from the `skills/list.ts`/`skills/find.ts` precedent and kept internally consistent (field naming, nesting).
- The existing test file asserts *exact* `console.log` strings; adding the API Key line to the human-readable branch will require updating those exact-string assertions, or they will start failing even though behavior is correct (only relevant if tests are explicitly requested per AGENTS.md).

---

## 7. Summary for Complexity Assessment

This is a single-file, additive change confined to the CLI command layer: `src/cli/commands/proxy/index.ts`'s `status` subcommand gains one new Commander option (`--json`) and one new human-readable line ("API Key: codemie-proxy"), plus a JSON-serialization branch. All underlying data (`gatewayKey`, health/status fields) already exists on `DaemonState`/`ProxyHealthResult` returned by `daemon-manager.ts` and `health-check.ts` — no new data plumbing, no new config, no env vars, and no cross-service integration is required.

Technical novelty is low: the repo already has two other commands (`skills/list.ts`, `skills/find.ts`) and a reusable `outputJson()` helper establishing the `--json` convention, so this is pattern-following rather than pattern-inventing. The main risk is consistency — assembling the same set of fields into the JSON object across all status branches (running/stopped, healthy/unhealthy, with/without `--deep`) — and the fact that the existing test file for `proxy status` asserts exact `console.log` strings, which will need updates if new lines are added and tests are in scope. Overall: small, low-risk, single-file addition with a clear existing convention to follow.
