# Technical Research

**Task**: analytics repository repo_remote cwd otlp
**Generated**: 2026-10-14
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15937 CodeMie CLI Analytics. When a Claude Code session is started in a local git repository that has no remote origin, CLI Analytics displays the full local filesystem path in the Repository field. The CLI sends an empty repo_remote, and the backend currently falls back to cwd, exposing the complete local path. The Repository value should follow the same fallback approach used in CodeMie today: a parent/current directory based repository identifier (e.g. ai-assurance/pr609-preview-agents instead of /Users/lika/Projects/ai-assurance/qa-projects/pr609-preview-agents). Exact formatting must be consistent with existing CodeMie implementation. Technical observation: for affected sessions repo_remote="" and cwd=<full local path>; CLI does not send an explicit normalized repository value; backend falls back to cwd when repo_remote is empty.
Acceptance Criteria: Full local cwd never displayed as Repository; repos with valid remote keep existing owner/repo behavior; repos without remote use parent/current directory fallback; grouping based on normalized fallback not absolute path; OS username/home dir not exposed; consistent across macOS, Linux, Windows paths.
User note: reproduced locally - in DB session_dims.repository = C:\Projects\testProject2 when session run from C:\Projects\testProject2. Data ingested by the backend at C:\Projects\codemie-dev\codemie (sibling repo, Python FastAPI) — you may read it to find the existing CodeMie fallback (how repository is derived elsewhere, e.g. parent/current dir) and where session_dims.repository is populated. This repo (CLI, TypeScript, codemie-code) is the one to be changed; focus on where the CLI builds repo_remote / repository / cwd fields in the OTLP analytics pipeline (src/providers/plugins/sso/proxy/plugins/otlp-spool/, otel-analytics-override.ts, agents/plugins/claude-code-otlp/) and any existing helper that derives repository identifiers.
feature_area: analytics repository repo_remote cwd otlp

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/core/OtlpAgentAdapter.ts` — base class for hook-event ingestion. `resolveRepoFields()` (~L274) calls `detectGitBranch(cwd)` and `detectGitRemoteRepo(cwd)`, sets `repo_remote: remote ?? ''` (L283). `buildEvent()` (~L159) stamps `cwd: ctx.cwd` (the full absolute path, L169) on every event and mirrors all fields into `raw`. `OVERRIDABLE_FIELD_KEYS` (L49) lets an event's own non-empty `repo_remote` win over the stamped one. No `repository` field is sent.
- `src/utils/processes.ts` L401 `detectGitRemoteRepo(cwd)` — runs `git remote get-url origin`, regex `[:/]([^/]+)\/([^/.]+?)(?:\.git)?$` -> `owner/repo`; returns `undefined` when no remote/not git.
- `src/utils/processes.ts` L424 `resolveRepositoryName(workingDirectory)` — `detectGitRemoteRepo(...) ?? extractRepository(...)`, documented as "the same rule the metrics client applies" and "never empty". Existing helper that matches the desired behavior; currently not used by the OTLP adapter.
- `src/utils/paths.ts` L411 `extractRepository(workingDirectory)` — the existing CLI fallback: returns `Cowork` for Claude Desktop sandbox paths, else last two non-empty path segments joined by `/` (`parent/current`), single segment -> that segment, otherwise `unknown`. Uses `splitPath` / `normalizePathSeparators` (handles Windows `\`). Used by `metrics-api-client.ts:362` (`session.repository ?? extractRepository(workingDirectory)`), `ensure-session.ts`, hook.ts.
- `src/providers/plugins/sso/session/processors/metrics/metrics-post-processor.ts` L95 `truncateProjectPath` — similar last-segments truncation (uses `path.normalize`/`path.sep`, host-OS dependent); applied to `attributes.repository` in the metrics sync path (L36).
- `src/cli/commands/test-metrics.ts:120` — ad hoc `basename(dirname(cwd))/basename(cwd)`.
- `src/agents/plugins/claude-code-otlp/` — concrete adapter (extends OtlpAgentAdapter); tests in `__tests__/claude-code-otlp.plugin.test.ts` (mocks `detectGitRemoteRepo` -> `org/repo`, asserts `repo_remote`).
- `src/providers/plugins/sso/proxy/plugins/otlp-spool/` (forwarder.ts, completeness-gate.ts) — transports pre-built events to the analytics API; per its design comment the event is fully built in the hook process, the forwarder only transports. grep found no `repo_remote`/`cwd` handling there. forwarder.ts has uncommitted local modifications (git status) unrelated to this field.
- `src/providers/plugins/sso/proxy/plugins/otel-analytics-override.ts` — untracked, local-dev file: hard-codes `http://localhost:8080` and an embedded JWT token. Not part of the feature; must not be committed (see risks).

