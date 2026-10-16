# Technical Research

**Task**: git remote-url repository-name analytics telemetry
**Generated**: 2026-10-13T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Fix bug EPMCDME-15655.

Environment: Preview (https://codemie-preview.lab.epam.com), API 2.49.0-SNAPSHOT.132
CodeMie CLI: 0.15.7 (main @ cbdf45e)
OS: Windows 11 Enterprise
Claude Code: 2.1.291
Connected with: codemie proxy connect --claude-code-otlp --scope user

Description:
CLI Analytics shows only the last two path segments of the origin remote URL as the repository name. This works for owner/repo hosts such as GitHub, but gives wrong names for two common hosting layouts:
- GitLab subgroups (group/subgroup/repo): the top group is dropped. Repositories from different groups that share the last two segments are merged into one row. For example, qa-group-a/shared/svc and qa-group-b/shared/svc are both shown as shared/svc, and their sessions, turns and cost are added together.
- Azure DevOps over HTTPS (dev.azure.com/<org>/<project>/_git/<repo>, the default clone URL): every repository is shown as _git/<repo>. The same repository cloned over SSH (ssh.dev.azure.com:v3/<org>/<project>/<repo>) gets a different name, <project>/<repo>, so one repository can appear as two rows.
Real GitLab examples: gitlab-org/security-products/analyzers/semgrep would be shown as analyzers/semgrep, and gitlab-org/charts/gitlab as charts/gitlab.

Steps to reproduce:
1. Create two repositories with these remotes (the remote does not need to exist):
   - git remote add origin https://gitlab.example.com/qa-group-a/shared/svc.git
   - git remote add origin https://gitlab.example.com/qa-group-b/shared/svc.git
2. Create a third repository with git remote add origin https://qaorg@dev.azure.com/qaorg/QA%20Project/_git/qa-ado-repo
3. codemie proxy connect --claude-code-otlp --scope user
4. In each repository run claude -p "reply with exactly OK".
5. Wait ~2 minutes for the proxy to forward the sessions.
6. Open Analytics -> CLI Analytics -> Repositories, filter Me, search "svc" then "ado".
API: GET /code-assistant-api/v1/analytics/cli-analytics/repositories, GET /code-assistant-api/v1/analytics/cli-analytics/sessions (field repository).

Actual vs expected examples:
- https://gitlab.example.com/qa-group-a/shared/svc.git -> actual "shared/svc", expected "qa-group-a/shared/svc"
- https://gitlab.example.com/qa-group-b/shared/svc.git -> actual "shared/svc", expected "qa-group-b/shared/svc"
- git@gitlab.example.com:qa-top/qa-sub/qa-subsub/deep-svc.git -> actual "qa-subsub/deep-svc", expected "qa-top/qa-sub/qa-subsub/deep-svc"
- https://qaorg@dev.azure.com/qaorg/QA%20Project/_git/qa-ado-repo -> actual "_git/qa-ado-repo", expected "qaorg/QA Project/qa-ado-repo"
- git@ssh.dev.azure.com:v3/qaorg/QAProject/qa-ado-ssh -> actual "QAProject/qa-ado-ssh", expected "qaorg/QAProject/qa-ado-ssh"

Impact:
- Different repositories with the same last two path segments are merged into one row (sessions/turns/cost summed together, no way to separate in UI).
- All Azure DevOps HTTPS repositories look like _git/<repo>, without org or project.
- One Azure DevOps repository shows as two rows when cloned over HTTPS vs SSH.
- Searching by the top-level GitLab group returns no sessions.

Acceptance criteria:
1. GitLab remotes with subgroups (https and ssh) show the full group/.../repo path.
2. Azure DevOps HTTPS and SSH remotes of the same repository show the same name, <org>/<project>/<repo>, without "_git".
3. Credentials in the remote URL (user:token@) never appear in the repository name.
4. owner/repo remotes (GitHub, flat GitLab groups) are unchanged.

Known starting point from prior investigation this session: the extraction logic lives in
`src/utils/processes.ts`, function `detectGitRemoteRepo` (around line 401), which currently does:
`const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/); if (match) return `${match[1]}/${match[2]}`;`
— i.e. it only ever keeps the last two path segments. It's called from multiple sites:
`agents/core/BaseAgentAdapter.ts`, `cli/commands/hook.ts`, `agents/core/session/ensure-session.ts`,
`agents/plugins/pi/pi.plugin.ts`, `cli/commands/skills/lib/skills-metrics.ts`, and
`telemetry/runtime/DesktopRepositoryResolver.ts` (via `resolveRepositoryName`, which falls back to
`extractRepository` for non-git paths). There's also a `otlp-spool/forwarder.ts` that writes the
resolved name into the `repo_remote` field sent to the OTLP analytics backend — but note the actual
bug (per the ticket's API evidence: /analytics/cli-analytics/repositories, /sessions field
`repository`) may be in the repository-name resolution/display pipeline on the backend side too,
since that's a separate `codemie` (backend) repo — scope your research to THIS repo's responsibility:
how CLI Analytics / OTLP telemetry on the CLI side derives and reports the repository name string.
Note there's a related existing test file `src/utils/__tests__/processes-git.test.ts` covering
`detectGitRemoteRepo` cases (GitHub SSH/HTTPS, GitLab flat groups, credential stripping) that will
need new cases for subgroups and Azure DevOps.

---

## 2. Codebase Findings

### Existing Implementations

- `src/utils/processes.ts:401-411` — `detectGitRemoteRepo(cwd)`. Runs `git remote get-url origin` (5s timeout, `execAsync`), then applies the single regex `/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/` against the trimmed stdout and returns `${match[1]}/${match[2]}`. This regex structurally captures only the last two `[:/]`-delimited segments before an optional `.git` suffix — it has no concept of subgroup depth or an Azure DevOps `_git` marker, matching the ticket's described behavior exactly for all five quoted examples. Returns `undefined` on any `git` failure (no remote, not a repo, timeout) — never throws.
- `src/utils/processes.ts:424-426` — `resolveRepositoryName(workingDirectory)`. Thin wrapper: `(await detectGitRemoteRepo(workingDirectory)) ?? extractRepository(workingDirectory)`. Used by the Desktop telemetry path for non-CLI (Claude Desktop) working directories.
- `src/utils/paths.ts:411+` — `extractRepository(workingDirectory)`, the filesystem fallback (last two path segments, with a special-case regex for Claude Desktop sandbox dirs returning `'Cowork'`). Independent of the git-remote regex; out of scope for this bug (ticket is specifically about remote-URL parsing, not the filesystem fallback).
- `src/utils/__tests__/processes-git.test.ts` — existing unit tests for `detectGitRemoteRepo`: GitHub SSH, self-hosted GitLab SSH (flat group), HTTPS, credential-stripping HTTPS, URL without `.git`, and the `undefined`-on-failure case. No subgroup or Azure DevOps cases exist yet (confirmed by reading the file in full — 6 `it()` blocks, all two-segment `owner/repo` shapes).

### Call sites of `detectGitRemoteRepo` / `resolveRepositoryName` (all within this repo)

| File | Line(s) | Usage |
|---|---|---|
| `src/agents/core/BaseAgentAdapter.ts` | 4 (import), 545 | Calls at session start, result feeds `CODEMIE_REPOSITORY` env var set before spawning the agent subprocess |
| `src/cli/commands/hook.ts` | 788-791 (`sendSessionStartMetrics`), 960-961 | Two independent calls in the hook flow (session record creation and session-start metric send) |
| `src/agents/core/session/ensure-session.ts` | 41-42 | Falls back to `detectGitRemoteRepo` only when `CODEMIE_REPOSITORY` env var is absent/`'unknown'` |
| `src/agents/plugins/pi/pi.plugin.ts` | 144 | Same pattern for the Pi agent plugin |
| `src/cli/commands/skills/lib/skills-metrics.ts` | 176 | Sends `repository` in skills events POST body and `X-CodeMie-Repository` header |
| `src/telemetry/runtime/DesktopRepositoryResolver.ts` | 287 | Calls `resolveRepositoryName`, not `detectGitRemoteRepo` directly — same regex underneath |
| `src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts` | 221-224, 275 | Independently re-detects via dynamic import: `detectGitRemoteRepo(cwd).then((v) => v ?? '')`, writes result into OTLP `repo_remote` attribute (line 275) sent to the analytics backend — this is the OTLP path the ticket's reproduction (`--claude-code-otlp`) exercises |

All call sites consume the function's return value opaquely (string or `undefined`) and apply no further parsing — fixing the regex/parsing logic in `detectGitRemoteRepo` alone fixes every consumer, including the OTLP forwarder that is the specific path named in the ticket's repro steps.

### Architecture and Layers Affected

- **Utils layer** (`src/utils/processes.ts`) — sole location of the parsing logic; this is where the fix belongs per the plugin-based 5-layer architecture (Utils is the lowest, dependency-free layer).
- **Telemetry/OTLP layer** (`src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts`) — consumer that forwards the (currently wrong) value to the backend as `repo_remote`; no parsing logic of its own.
- **Agent Core / CLI hook layers** (`BaseAgentAdapter.ts`, `hook.ts`, `ensure-session.ts`) — consumers via `CODEMIE_REPOSITORY` env var and direct calls; no parsing logic of their own.
- No router/service/API layer in this repo is involved — the ticket's backend API evidence (`/analytics/cli-analytics/repositories`, `/sessions`) lives in the separate `codemie` backend repo, out of scope per the task's own instruction.

### Integration Points

- `git remote get-url origin` — the only external dependency; shelled out via `child_process.exec` promisified as `execAsync`.
- OTLP export — `forwarder.ts` is the transport that carries the resolved repository string to the backend's `repo_remote` field, matching the ticket's `--claude-code-otlp` repro path.
- `CODEMIE_REPOSITORY` env var — propagation channel from `BaseAgentAdapter` to subprocess-side consumers (`ensure-session.ts`); any regex fix changes the value carried through this channel too.

### Patterns and Conventions

- **Never throws**: all git-shell-out failures are swallowed and return `undefined`; callers use `??` fallback chains. Any new parsing logic must preserve this contract.
- **Pure regex/string parsing, no URL library**: the existing code does not use Node's `url.parse`/`URL` class even for the HTTPS case; it treats SSH (`host:path`) and HTTPS (`protocol://host/path`) uniformly via a single colon-or-slash-anchored regex. (Observation only — not a constraint on the fix.)
- **Credential stripping is implicit**: the current regex captures only trailing segments, so `user:token@host` never reaches the captured groups; this must be preserved for the Azure DevOps HTTPS case (`https://qaorg@dev.azure.com/...`) which also carries a prefix credential.
- **Mock pattern for tests**: `vi.mock('node:child_process', ...)` with the `promisify.custom` symbol attached, as seen in `processes-git.test.ts` — the established pattern for testing this function without shelling out.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — defines the Utils layer as the correct home for host-agnostic string/URL parsing; confirms `detectGitRemoteRepo` is already correctly placed.
- No guide specifically documents git-remote-URL parsing rules; conventions are derived from code (see below).

### Architectural Decisions

A directly relevant prior task exists in this repo: `docs/superpowers/tasks/2026-07-10-epmcdme-10897-normalize-git-origin-url-metrics/technical-analysis.md`, which introduced/verified the current `detectGitRemoteRepo` regex and its propagation. Its own Risk Indicators section explicitly flagged, three months before this ticket: *"GitLab multi-level subgroup paths silently truncated — For `git@gitlab.com:group/subgroup/repo.git`, the regex returns `subgroup/repo`, dropping the top-level group... this is an undocumented limitation."* That prior task also recorded the decision that `CODEMIE_REPOSITORY` is the single canonical propagation channel (set once by `BaseAgentAdapter`, read by `ensure-session.ts`) to avoid divergence between proxy- and hook-reported repository values — any fix must keep this single-source-of-truth property intact.

### Derived Conventions

- Git-detection functions return `string | undefined`, never throw, and are composed with `??` fallback chains at call sites.
- Normalized repository identifiers never include protocol, host, or credentials — only path-derived segments.

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/processes-git.test.ts` — 6 cases for `detectGitRemoteRepo`: GitHub SSH/HTTPS, self-hosted GitLab SSH (flat `owner/repo`), credential-stripped HTTPS, no-`.git`-suffix HTTPS, and the `undefined`-on-failure path. All assume exactly two path segments; none exercise subgroups or Azure DevOps shapes.
- `src/cli/commands/skills/lib/__tests__/skills-metrics.test.ts` — mocks `detectGitRemoteRepo` at the module boundary; asserts the resolved string reaches the request body/header, but does not test the parsing logic itself.
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — mocks `detectGitRemoteRepo` to return `null`/fixed values; does not exercise real regex behavior.

### Testing Framework and Patterns

- Vitest, `unit` project for `src/**/*.test.ts`. Module mocking via `vi.mock('node:child_process', ...)` attaching `promisify.custom` so `execAsync` resolves to the mock — the exact pattern already used in `processes-git.test.ts` and the one any new case should extend.

### Coverage Gaps

- No test for GitLab/self-hosted-GitLab subgroup URLs (3+ path segments), HTTPS or SSH.
- No test for Azure DevOps HTTPS (`dev.azure.com/<org>/<project>/_git/<repo>`, with or without a prefixed username/credential) or SSH (`ssh.dev.azure.com:v3/<org>/<project>/<repo>`) forms.
- No test asserting that the two Azure DevOps transport forms of the *same* repository normalize to the *identical* string (the ticket's AC #2).
- No test for a 4+-level deep GitLab path (ticket's `qa-top/qa-sub/qa-subsub/deep-svc` example).
- The OTLP forwarder path (`forwarder.ts`) that the ticket's repro specifically names (`--claude-code-otlp`) has no test asserting `repo_remote` content; existing tests, if any, were not located for this file in this pass — only grep hits for the call site were found.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_REPOSITORY` — set by `BaseAgentAdapter`, carries the `detectGitRemoteRepo` result (or filesystem fallback) to subprocess consumers (`ensure-session.ts`). Any change to the parsing output changes this value too.
- No other env vars are specific to repository-name resolution.

### Configuration Files

- None specific to this feature area; no `.env.example` entries or config toggles reference git-remote parsing.

### Feature Flags and Deployment Concerns

- No feature flag gates this logic. `detectGitRemoteRepo` hard-codes the remote name `origin`; unrelated to this ticket's scope.

---

## 6. Risk Indicators

- The current regex (`/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/`) is structurally two-segment-only; a correct fix needs either host-aware parsing (detect `dev.azure.com`/`ssh.dev.azure.com` specifically to strip `_git` and reorder segments) or a generic "keep everything after the host, strip `_git` as a non-semantic path marker" rule — this is a design decision for `spec`/`plan`, not something the current code hints at. Speculative: no helper or constant for recognizing "known host families" (GitHub/GitLab-style vs Azure-DevOps-style) exists yet in `src/utils/processes.ts`.
- Six call sites consume the function opaquely, so a single fix fans out correctly everywhere, but also means a regression in the regex now has six-plus production paths to break (`BaseAgentAdapter`, `hook.ts` x2, `ensure-session.ts`, `pi.plugin.ts`, `skills-metrics.ts`, `forwarder.ts`), none of which have fine-grained tests for parsing edge cases today — only `processes-git.test.ts` tests the regex directly.
- Azure DevOps SSH form (`git@ssh.dev.azure.com:v3/qaorg/QAProject/qa-ado-ssh`) uses a `v3/` literal segment before org/project/repo that must be recognized and stripped, similar to `_git`, or it leaks into the output.
- Credential-in-URL handling (ticket AC #3) must be preserved under whatever new parsing scheme is chosen — the current regex passes this incidentally by only keeping trailing segments; a scheme that parses more segments from the front of a URL risks reintroducing credential leakage if not careful (e.g., `https://qaorg@dev.azure.com/...` — the `qaorg@` must not leak into the final `org` segment, confirmed by the ticket's own expected output `qaorg/QA Project/qa-ado-repo`, which strips the `@` but keeps `qaorg` as the org name — i.e., the username in the credential happens to equal the org name in Azure DevOps URLs, which the parser must handle via host/URL structure, not credential-stripping regex positioning).
- No test coverage exists today for the `forwarder.ts` OTLP path specifically, which is the exact code path named in the ticket's reproduction steps (`--claude-code-otlp`); confirming the fix end-to-end there may need either a new/extended test or targeted manual verification.
- URL encoding: the Azure DevOps HTTPS example contains `%20` (`QA%20Project`) which the fix must decode to a literal space (ticket expects `qaorg/QA Project/qa-ado-repo`) — current regex does no URL-decoding at all.

---

## 7. Summary for Complexity Assessment

The entire fix is confined to a single function in a single file: `detectGitRemoteRepo` in `src/utils/processes.ts` (lines ~401-411), which currently applies one generic two-segment regex to every remote URL regardless of host. All production consumers (`BaseAgentAdapter.ts`, `hook.ts` x2, `ensure-session.ts`, `pi.plugin.ts`, `skills-metrics.ts`, `DesktopRepositoryResolver.ts` via `resolveRepositoryName`, and `otlp-spool/forwarder.ts` — the specific OTLP path this ticket's repro exercises) consume the function's return value opaquely, so fixing the parsing logic in one place propagates correctly everywhere without further code changes. This was independently flagged as a known limitation in a prior task's analysis three months ago (`docs/superpowers/tasks/2026-07-10-epmcdme-10897-.../technical-analysis.md`), confirming the root cause location and that it was a deliberately deferred gap rather than a recent regression.

The technical novelty is in choosing a parsing strategy, not in locating the bug: GitHub/flat-GitLab remain two-segment `owner/repo`; GitLab subgroups need an arbitrary-depth "everything after the host" rule; Azure DevOps needs host-specific recognition of `dev.azure.com`/`ssh.dev.azure.com` plus stripping of the non-semantic `_git` and `v3` path markers so that HTTPS and SSH forms of the same repo converge on `<org>/<project>/<repo>`; the HTTPS example also needs URL-decoding of `%20`. None of this requires new dependencies — it is pure string/regex logic in the Utils layer — but it does require more than a one-line change to the existing single regex, likely a small host-dispatch or multi-pattern approach, while preserving the existing never-throw and credential-stripping guarantees that six downstream call sites rely on.

Test coverage posture: the existing `src/utils/__tests__/processes-git.test.ts` has 6 cases, all two-segment shapes, using an established `vi.mock('node:child_process', ...)` pattern with the `promisify.custom` symbol — new cases for subgroups, Azure DevOps HTTPS/SSH equivalence, and URL-encoded segments slot into this file directly with no new test infrastructure needed. The main coverage gap is the OTLP forwarder path named in the ticket's own repro, which has no dedicated test today. Overall this is a low-to-medium complexity, single-file production change with a well-understood blast radius and an existing test harness ready to extend.

---

## 8. External References

None named by the task. The task names only in-repo file paths (`src/utils/processes.ts`, `src/utils/__tests__/processes-git.test.ts`, and the listed call-site files) as the "known starting point," all of which were read directly and are reported in Section 2 above, not as an external source of truth outside this repository.
