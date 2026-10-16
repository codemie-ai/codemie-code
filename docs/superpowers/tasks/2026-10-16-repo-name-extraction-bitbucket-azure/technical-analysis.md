# Technical Research

**Task**: repo name extraction git remote url bitbucket scm azure devops visualstudio.com vs-ssh dev.azure.com
**Generated**: 2026-10-16
**Research path**: filesystem

---

## 1. Original Context

Extend existing repo-name extraction logic (EPMCDME-15655, prior run docs/superpowers/tasks/2026-10-13-epmcdme-15655-repo-name-extraction). Bitbucket Server/DC HTTPS clone URLs contain a service segment /scm/: https://bitbucket.example.com/scm/PROJ/repo.git currently yields scm/PROJ/repo, expected PROJ/repo; https://bitbucket.example.com/scm/~jdoe/repo.git currently scm/~jdoe/repo, expected ~jdoe/repo (SSH ssh://git@bitbucket.example.com:7999/PROJ/repo.git already gives PROJ/repo). Azure DevOps legacy/SSH: https://org.visualstudio.com/Proj/_git/repo currently Proj/_git/repo, expected org/Proj/repo; https://org.visualstudio.com/DefaultCollection/Proj/_git/repo currently DefaultCollection/Proj/_git/repo, expected org/Proj/repo; org@vs-ssh.visualstudio.com:v3/org/Proj/repo currently v3/org/Proj/repo, expected org/Proj/repo; https://dev.azure.com/org/Proj/_git/repo already org/Proj/repo.

---

## 2. Codebase Findings

### Existing Implementations
- `src/utils/processes.ts:401-434` `parseGitRemoteUrl(remoteUrl)` (private, added by the prior run). Steps: strip trailing `.git`; `urlMatch = /^\w+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/` (scheme URL, optional userinfo without `:`-password handling, host group includes any `:port`); `scpMatch = /^[^/@]+@([^:]+):(.+)$/` (user@host:path); else bare filesystem path (last two segments). Path is split on `/`, empty dropped, each segment `decodeURIComponent` (malformed escape falls back to raw).
- Azure handling (lines 424-427): `isAzureDevOps = host === 'dev.azure.com' || host === 'ssh.dev.azure.com'`; if so, filter out every `_git` segment and a leading `v3`. Non-Azure hosts keep all segments. Result `join('/')` (or last-two for bare path).
- `src/utils/processes.ts:436-443` `detectGitRemoteRepo(cwd)` runs `git remote get-url origin` (5s timeout), returns `parseGitRemoteUrl(stdout.trim())`, `undefined` on any failure (never throws).
- `resolveRepositoryName` (line 456) wraps it with `extractRepository` fallback (`src/utils/paths.ts`).
- Observed current behavior vs the ticket: `https://bitbucket.example.com/scm/PROJ/repo` -> host `bitbucket.example.com`, segments `scm/PROJ/repo` (no `scm` handling). `https://org.visualstudio.com/Proj/_git/repo` -> host not in Azure list -> `Proj/_git/repo`. `org@vs-ssh.visualstudio.com:v3/org/Proj/repo` -> scpMatch host `vs-ssh.visualstudio.com`, not Azure -> `v3/org/Proj/repo`. SSH Bitbucket with `:7999` port yields host `bitbucket.example.com:7999`, path `PROJ/repo` (already correct). The scp regex does not match `ssh://` forms with port because urlMatch wins first.
- Host for urlMatch includes port, so a host comparison like `dev.azure.com:443` would not match the exact-equality check (existing latent edge; not in task).

### Architecture and Layers Affected
Utils layer only (`src/utils/processes.ts`). Consumers (unchanged, opaque string use): `agents/core/BaseAgentAdapter.ts` (~545, sets `CODEMIE_REPOSITORY`), `cli/commands/hook.ts`, `agents/core/session/ensure-session.ts`, `agents/plugins/pi/pi.plugin.ts`, `cli/commands/skills/lib/skills-metrics.ts`, `telemetry/runtime/DesktopRepositoryResolver.ts`, `providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts` (`repo_remote`).

### Integration Points
`git remote get-url origin` via promisified `exec`; no new deps.

