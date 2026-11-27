# Technical Research

**Task**: copilot-cli plugin getVersion exec timeout version probe BaseAgentAdapter codemie update codemie list
**Generated**: 2026-11-17
**Research path**: filesystem
**Workspace root**: C:/code/codemie-dev. codemie-code was read at `main` @ `7f28135e`, package `@codemieai/code` 0.16.9. The other repositories were checked by grep only and are not git-pinned.

---

## 1. Original Context

Jira EPMCDME-16976 (Bug) "Add a bounded timeout to the GitHub Copilot CLI version probe to prevent codemie update/list from hanging indefinitely". `codemie update` and `codemie list` can hang indefinitely (no timeout, no error) when CodeMie detects the installed GitHub Copilot CLI version on a machine that has the VS Code "GitHub Copilot Chat" extension but not the standalone @github/copilot npm package. Root cause (reported, to be verified): CopilotCliPlugin.getVersion() (src/agents/plugins/copilot-cli/copilot-cli.plugin.ts:415) calls exec(this.metadata.cliCommand, ['--version']) with no ExecOptions, hence no timeout. exec() (src/utils/exec.ts:34,134-138) only arms a kill timer when options.timeout is truthy; a hung child (e.g. shim/wrapper resolved as `copilot` on PATH that blocks on stdin, stdio 'pipe', nothing writes/closes it) blocks the promise forever. getVersion() is awaited by `codemie update` (src/cli/commands/update.ts:54) and `codemie list` (src/cli/commands/list.ts:29); the identical unbounded pattern exists in BaseAgentAdapter.ts:297. Steps: machine with VS Code Copilot Chat extension, without standalone @github/copilot CLI; run `codemie update` or `codemie list`; observes forever hang. Suggested fix: pass a bounded timeout to the exec() call in CopilotCliPlugin.getVersion() (and equivalent base-class path). Reference: https://github.com/codemie-ai/codemie-code/issues/539

Scope note from the caller: verify the file:line claims, whether exec() lacks a default timeout, other `exec(...,['--version'])` callers without a timeout, and existing tests. Give a per-repository impact verdict.

---

## 2. Codebase Findings

### Repository impact

| repo-id | verdict | evidence |
|---|---|---|
| codemie-code | **affected** | Every code path in the ticket is here (see below). |
| codemie | not_affected | The only "copilot" hits are analytics, usage-attribution and alembic data (`codemie:src/codemie/service/usage_attribution/settings.py`, `codemie:src/external/alembic_cli_analytics/versions/a1c1a0000018_cli_analytics_subagent_listing.py`). No spawn of a `copilot` binary and no CLI version probe was found. The search was grep `copilot` over py/ts files (135 hits in 23 files, first 10 listed). |
| codemie-ui | not_affected | The one hit is a chat test fixture (`codemie-ui:src/store/utils/__tests__/chats.test.ts`). It is a web UI with no process-spawn path. |
| codemie-sdk | not_affected | No `copilot` hits in py/ts/js. The SDK has no agent-plugin or `update`/`list` command concept. |

Basis for the three not_affected rows: a grep for `copilot` only, not a read of each repo. The `{codemie,codemie-ui,codemie-sdk}/**` glob is a loose filter, and the head_limit of 10 means only the first 10 of the 23 matching files were seen.

### Existing Implementations

**Purpose: "`codemie update` / `codemie list` must not hang when the Copilot version probe's child process never exits."**

- `CopilotCliPlugin.getVersion()` at `codemie-code:src/agents/plugins/copilot-cli/copilot-cli.plugin.ts:443-455`.
  - It calls `exec(this.metadata.cliCommand, ['--version'])` at **line 449**, with no ExecOptions. The ticket's line 415 does not match this checkout; the class begins at line 393.
  - It parses `(\d+\.\d+\.\d+)` from stdout and falls back to the whole trimmed stdout.
  - `catch {}` returns `null`, so a rejection from `exec` (including a timeout rejection) becomes `null`.
  - `cliCommand` is `process.env.CODEMIE_COPILOT_BIN || 'copilot'` (line 208), resolved at module load. `npmPackage` is `@github/copilot` (line 207).
  - `isInstalled()` (lines 436-441) uses `commandExists(cliCommand)`, which runs `which` / `where.exe $PATH:copilot`. That is how a shim named `copilot` on PATH makes the plugin report "installed" before the version probe runs.