### Architecture and Layers Affected
Agent adapter layer (`src/agents/core/OtlpAgentAdapter.ts`, `claude-code-otlp`), utils (`processes.ts`, `paths.ts`). Proxy/spool layer only transports. Backend (sibling repo) is read-only context.

### Integration Points
- Hook -> `OtlpAgentAdapter.processOtlpEvent` -> `forwardOtlpEventsToSpool` -> proxy daemon spool -> `otlp-spool/forwarder.ts` -> backend CLI analytics API.
- Other callers of `detectGitRemoteRepo` (not on the OTLP path): `DesktopTelemetryRuntime.ts`, `hook.ts` (L789, L961), `skills-metrics.ts`, `pi.plugin.ts`, `BaseAgentAdapter.ts` L545.
- Backend (`C:\Projects\codemie-dev\codemie`): `repository/cli_analytics/postgres/rollups.py` L1622-1627 inserts `session_dims(repository, branch, repo_remote, ...)` using `_earliest("cwd")` for `repository`, `_earliest("repo_remote")` for `repo_remote` (i.e. `session_dims.repository` is populated from raw `cwd`). `postgres/reader.py` L180 and L574 display `coalesce(nullif(repo_remote,''), nullif(repository,''), '')` — the source of the leaked path when repo_remote is empty. The backend has no parent/current-dir normalization in this path (`cli_analytics` grep found none). The "existing CodeMie fallback" is therefore the CLI's `extractRepository` (parent/current), not a backend function. `postgres/otlp.py` L142-144 declares `cwd` and `repo_remote` event fields (MAX_PATH_BYTES limit exists).