### Patterns and Conventions
Pure string/regex parsing, host-dispatch via a local `isAzureDevOps` boolean, never throws, credentials never captured (userinfo is outside capture groups), return `string | undefined`. ES modules, explicit return types, no `any`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/architecture/architecture.md` (Utils layer), `.ai-run/guides/testing/testing-patterns.md` (Vitest). No guide documents remote-URL parsing. Prior analysis: `docs/superpowers/tasks/2026-10-13-epmcdme-15655-repo-name-extraction/technical-analysis.md` and `plan.md` in the same directory.

### Architectural Decisions
Prior run decided: keep full path after host for generic hosts; Azure-specific stripping of `_git`/`v3` keyed on exact host; `CODEMIE_REPOSITORY` is the single propagation channel.

### Derived Conventions
Normalized name has no protocol, host, credentials or port; URL-decoded segments.

---

## 4. Testing Landscape

### Existing Coverage
`src/utils/__tests__/processes-git.test.ts` (112 lines): GitHub/GitLab SSH+HTTPS, credentials, dots in names, GitLab subgroups, Azure `dev.azure.com` HTTPS (with `%20`) and `ssh.dev.azure.com` SSH, non-Azure `_git`/`v3` preserved (`https://gitlab.example.com/group/v3/_git.git` -> `group/v3/_git`), empty -> undefined, bare path last-two, malformed `%`.

### Testing Framework and Patterns
Vitest; `vi.mock('node:child_process')` with `promisify.custom` symbol bound to hoisted `mockExecAsync`; `it.each` table style available (used for dots cases); `mockResolvedValueOnce` for multi-URL tests.

### Coverage Gaps
No Bitbucket (`/scm/`, `~user`, SSH with port 7999) tests; no `*.visualstudio.com` / `vs-ssh.visualstudio.com` tests; no test that a non-Bitbucket host with a literal `scm` first segment is handled (design-dependent).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_REPOSITORY` carries the result to subprocess consumers.

### Configuration Files
None relevant.

### Feature Flags and Deployment Concerns
None. `origin` remote name hard-coded.

---

## 6. Risk Indicators

- Speculative: `/scm/` stripping cannot be keyed on a known host (Bitbucket Server is self-hosted, arbitrary hostnames), so it must be path-based (leading `scm` segment of an http(s) URL); this risks mis-stripping a GitLab/GitHub group literally named `scm` (e.g. `https://gitlab.example.com/scm/repo`). Spec must decide scope (e.g. only when 3+ segments, or only http/https scheme).
- Speculative: `*.visualstudio.com` org is in the hostname (`org.visualstudio.com`), not the path, so the org must be derived from the host label and prepended; `DefaultCollection` must be dropped (legacy collection segment); `_git` removed. Case-insensitivity of `DefaultCollection` and host is unspecified.
- Speculative: `vs-ssh.visualstudio.com:v3/org/Proj/repo` already contains org in the path; org must not be duplicated (result `org/Proj/repo`), while HTTPS visualstudio.com needs org added; two code paths with different org source.
- Host from urlMatch includes `:port`; any new host comparison on `ssh://...:7999` or HTTPS ports must strip port first.
- Existing test `group/v3/_git` asserts non-Azure hosts are untouched; new `_git` stripping for visualstudio.com must remain host-scoped.
- Regression fan-out: 7 consumers use the value; only `processes-git.test.ts` tests parsing directly. Existing tests (e.g. `dev.azure.com` cases) must remain green.
- Bitbucket user repos `~jdoe` contain `~`; `decodeURIComponent` leaves it unchanged, no issue observed.

---

## 7. Summary for Complexity Assessment

The change is confined to one private function, `parseGitRemoteUrl` in `src/utils/processes.ts` (about 35 lines), plus new cases in `src/utils/__tests__/processes-git.test.ts`. No other layer, config, dependency or consumer needs to change since all callers consume the string opaquely. The prior EPMCDME-15655 run already established the host-dispatch pattern (Azure `dev.azure.com`/`ssh.dev.azure.com` filter of `_git` and leading `v3`), so this is an incremental extension of an existing pattern.

Novelty is modest but includes two design decisions: path-based (not host-based) `/scm/` stripping for Bitbucket Server/DC, and deriving the org from the hostname for `org.visualstudio.com` (while dropping `DefaultCollection` and `_git`) and recognizing `vs-ssh.visualstudio.com`. The test harness is established and directly extensible; existing tests lock behavior for other hosts, giving a good regression net. Overall low complexity, single file, with edge-case ambiguity (a group literally named `scm`, case sensitivity, ports) as the main risk.

---

## 8. External References

None named by the task. The prior run directory was referenced and consulted (`technical-analysis.md` there); current source was read directly.