- `BaseAgentAdapter.getVersion()` at `codemie-code:src/agents/core/BaseAgentAdapter.ts:291-302`.
  - Line 297 is `exec(this.metadata.cliCommand, ['--version'])`, with no timeout. It returns `result.stdout.trim()` and catches to `null`.
  - The ticket's line 297 holds.
  - Copilot overrides it, so this path is reached by any plugin that does not override `getVersion`.
- `exec()` at `codemie-code:src/utils/exec.ts:36-141`.
  - The timeout is armed only under `if (options.timeout)` at **line 134**. The ticket's "34,134-138" is close: the function starts at 36 and the timer block is 134-139.
  - **No default timeout.** `timeout` is optional in `ExecOptions` (line 14).
  - `stdio` is `'pipe'` unless `interactive` is set (line 53). Nothing writes to or closes stdin.
  - On timeout it calls `child.kill()` (SIGTERM) and rejects with `Command timed out after Nms`. The `close` handler still runs afterwards but its `reject`/`resolve` is a no-op.
  - There is no SIGKILL escalation and no stdin close.
  - On `error` it rejects with `Failed to execute ...`.
- **Callers that await `getVersion()` in the reported flows:**
  - `codemie-code:src/cli/commands/update.ts:54`, inside `checkAgentForUpdate`, after `isInstalled()` at line 48. The ticket claim holds.
  - `codemie-code:src/cli/commands/list.ts:29`, inside a serial `for` loop over agents. One hung agent blocks all later agents and the frameworks section. The ticket claim holds.
- **Other callers of the same method**, which share the exposure:
  - `codemie-code:src/cli/commands/install.ts:46,129,197`
  - `codemie-code:src/cli/commands/uninstall.ts:54`
  - `codemie-code:src/cli/commands/docs.ts:129`
  - `codemie-code:src/cli/commands/setup.ts:757` (Claude only)
  - `codemie-code:src/cli/commands/doctor/checks/AgentsCheck.ts:38`
  - `codemie-code:src/agents/core/AgentCLI.ts:564` (health check) and `:860` (run-time version resolution; its catch is at `:864`)
  - `BaseAgentAdapter.ts:236` (after install)
  - `BaseAgentAdapter.ts:316`, `checkVersionCompatibility()`

**Same purpose, other unbounded `--version` probes** (`exec(..., ['--version'])` with no options). Several are not in the ticket:

| Location | Probe | Reached by |
|---|---|---|
| `src/agents/plugins/codex/codex.plugin.ts:480` | `exec(cliCommand, ['--version'])` | codex `getVersion` |
| `src/agents/plugins/gemini/gemini.plugin.ts:239` | same | gemini `getVersion` |
| `src/agents/plugins/claude/claude.plugin.ts:747` | `execVersionAtFullPath` | claude `getVersion` |
| `src/agents/plugins/claude/claude.plugin.ts:772` | same | claude `getVersion` |
| `src/agents/plugins/kimi/kimi.plugin.ts:155,166,311,320,329` | five probes | kimi |
| `src/agents/plugins/claude-code-otlp/client-version-cache.ts:39` | `exec('claude', ['--version'])` | analytics |
| `src/cli/commands/mcp/index.ts:18` | `exec(fullPath, ['--version'])` | mcp command |
| `src/cli/commands/doctor/checks/UvCheck.ts:16` | `exec('uv', ['--version'])` | doctor |
| `src/cli/commands/doctor/checks/AwsCliCheck.ts:16` | `exec('aws', ['--version'])` | doctor |

Also in the same category: `commandExists` (`src/utils/processes.ts:28-40`), which runs `which`/`where.exe` with no timeout.

**Bounded `--version` probes already in the code (the pattern):**

| Location | Timeout |
|---|---|
| `src/frameworks/core/BaseFrameworkAdapter.ts:33,69` | `{ timeout: 5000 }` |
| `src/frameworks/plugins/bmad.plugin.ts:183` | `{ timeout: 10000 }` |
| `src/frameworks/plugins/speckit.plugin.ts:217,229` | `{ timeout: 2000 }` |
| `src/utils/native-installer.ts:159-162` | `{ timeout: 5000 }`, commented "5 second timeout for version check" |
| `src/utils/processes.ts:446` | `npm --version` via `execOptions` |
| `src/utils/processes.ts:50-60` (`getCommandPath`) | optional `timeoutMs` param, passed to `exec` only when truthy |