### Patterns and Conventions
ES modules, `.js` import suffix, `@/` alias, `logger.debug`, async/await, explicit return types (AGENTS.md). Common fields are resolved at hook time in the adapter, never via forwarder callbacks (AGENTS.md OTel section; `docs/ARCHITECTURE-OTLP-PLUGIN.md`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`AGENTS.md` and `.ai-run/guides/` (architecture, development-practices, security-practices) apply; `docs/ARCHITECTURE-OTLP-PLUGIN.md` documents the adapter contract (not opened in detail). Security guide relevant to "no OS username/home exposure".

### Architectural Decisions
`resolveRepositoryName` JSDoc records the decision that every client reports one folder identically as `remote owner/repo` else `extractRepository`. Common fields are stamped in the hook process (OtlpAgentAdapter class comment).

### Derived Conventions
Repository identifier format: `owner/repo` with remote, `parent/current` without, `Cowork` for Desktop sandbox, `unknown` for empty.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` — stamping of git_branch/repo_remote, override semantics (L142-156).
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` L144 — repo_remote stamping.
- `src/utils/__tests__/processes-git.test.ts` — `detectGitRemoteRepo`.
- `extractRepository` tests were not searched for specifically.

### Testing Framework and Patterns
Vitest; `vi.mock` of `@/utils/processes.js` with `detectGitRemoteRepo` mocks; dynamic imports after mocks.

### Coverage Gaps
No test for empty-remote behavior on the OTLP path (the OtlpAgentAdapter tests only exercise `'org/repo'`). Windows-path fallback behavior at the adapter level is untested. (Per AGENTS.md, tests are written only on explicit request.)

---

## 5. Configuration and Environment

### Environment Variables
None found specific to repo field resolution. `otel-analytics-override.ts` header comment refers to dedicated OTEL env vars, but the file currently hard-codes values.

### Configuration Files
`.codemie/codemie-cli.config.json` modified locally (uncommitted), unrelated.

### Feature Flags and Deployment Concerns
No flags found. The analytics allowlist (`isTracked`) gates all hook forwarding. Backend is a separately deployed service; CLI-side change is independent of backend deploy.

---

## 6. Risk Indicators

- Speculative: the CLI sends `repo_remote=""` plus raw `cwd`; the backend copies `cwd` into `session_dims.repository` and displays it. A CLI-only fix that puts the fallback into `repo_remote` would fix display for new sessions, but raw `cwd` still reaches the backend/DB (`session_dims.repository`, `raw`, `cwd` field), which arguably violates "OS username/home dir not exposed". Whether to also alter `cwd` or change the backend is a design decision.
- Speculative: putting a non-remote fallback into `repo_remote` mixes semantics (the field name implies a remote); a separate `repository` field would need backend support. Also, `OVERRIDABLE_FIELD_KEYS` lets events carry their own `repo_remote`.
- Historical data already stored with full path is not corrected by a CLI change.
- `extractRepository` uses its own `splitPath`/`normalizePathSeparators` (platform independent); `truncateProjectPath` uses host `path.sep` — pick the former for cross-OS consistency. Unusual cwds (root, drive-only, home dir) fall to single segment/`unknown`; a cwd directly under home yields `<username>/<dir>` (e.g. `Users/lika`/`C:\Users\x` -> `Users/x`), which may expose a username despite parent/current rule.
- Untracked `otel-analytics-override.ts` contains a hard-coded JWT and localhost URL; modified `forwarder.ts`, `package.json`, `.codemie/codemie-cli.config.json`, `install.cmd` are local working state — must not leak into the change/commit; the token should be treated as a secret.
- Fix surface shared: `OtlpAgentAdapter` is agent-agnostic, so the change affects all OTLP adapters.

---

## 7. Summary for Complexity Assessment

The defect sits in the agent adapter layer: `OtlpAgentAdapter.resolveRepoFields` sends `repo_remote = ''` when `detectGitRemoteRepo` returns undefined, and stamps the absolute `cwd` on every event. The backend (`session_dims.repository` from `cwd`, display via `coalesce(repo_remote, repository)`) then shows the raw path. The CLI already has the desired fallback helpers: `resolveRepositoryName` (processes.ts) and `extractRepository` (paths.ts), giving `parent/current`, `owner/repo`, `Cowork`, `unknown`. The change surface appears small (the adapter, perhaps one util, plus tests) with the proxy/spool layer only transporting.

Technical novelty is low (reuse of existing helpers, no new dependencies, no config). The main uncertainty is design: which field carries the fallback, and whether raw `cwd` must stop being sent to meet the "no username/home exposure" criterion, which could require backend coordination in the sibling repo. Test coverage of the adapter exists but not for the no-remote case.

Key risks: semantic overloading of `repo_remote`, remaining `cwd` leakage, home-dir-adjacent paths exposing usernames, shared base class affecting all adapters, and uncommitted local-only files in the working tree (one with an embedded token).

---

## 8. External References

None named by the task as a source of truth beyond the sibling backend repo, which was read: `C:\Projects\codemie-dev\codemie\src\codemie\repository\cli_analytics\postgres\rollups.py` (L1622-1627: `session_dims.repository` <- earliest `cwd`; `repo_remote` <- earliest `repo_remote`) and `postgres\reader.py` (L180, L574: `coalesce(nullif(d.repo_remote,''), nullif(d.repository,''), '') AS repository`). No backend parent/current-dir fallback found in the cli_analytics path.
