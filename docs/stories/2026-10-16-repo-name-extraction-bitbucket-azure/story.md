# Repo Name Extraction: Bitbucket Server/DC and Azure DevOps Legacy Remotes — Story

**Date**: 2026-10-16
**Status**: Approved
**Ticket**: EPMCDME-15655 (extension of prior run `docs/superpowers/tasks/2026-10-13-epmcdme-15655-repo-name-extraction`)

---

## Context

- Repo name is derived from the git remote URL by a single shared parsing step; all consumers (analytics, sessions, metrics, etc.) treat the result as an opaque `owner/repo` string.
- The previous run added host-aware handling for `dev.azure.com` / `ssh.dev.azure.com` (drops `_git` and `v3`, yields `org/Project/repo`). Other hosts use generic path extraction.
- Bitbucket Server/DC HTTPS remotes carry a service segment `scm/`, so HTTPS yields `scm/PROJ/repo` while SSH yields `PROJ/repo` — the same repository gets two different names.
- Legacy Azure DevOps remotes (`*.visualstudio.com`, `vs-ssh.visualstudio.com`) are not recognised; the organisation lives in the hostname (HTTPS) or is mixed with the `v3` marker (SSH), so results like `Proj/_git/repo` or `v3/org/Proj/repo` are produced.
- Existing automated checks cover generic hosts and `dev.azure.com` only; there is no coverage for Bitbucket or legacy Azure forms.

---

## Complexity

**Size**: S (11/36) · **Recommended flow**: sdlc-light

Single-function change in one file with an established test harness; the only real risk is edge-case ambiguity in `/scm/` and legacy Azure host handling.

---

## Story

**As a** developer using CodeMie with repositories hosted on Bitbucket Server/Data Center or legacy Azure DevOps, **I want** the same repository to be identified by one stable name regardless of clone protocol or URL generation, **so that** analytics and session data for a repository are grouped together and are not split or mislabelled.

---

## Background

Repository identity is derived from the git remote. For Bitbucket Server/DC, HTTPS clones include a technical `scm/` segment that SSH clones do not, so one repo appears under two names. For Azure DevOps organisations still using `visualstudio.com` URLs or `vs-ssh` SSH remotes, the name includes technical markers (`_git`, `v3`, `DefaultCollection`) and omits the organisation. This fragments reporting for affected teams and is inconsistent with the already-correct `dev.azure.com` result.

---

## Acceptance Criteria

- [ ] Given an HTTPS Bitbucket remote `https://bitbucket.example.com/scm/PROJ/repo.git`, when the repo name is extracted, then it is `proj/repo`.
- [ ] Given an HTTPS Bitbucket personal-repo remote `https://bitbucket.example.com/scm/~jdoe/repo.git`, when the repo name is extracted, then it is `jdoe/repo` (`scm/` and the leading `~` are dropped).
- [ ] Given the SSH Bitbucket remotes `ssh://git@bitbucket.example.com:7999/PROJ/repo.git` and `.../~jdoe/repo.git`, when the repo name is extracted, then results are `proj/repo` and `jdoe/repo` (the leading `~` is dropped; HTTPS and SSH give equal results).
- [ ] Given any remote, when the repo name is extracted, then the whole result is lower-cased (e.g. `https://github.com/Owner/Repo.git` → `owner/repo`, `https://dev.azure.com/Org/Proj/_git/Repo` → `org/proj/repo`).
- [ ] Given a remote where `~` appears anywhere other than at the start of the first path segment (e.g. `https://example.com/group/a~b/repo.git`), when the repo name is extracted, then the `~` is preserved.
- [ ] Given `https://org.visualstudio.com/Proj/_git/repo`, when the repo name is extracted, then it is `org/proj/repo`.
- [ ] Given `https://org.visualstudio.com/DefaultCollection/Proj/_git/repo`, when the repo name is extracted, then it is `org/proj/repo` (`DefaultCollection` is dropped).
- [ ] Given `org@vs-ssh.visualstudio.com:v3/org/Proj/repo`, when the repo name is extracted, then it is `org/proj/repo` (organisation not duplicated, `v3` dropped).
- [ ] Given `https://dev.azure.com/org/Proj/_git/repo`, when the repo name is extracted, then it is `org/proj/repo` (same as before apart from lower-casing).
- [ ] Given a non-Bitbucket remote whose path legitimately contains `scm` (e.g. a two-segment `https://github.com/scm/repo.git`, or any SSH remote with a leading `scm` group), when the repo name is extracted, then the `scm` segment is preserved.
  - `https://github.com/scm/repo.git` → `scm/repo`
  - `git@gitlab.example.com:scm/team/repo.git` → `scm/team/repo`
  - `https://bitbucket.example.com/bitbucket/scm/PROJ/repo.git` (`scm` not the leading segment) → `bitbucket/scm/proj/repo`
- [ ] Given a non-Azure remote whose path contains `_git` or `v3` (e.g. `https://gitlab.example.com/group/v3/_git.git`), when the repo name is extracted, then the result is unchanged (`group/v3/_git`).
  - `https://gitlab.example.com/group/v3/_git.git` → `group/v3/_git`
  - `https://git.example.com/team/_git/repo.git` → `team/_git/repo`
- [ ] Given a remote that cannot be parsed, when the repo name is extracted, then behaviour is unchanged from today (no new errors).
  - `https://example.com/` (empty path) → unchanged from today (`https:/example.com`, falls to the bare-path branch)
  - `https://dev.azure.com/org/bad%2` (malformed %-escape) → `org/bad%2` (raw segment kept)

---

## Out of Scope

- Changing any consumer of the repo name or migrating previously stored names.
- Other Git hosting platforms or URL schemes not listed above.
- Bitbucket Cloud (`bitbucket.org`) — its URLs have no `scm/` segment and already work.
- Hostname-based detection of self-hosted Bitbucket (stripping is path-based, HTTP(S) only, leading `scm/` with three or more path segments).

---

## Open Questions

*Resolved by product owner: `visualstudio.com` / `vs-ssh.visualstudio.com` host matching is case-insensitive; the extracted name is lower-cased on all hosts (supersedes the earlier "preserve organisation casing" decision); the `~` rule applies on any host; the `jdoe`/`JDOE` collision is accepted. No new ticket (EPMCDME-15655 is reused).*

- The leading `~` is dropped from the first path segment on any host (not only Bitbucket), since `~user` is the personal-space convention and is not valid in other hosts' owner names. Confirm, or restrict to remotes that also had `scm/` / port-style Bitbucket shape?
- Consequence: a personal repo `~jdoe/repo` and a project `JDOE/repo` now map to the same name (`jdoe/repo`), and repos differing only by case collapse together — accepted as the requested behaviour.
- Should hostname matching for `visualstudio.com` / `vs-ssh.visualstudio.com` be case-insensitive? (Proposed: yes, consistent with host semantics.)
- Resolved: the returned repo name is lower-cased by default for all hosts (e.g. `Org/Proj/Repo` → `org/proj/repo`).