- Under `src/agents/**`, no `exec` call for a version check carries a timeout.
- The only version-probe timeouts in the repo are in `frameworks/**`, `native-installer.ts` and `processes.ts`.

**Other touched code**
- `exec` is imported in the Copilot plugin from `../../../utils/processes.js` (`copilot-cli.plugin.ts:8`). It is not imported from `utils/exec.js`. `processes.ts` re-exports or wraps it; I did not trace the re-export.

### Decisions Already in the Code

- **Convention for bounding a CLI probe**: pass `{ timeout: <ms> }` straight to `exec()`.
  - It is inline, with a numeric literal and no shared constant (`BaseFrameworkAdapter.ts:33`, `bmad.plugin.ts:183`, `speckit.plugin.ts:217`).
  - Values in use are 2000, 5000 and 10000 ms; 5000 is the most common.
  - `claude.plugin.ts:106-114` has a separate `withTimeout` Promise.race helper, used for the pre-spawn OTLP refresh (not for `exec`).
- **`exec()` default**: it has no default timeout. Timeout is opt-in, per call (`exec.ts:134`). The alternative was a default in `exec()`. No recorded reason was found.
- **Failure semantics**: `getVersion()` returns `null` on any throw (`copilot-cli.plugin.ts:452`, `BaseAgentAdapter.ts:299`). A timeout rejection would therefore already be mapped to `null` ("not installed or unknown version") with no code change in callers.
- **Callers of `null`**:
  - `update.ts:55-57` returns `null` for the agent, so it is silently skipped.
  - `list.ts:30` shows no version.
  - `checkVersionCompatibility` (`BaseAgentAdapter.ts:325`) treats it as not compatible, with `installedVersion: null`.
- **Override pattern**: agents override `getVersion()` only. Version comparison is shared (`BaseAgentAdapter.ts:304-310` doc comment).

### Task Statements Checked Against the Code

- "`CopilotCliPlugin.getVersion()` ... `exec(cliCommand, ['--version'])` with no ExecOptions": **holds**, at line **449**. The cited line 415 is stale.
- "`exec()` only arms a kill timer when `options.timeout` is truthy": **holds** (`exec.ts:134`). Cited lines "34,134-138" are approximately right; the function begins at 36.
- "`getVersion()` is awaited by `update.ts:54` and `list.ts:29`": **holds**.
- "The identical unbounded pattern exists in BaseAgentAdapter.ts:297": **holds**.
- "A hung child blocks the promise forever": **holds by code reading**.
  - `exec` never resolves without `close` or `error`, and nothing closes stdin.
  - Not reproduced, because the contract forbids execution.
- Reported cause that a `copilot` shim from the VS Code Copilot Chat extension is on PATH and blocks on stdin: **unverified**. It concerns the behaviour of an external binary that is not in this repository. A recorded process sample or a copy of the VS Code extension's shim would settle it.
- On Windows, `exec` uses `shell: false` and `windowsHide` (`exec.ts:47-78`). Whether a `.cmd`/`.ps1` shim spawned that way resolves, errors, or hangs is **unverified**.
- "Suggested fix: bounded timeout in `exec()` call in `getVersion()` and the base-class path": **keeps an existing mechanism in place**. The shared `exec()` stays with its opt-in timeout. This is the convention in the "Bounded `--version` probes already in the code" table.
  - Consumers of the unchanged `exec()` default are listed in the next subsection.

### Consumers of Changed Contracts

What changes: the behaviour of `getVersion()` for Copilot, and for `BaseAgentAdapter` if the base class is changed too. The shared `exec()` signature is not changed by the suggested fix.

