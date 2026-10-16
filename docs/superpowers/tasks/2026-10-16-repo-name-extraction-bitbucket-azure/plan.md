# Repo name extraction: Bitbucket scm/~ and legacy Azure DevOps Implementation Plan

**Goal:** Extend `parseGitRemoteUrl` so Bitbucket Server/DC HTTPS and legacy `*.visualstudio.com` remotes yield stable `owner/repo` names.

**Scope:** Only `src/utils/processes.ts` (`parseGitRemoteUrl`, lines 401-434). Project policy (AGENTS.md): no test files, no commit steps. Verification is typecheck/lint plus an uncommitted throwaway snippet.

**Story:** `docs/stories/2026-10-16-repo-name-extraction-bitbucket-azure/story.md`

## Task 1: Extend parseGitRemoteUrl

**Files:** Modify `src/utils/processes.ts:401-434`

Test-first: no — tests only on explicit user request (AGENTS.md)

- [ ] **Step 1: Capture scheme and normalise host**
  - Change the `urlMatch` regex (line 403) to also capture the scheme, e.g. `/^(\w+):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/`, and adjust destructuring (line 410) so `scheme`, `host`, `path` are all available (`scpMatch` and bare-path give `scheme` undefined).
  - Derive `hostname = host?.replace(/:\d+$/, '').toLowerCase()` and use it for every host comparison below, including the existing `dev.azure.com` / `ssh.dev.azure.com` check at line 424 (behaviour for those hosts otherwise unchanged).

- [ ] **Step 2: Legacy Azure DevOps (after segments are decoded, line 422)**
  - `hostname` ends with `.visualstudio.com` and is not `vs-ssh.visualstudio.com`: org = first hostname label with original casing taken from `host` (not the lowercased copy); drop every `_git` segment and a first segment equal (case-insensitive) to `DefaultCollection`; result = `[org, ...rest]`.
  - `hostname === 'vs-ssh.visualstudio.com'`: drop `_git` and a leading `v3`; the path already starts with the org, so do not prepend it.
  - Keep these branches host-scoped so other hosts keep `_git`/`v3` (`https://gitlab.example.com/group/v3/_git.git` -> `group/v3/_git`).

- [ ] **Step 3: Bitbucket `scm` and `~`**
  - For `scheme` of `http` or `https` (case-insensitive) with 3+ segments and `segments[0] === 'scm'`, remove that first segment. SSH/scp, 2-segment paths and non-leading `scm` are untouched (`https://github.com/scm/repo.git` -> `scm/repo`).
  - On any host and scheme, if the (post-scm) first segment starts with `~`, strip that single leading `~` (`~jdoe` -> `jdoe`); a `~` elsewhere (`a~b`) is preserved. Apply this to the first segment of the final result, before the empty-result check at line 429.
  - Keep the bare-path last-two fallback and the `result.length === 0 -> undefined` behaviour intact; malformed `%` still falls back to the raw segment.

- [ ] **Step 4: Verify**
  - Run `npm run typecheck` and `npm run lint` (zero warnings).
  - Optionally run a throwaway, uncommitted `npx tsx` snippet (outside the repo tree or deleted afterwards) feeding the story's examples through the function (export is not required; copy the call via a temporary harness) and confirm:
    - `https://bitbucket.example.com/scm/PROJ/repo.git` -> `PROJ/repo`
    - `https://bitbucket.example.com/scm/~jdoe/repo.git` and `ssh://git@bitbucket.example.com:7999/~jdoe/repo.git` -> `jdoe/repo`
    - `https://org.visualstudio.com/Proj/_git/repo` and `.../DefaultCollection/Proj/_git/repo` -> `org/Proj/repo`
    - `org@vs-ssh.visualstudio.com:v3/org/Proj/repo` -> `org/Proj/repo`
    - `https://dev.azure.com/org/Proj/_git/repo` -> `org/Proj/repo`
    - `git@gitlab.example.com:scm/team/repo.git` -> `scm/team/repo`; `https://bitbucket.example.com/bitbucket/scm/PROJ/repo.git` -> `bitbucket/scm/PROJ/repo`
    - `https://example.com/group/a~b/repo.git` -> `group/a~b/repo`; `https://example.com/` -> `undefined`; `https://dev.azure.com/org/bad%2` -> `org/bad%2`

## Negative-constraint pass

- Do not strip `scm` for SSH, 2-segment paths or non-leading position: Step 3 conditions.
- Do not touch `~` anywhere except the leading char of the first segment: Step 3.
- Do not alter non-Azure hosts' `_git`/`v3` handling or `dev.azure.com` behaviour: Step 2.
- No tests, no commits (AGENTS.md): none planned.
