# EPMCDME-15655: Multi-Segment Git Remote Repository Name Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `detectGitRemoteRepo` so GitLab subgroup remotes and Azure DevOps HTTPS/SSH remotes resolve to their full, host-correct repository name instead of the last two path segments.

**Architecture:** Replace the single two-segment regex with a pure helper, `parseGitRemoteUrl`, that extracts host + path from either URL-style (`scheme://[user@]host/path`) or SCP-style (`user@host:path`) remotes, URL-decodes each path segment, and — only for `dev.azure.com`/`ssh.dev.azure.com` hosts — drops the non-semantic `_git` segment and a leading `v3` segment before joining. `detectGitRemoteRepo` calls the helper inside its existing try/catch, so the never-throw contract is unchanged.

**Tech Stack:** TypeScript, Vitest, `vi.mock('node:child_process', ...)`.

**Spec:** Requirements supplied inline (EPMCDME-15655) — no `spec.md` for this task. Technical analysis: `docs/superpowers/tasks/2026-10-13-epmcdme-15655-repo-name-extraction/technical-analysis.md`.

## Acceptance criteria

- [ ] GitLab subgroup HTTPS remotes resolve to the full `group/.../repo` path, and two different top-level groups sharing their last two segments resolve to different, non-colliding names.
- [ ] GitLab subgroup SSH remotes, including 4-level-deep paths, resolve to the full path.
- [ ] Azure DevOps HTTPS (`dev.azure.com/.../_git/<repo>`) and SSH (`ssh.dev.azure.com:v3/...`) remotes of the same repository resolve to the identical `<org>/<project>/<repo>` string, with `_git` and `v3` stripped.
- [ ] The Azure DevOps HTTPS case correctly URL-decodes `%20` to a literal space in the project segment.
- [ ] Credentials embedded in the remote URL (`user:token@`, `token@`) never appear in the returned name, on any host.
- [ ] Plain `owner/repo` remotes (GitHub SSH/HTTPS, flat GitLab, no `.git` suffix) resolve exactly as before.
- [ ] Any `git` failure / missing remote still returns `undefined`, never throws.

## Global Constraints

- Single file, single function: all changes confined to `src/utils/processes.ts`; no other file in the 6+ call-site list needs modification.
- No new dependencies; pure string/regex/`decodeURIComponent` logic only.
- Preserve the existing `Promise<string | undefined>` signature of `detectGitRemoteRepo` and its never-throw guarantee.
- Commit per task using the repository's existing convention.

## Review Focus

- Azure DevOps SSH's SCP username (always `git`) must not be mistaken for the org — the org must come from the path (`v3/<org>/...`).
- A `_git` or `v3` segment on a *non*-Azure host (e.g. a GitLab repo literally named `v3`) must NOT be stripped — the strip rule is host-gated.
- Only a true *trailing* `.git` is stripped; a segment containing `.git` mid-name must survive intact.
- An empty or unrecognizable remote URL must resolve to `undefined`, not throw or return an empty string.
- Credential-stripping and multi-segment path handling must compose (GitLab subgroup HTTPS *with* embedded credentials).

---

### Task 1: Add failing tests for subgroup, Azure DevOps, and edge-case remote shapes

**Files:**
- Modify: `src/utils/__tests__/processes-git.test.ts` (append `it()` blocks inside the existing `describe('detectGitRemoteRepo', ...)`, after line 52, following the established `mockExecAsync.mockResolvedValue({ stdout: ..., stderr: '' })` pattern)

**Interfaces:**
- Consumes: `detectGitRemoteRepo(cwd: string): Promise<string | undefined>` (unchanged signature, already imported at line 15)
- Produces: nothing new; this task only adds assertions Task 2 must satisfy

Test-first: yes — every scenario below fails against the current two-segment regex (subgroup cases return only the last two segments; Azure cases keep `_git`/diverge between transports; edge cases are untested today).

- [ ] Step 1: Add these 5 `it()` blocks (covering 9 remote-shape scenarios) to `src/utils/__tests__/processes-git.test.ts`, inside the existing `describe('detectGitRemoteRepo', ...)`:

```ts
it('keeps full path for GitLab subgroups and never collides on shared suffix segments', async () => {
  mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/qa-group-a/shared/svc.git\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('qa-group-a/shared/svc');
  mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/qa-group-b/shared/svc.git\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('qa-group-b/shared/svc');
});

it('keeps full path for GitLab multi-level subgroup SSH remote', async () => {
  mockExecAsync.mockResolvedValue({ stdout: 'git@gitlab.example.com:qa-top/qa-sub/qa-subsub/deep-svc.git\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('qa-top/qa-sub/qa-subsub/deep-svc');
});

it('normalizes Azure DevOps HTTPS and SSH remotes of the same repo to one identical name, decoding %20', async () => {
  mockExecAsync.mockResolvedValueOnce({ stdout: 'https://qaorg@dev.azure.com/qaorg/QA%20Project/_git/qa-ado-repo\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('qaorg/QA Project/qa-ado-repo');
  mockExecAsync.mockResolvedValueOnce({ stdout: 'git@ssh.dev.azure.com:v3/qaorg/QAProject/qa-ado-repo\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('qaorg/QAProject/qa-ado-repo');
});

it('does not strip _git/v3 on non-Azure hosts, strips only a trailing .git, and returns undefined on malformed input', async () => {
  mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/group/v3/_git.git\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('group/v3/_git');
  mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/group/my.git-tools.git\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBe('group/my.git-tools');
  mockExecAsync.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
  expect(await detectGitRemoteRepo('/repo')).toBeUndefined();
});

it('strips credentials and keeps the full subgroup path together', async () => {
  mockExecAsync.mockResolvedValue({ stdout: 'https://user:token@gitlab.example.com/qa-group-a/shared/svc.git\n', stderr: '' });
  const result = await detectGitRemoteRepo('/repo');
  expect(result).toBe('qa-group-a/shared/svc');
  expect(result).not.toContain('token');
});
```

- [ ] Step 2: Run `npx vitest run src/utils/__tests__/processes-git.test.ts` and confirm the 5 new blocks FAIL while the 6 pre-existing cases still PASS.

- [ ] Step 3: Commit per the repository's existing convention.

### Task 2: Implement host-aware multi-segment parsing in `detectGitRemoteRepo`

**Files:**
- Modify: `src/utils/processes.ts:401-411` (add a new private helper above the function; replace the function body)

**Interfaces:**
- Consumes: raw `stdout` string from `git remote get-url origin` (already trimmed at the current line 404)
- Produces: `detectGitRemoteRepo(cwd: string): Promise<string | undefined>` — same exported signature as today; no caller elsewhere in the repo changes

Test-first: no — this task makes Task 1's failing tests pass; no new test is written here.

- [ ] Step 1: Add this private helper directly above `detectGitRemoteRepo` (`src/utils/processes.ts`, before line 401):

```ts
function parseGitRemoteUrl(remoteUrl: string): string | undefined {
  const withoutGitSuffix = remoteUrl.replace(/\.git$/, '');
  const urlMatch = withoutGitSuffix.match(/^\w+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  const scpMatch = withoutGitSuffix.match(/^[^/@]+@([^:]+):(.+)$/);
  const match = urlMatch ?? scpMatch;
  if (!match) return undefined;

  const [, host, path] = match;
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  const isAzureDevOps = host === 'dev.azure.com' || host === 'ssh.dev.azure.com';
  const result = isAzureDevOps
    ? segments.filter((segment, index) => segment !== '_git' && !(index === 0 && segment === 'v3'))
    : segments;

  return result.length > 0 ? result.join('/') : undefined;
}
```

- [ ] Step 2: Replace the body of `detectGitRemoteRepo` (`src/utils/processes.ts:401-411`) to call the helper instead of the old regex:

```ts
export async function detectGitRemoteRepo(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd, timeout: 5000, windowsHide: true });
    return parseGitRemoteUrl(stdout.trim());
  } catch {
    return undefined;
  }
}
```

- [ ] Step 3: Run `npx vitest run src/utils/__tests__/processes-git.test.ts` and confirm all 11 test blocks (6 pre-existing + 5 new) PASS.

- [ ] Step 4: Commit per the repository's existing convention.

---

## Negative-constraint pass

- "must NOT collide" (qa-group-a vs qa-group-b): Task 1's first test asserts both resolve to distinct, full strings; Task 2's helper keeps every path segment for non-Azure hosts, so collision is structurally impossible.
- "non-semantic `_git` and `v3` path markers stripped" only for Azure DevOps: Task 2 Step 1 host-gates the filter to `dev.azure.com`/`ssh.dev.azure.com`; Task 1's "does not strip _git/v3 on non-Azure hosts..." test pins that the filter does not fire elsewhere.
- "credentials ... must never appear in the returned repository name": Task 2 Step 1's `urlMatch` regex's `(?:[^@/]+@)?` group consumes and discards the credential prefix before `host`/`path` are captured; both the pre-existing credential test and Task 1's "strips credentials and keeps the full subgroup path together" test assert this.
- "the function must still return `undefined` (never throw)": Task 2 Step 2 keeps the original try/catch; `parseGitRemoteUrl` returns `undefined` for any unmatched input (Task 1's malformed-input assertion), and any exception it did raise (e.g. a malformed `%` sequence) is still caught by the outer `catch`.
- "Out of scope: forwarder.ts, backend analytics API/UI, and all other consumer files": no task in this plan touches any file other than `src/utils/processes.ts` and its test — all 6+ call sites are left untouched, relying on the shared function.

negative-constraints: all 5 identified above are honored; the inline requirements state these as asides rather than a dedicated "Non-goals" heading, so none were skipped.