- Each overriding plugin keeps its own unbounded probe regardless of a base-class change, because they do not call `super.getVersion()`: codex `codex.plugin.ts:480`, gemini `gemini.plugin.ts:239`, kimi `kimi.plugin.ts:329`, and claude `claude.plugin.ts:756-772`. Copilot is `copilot-cli.plugin.ts:449`.
- Callers of `getVersion()` listed under Existing Implementations all handle `null`. None is documented to depend on a long-running probe.
- `claude-code-otlp/client-version-cache.ts:39` calls `exec` directly, with its own test (`__tests__/client-version-cache.test.ts`).
- If `exec()` itself were changed, every caller in the repo would be a consumer. That is a large set: search `exec(` across `src/utils`, `src/agents`, `src/cli`, `src/frameworks`. Callers that already pass long timeouts include `claude.plugin.ts:904`, `kimi.plugin.ts:193` (both 300000) and `pi.packages.ts:19` (300_000). `interactive: true` callers must not be timed out.
- Copilot subclasses or consumers of `CopilotCliPlugin`: `copilot-cli-otlp` (`src/agents/plugins/copilot-cli-otlp/`) and `copilot-chat-otlp` (`.../copilot-chat-otlp/`) exist as sibling plugins. I did not trace whether they inherit `getVersion`.

### Architecture and Layers Affected

- CLI command layer: `src/cli/commands/update.ts`, `list.ts`, and others per the caller list above.
- Agent adapter layer: `BaseAgentAdapter` and the plugins under `src/agents/plugins/*`.
- Utility layer: `src/utils/exec.ts` and `src/utils/processes.ts`.
- No DB/ORM, network or proxy layer is involved.

### Integration Points

- A child process spawned via `child_process.spawn`, with `cliCommand` from `CODEMIE_COPILOT_BIN` or `copilot`.
- No other outbound service in the probe path. `update.ts` later calls npm (`npm.getLatestVersion`, around line 88), which is outside this ticket.

### Patterns and Conventions

- Agents are registered via `AgentRegistry` (`src/agents/registry.ts`), and plugins extend `BaseAgentAdapter`.
- Inline `{ timeout: N }` option for probes.
- Failures are swallowed to `null` with `catch {}`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `codemie-code:.ai-run/guides/` exists. I did not read its contents, because the task is a narrow bug. `codemie-code:docs/` has `AGENTS.md`, `COMMANDS.md`, `CONFIGURATION.md` and others. I did not open any of them. Whether they describe the version-probe behaviour is unknown.

### Architectural Decisions
- None found for the timeout policy of `exec()` or of version probes. I searched the exec/probe code only for comments, not the docs.

### Derived Conventions
- Probes are bounded by inline `timeout` values in `frameworks/**`, `native-installer.ts` and `processes.ts`. `src/agents/**` has none.

---

## 4. Testing Landscape

### Existing Coverage
- `codemie-code:src/agents/plugins/copilot-cli/__tests__/` holds `copilot-cli.registry.test.ts`, `copilot-cli.models.test.ts` and `copilot-cli.workspace.test.ts`. None references `getVersion` or timeouts (grep for `getVersion|timeout` returned nothing). **No test covers `CopilotCliPlugin.getVersion()`.**
- `codemie-code:src/agents/core/__tests__/BaseAgentAdapter.test.ts:58` mocks `processes.js` with `exec: vi.fn()`. Its `getVersion` and `timeout` grep was empty apart from that mock, so the base `getVersion()` appears untested. I did not read the file.
- `BaseAgentAdapter.version-notice.test.ts:79` spies `getVersion` away.
- `src/cli/commands/__tests__/install.version-selection.test.ts` and `cli-misc-coverage.test.ts` mock `getVersion` with `vi.fn()`.
- `src/utils/__tests__/processes.test.ts:201-250` covers `utils/processes` `getVersion` (the npm one, line 432), not an agent probe.
- **No exec test file found**: glob `**/utils/__tests__/exec*` returned nothing. A glob for `**/exec*.test.ts` found only `src/hooks/__tests__/executor.test.ts`. I did not search whether `exec.ts` is covered under a different file name.
- Plugin tests for sibling probes: `codex.plugin.version-support.test.ts`, `kimi.plugin.test.ts`.

### Testing Framework and Patterns
- Vitest `^4.1.5` (`package.json`). Tests live in `__tests__` folders next to the code.
- They use `vi.mock` of `utils/processes.js` for `exec` and `commandExists`, and `vi.spyOn(adapter, 'getVersion')`.

### Coverage Gaps
- `CopilotCliPlugin.getVersion()`, `BaseAgentAdapter.getVersion()` and `exec()` timeout behaviour are not covered by any test I found.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_COPILOT_BIN` overrides the `copilot` command (`copilot-cli.plugin.ts:208`). It is read at module load.
- No env var for probe timeouts was found.

### Configuration Files
- None governs probe timeouts. `package.json` scripts and Vitest config were not read.

### Feature Flags and Deployment Concerns
- None found. The package is published to npm as `@codemieai/code`.

---

## 6. Risk Indicators

- The ticket's line number for the Copilot probe (415) is stale; the actual line is 449 on `main` @ `7f28135e`. Downstream docs should cite by symbol.
- Existing mechanism kept in place: `exec()` has no default timeout and the suggested fix leaves it that way (see Task Statements). Every other unbounded probe in the table above stays exposed. Consumers are listed under Consumers of Changed Contracts.
- Plugin overrides (codex, gemini, kimi, claude) do not call `super.getVersion()`, so a base-class change does not cover them. This matters if the task scope is read as "equivalent base-class path" only.
- The `exec()` timeout path calls `child.kill()` once (SIGTERM) and does not escalate or close stdin (`exec.ts:135-138`). Whether the hung `copilot` shim honours SIGTERM is unverified. The promise still rejects, so the caller is unblocked; the child may linger.
- `list.ts` probes agents serially (`list.ts:25-37`), so the worst-case delay is the timeout multiplied by the number of agents that hang.
- `isInstalled()` for Copilot is name-based on PATH (`commandExists`), so a non-Copilot `copilot` shim passes it. This is why the version probe is reached. It is untouched by the timeout fix.
- Speculative: a timeout turns the hang into `getVersion()` returning `null`, so `update` silently skips Copilot and `list` shows it installed without a version. Whether a log line is wanted is a spec decision.
- Speculative: timeout rejection from `exec` and a spawn error are both swallowed by `catch {}`. Tests would have to mock `exec` rejection to assert `null`.
- Coverage gap: no test for Copilot or base `getVersion`, so the fix has no existing regression test to extend.
- Unread: the contents of `.ai-run/guides`, `docs/`, the CHANGELOG, `copilot-cli-otlp` and `copilot-chat-otlp`. They may carry conventions or inherit `getVersion`.
- Not reproducible here: the hang is derived from code reading only. The root-cause claim about the VS Code shim is unverified.

---

## 7. Summary for Complexity Assessment

The bug is confined to **codemie-code**. The other three workspace repositories have no Copilot CLI probe, from a grep-level check. The reported root cause holds against the code, except that the Copilot call is at `copilot-cli.plugin.ts:449`, not 415. `exec()` has no default timeout and arms the kill timer only when `options.timeout` is truthy (`exec.ts:134`). `CopilotCliPlugin.getVersion()` (line 449) and `BaseAgentAdapter.getVersion()` (line 297) call it with no options. `update.ts:54` and `list.ts:29` await it.

The code change surface that the ticket names is two `exec` call sites in two files. The repository already has an inline `{ timeout: N }` convention for version probes (2000, 5000 and 10000 ms) in `frameworks/**` and `native-installer.ts`. Layers touched are the agent-adapter layer, plus the CLI command layer as a consumer. There is no schema, config, dependency or API surface involved.

Test posture is thin. There is no test for `CopilotCliPlugin.getVersion()`, none found for the base `getVersion()`, and none found for `exec()`. Vitest with a `vi.mock('processes.js')` pattern is available, and the base-adapter test already mocks `exec`. The main risk is scope. The same unbounded pattern exists in codex, gemini, claude and kimi overrides, in `client-version-cache.ts`, in `mcp/index.ts`, in the doctor checks and in `commandExists`. Those are not covered by "Copilot plus base class".

---

## 8. External References

- Jira EPMCDME-16976 and https://github.com/codemie-ai/codemie-code/issues/539. Both are named by the task as a reference. I did not fetch them: the issue is a remote URL, and this contract is read-only filesystem research. Facts from it are taken only as quoted in Section 1 and are marked unverified where they concern the external shim's behaviour.
- No local path was named as a source of truth.
