import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecAsync } = vi.hoisted(() => ({
  mockExecAsync: vi.fn()
}));

// Attach the promisify.custom symbol so that `execAsync = promisify(childProcessExec)`
// in processes.ts resolves to mockExecAsync rather than a naive callback wrapper.
vi.mock('node:child_process', () => {
  const exec = vi.fn();
  exec[Symbol.for('nodejs.util.promisify.custom')] = mockExecAsync;
  return { exec, spawn: vi.fn() };
});

import { detectGitRemoteRepo } from '../processes.js';

describe('detectGitRemoteRepo', () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
  });

  it('normalizes SSH URL (GitHub)', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'git@github.com:codemie-ai/codemie-code.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('codemie-ai/codemie-code');
  });

  it('normalizes SSH URL (self-hosted GitLab)', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'git@gitbud.epam.com:epm-cdme/codemie.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('epm-cdme/codemie');
  });

  it('normalizes HTTPS URL', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://github.com/codemie-ai/codemie-code.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('codemie-ai/codemie-code');
  });

  it('strips embedded credentials from HTTPS URL', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://ghp_secrettoken@github.com/org/repo.git\n', stderr: '' });
    const result = await detectGitRemoteRepo('/repo');
    expect(result).toBe('org/repo');
    expect(result).not.toContain('ghp_secrettoken');
  });

  it('normalizes URL without .git suffix', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://github.com/org/repo\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('org/repo');
  });

  it.each([
    ['SSH with .git', 'git@github.com:test-owner/my.repo.git', 'test-owner/my.repo'],
    ['SSH without .git', 'git@github.com:test-owner/my.repo', 'test-owner/my.repo'],
    ['HTTPS with .git', 'https://github.com/test-owner/my.repo.git', 'test-owner/my.repo'],
    ['HTTPS without .git', 'https://github.com/vercel/next.js', 'vercel/next.js'],
    ['GitHub Pages repo', 'git@github.com:user/user.github.io.git', 'user/user.github.io'],
    ['multiple dots', 'https://github.com/org/a.b.c.git', 'org/a.b.c'],
  ])('keeps dots in repository name (%s)', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it('returns undefined when git command fails (no remote)', async () => {
    mockExecAsync.mockRejectedValue(new Error('fatal: No such remote origin'));
    expect(await detectGitRemoteRepo('/repo')).toBeUndefined();
  });

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

  it('decodes %20 in an Azure DevOps HTTPS remote', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://qaorg@dev.azure.com/qaorg/QA%20Project/_git/qa-ado-repo\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('qaorg/qa project/qa-ado-repo');
  });

  it('converges the HTTPS and SSH remotes of the same Azure DevOps repo on one identical lower-cased name', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: 'https://qaorg@dev.azure.com/qaorg/QAProject/_git/qa-ado-repo\n', stderr: '' });
    const https = await detectGitRemoteRepo('/repo');
    mockExecAsync.mockResolvedValueOnce({ stdout: 'git@ssh.dev.azure.com:v3/qaorg/QAProject/qa-ado-repo\n', stderr: '' });
    const ssh = await detectGitRemoteRepo('/repo');
    expect(https).toBe('qaorg/qaproject/qa-ado-repo');
    expect(ssh).toBe(https);
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

  it.each([
    ['credentials with no repository path', 'https://user:TOKEN@host'],
    ['token-only userinfo with no repository path', 'https://ghp_SECRET@github.com'],
    ['host:port with no repository path', 'https://host:8443'],
    ['scheme host with no repository path', 'https://x.visualstudio.com'],
    ['bare user@host with no scheme, no colon, no path', 'ghp_SECRETTOKEN@github.com'],
    ['bare user:token@host with no scheme and no path', 'user:TOKEN@github.com'],
  ])('returns undefined instead of leaking credentials: %s', async (_label, url) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    const result = await detectGitRemoteRepo('/repo');
    expect(result).toBeUndefined();
  });

  it('strips a query string and fragment from the remote URL', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://gitlab.com/a/b.git?private_token=TOKEN\n', stderr: '' });
    const result = await detectGitRemoteRepo('/repo');
    expect(result).toBe('a/b');
    expect(result).not.toContain('token');
  });

  it('keeps the raw escaped segment when decoding would yield a control character', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://host/a/b%0D%0AX-Evil:%201\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('a/b%0d%0ax-evil:%201');
  });

  it('keeps the raw escaped segment when decoding would yield a Unicode line separator', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://host/a/b%E2%80%A8evil\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('a/b%e2%80%a8evil');
  });

  it('does not let an encoded slash (%2F) collapse into a real path separator', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/group/a%2Fb/repo.git\n', stderr: '' });
    const encoded = await detectGitRemoteRepo('/repo');
    mockExecAsync.mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/group/a/b/repo.git\n', stderr: '' });
    const literal = await detectGitRemoteRepo('/repo');
    expect(encoded).not.toBe(literal);
    expect(encoded).toBe('group/a%2fb/repo');
    expect(literal).toBe('group/a/b/repo');
  });

  it('keeps the raw escaped segment when decoding would yield a non-Latin-1 character', async () => {
    // Node's http.request only accepts Latin-1 header values; a decoded Cyrillic project name
    // would break every proxied request carrying this value as X-CodeMie-Repository.
    mockExecAsync.mockResolvedValue({
      stdout: 'https://dev.azure.com/org/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82/_git/repo\n',
      stderr: ''
    });
    const result = await detectGitRemoteRepo('/repo');
    expect(result).toBe('org/%d0%9f%d1%80%d0%be%d0%b5%d0%ba%d1%82/repo');
    expect(Array.from(result ?? '').every((char) => (char.codePointAt(0) ?? 0) <= 0xff)).toBe(true);
  });

  it.each([
    ['SSH config Host alias, scp-style', 'github-work:org/repo.git', 'org/repo'],
    ['SSH config Host alias matching a real hostname', 'github.com:org/repo', 'org/repo'],
  ])('resolves an SSH config Host-alias remote without a user: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it.each([
    ['Windows absolute path', 'C:\\Users\\jdoe\\src\\repo.git', 'src/repo'],
    ['UNC path', '\\\\server\\share\\jdoe\\repo.git', 'jdoe/repo'],
  ])('reduces a Windows/UNC filesystem remote to its last two segments: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it('strips an uppercase .GIT suffix', async () => {
    mockExecAsync.mockResolvedValue({ stdout: 'https://github.com/org/repo.GIT\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('org/repo');
  });

  it.each([
    ['file URL with host', 'file://host/home/jdoe/repo.git', 'home/jdoe/repo'],
    ['file URL triple-slash absolute path', 'file:///home/jdoe/repo.git', 'jdoe/repo'],
  ])('resolves %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it('falls back to the last two path segments for a bare filesystem remote', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: '/home/user/repo.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('user/repo');
    mockExecAsync.mockResolvedValueOnce({ stdout: '/opt/repos/myrepo.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('repos/myrepo');
  });

  it('degrades a malformed %-escape to the raw segment instead of discarding the parse', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: 'https://github.com/org/bad%2.git\n', stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe('org/bad%2');
  });
});

describe('detectGitRemoteRepo - Bitbucket Server/DC and legacy Azure DevOps remotes', () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
  });

  it.each([
    ['HTTPS scm project', 'https://bitbucket.example.com/scm/PROJ/repo.git', 'proj/repo'],
    ['HTTPS scm personal repo drops scm and ~', 'https://bitbucket.example.com/scm/~jdoe/repo.git', 'jdoe/repo'],
    ['HTTPS scm with user@ and :8443 port', 'https://user@bitbucket.example.com:8443/scm/PROJ/repo.git', 'proj/repo'],
    ['SSH project', 'ssh://git@bitbucket.example.com:7999/PROJ/repo.git', 'proj/repo'],
    ['SSH personal repo drops ~', 'ssh://git@bitbucket.example.com:7999/~jdoe/repo.git', 'jdoe/repo'],
    ['scp-style project', 'git@bitbucket.example.com:PROJ/repo.git', 'proj/repo'],
    ['scp-style personal repo drops ~', 'git@bitbucket.example.com:~jdoe/repo.git', 'jdoe/repo'],
  ])('Bitbucket: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it.each([
    ['visualstudio.com HTTPS', 'https://org.visualstudio.com/Proj/_git/repo', 'org/proj/repo'],
    ['visualstudio.com HTTPS with user@', 'https://org@org.visualstudio.com/Proj/_git/repo', 'org/proj/repo'],
    ['visualstudio.com HTTPS DefaultCollection dropped', 'https://org.visualstudio.com/DefaultCollection/Proj/_git/repo', 'org/proj/repo'],
    ['vs-ssh.visualstudio.com SSH', 'org@vs-ssh.visualstudio.com:v3/org/Proj/repo', 'org/proj/repo'],
    ['dev.azure.com unchanged', 'https://dev.azure.com/org/Proj/_git/repo', 'org/proj/repo'],
    ['uppercase host is lower-cased', 'https://ORG.VISUALSTUDIO.COM/Proj/_git/repo', 'org/proj/repo'],
    ['malformed %-escape keeps raw segment', 'https://dev.azure.com/org/bad%2', 'org/bad%2'],
  ])('Azure DevOps: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it.each([
    ['two-segment scm on github', 'https://github.com/scm/repo.git', 'scm/repo'],
    ['SSH leading scm group', 'git@gitlab.example.com:scm/team/repo.git', 'scm/team/repo'],
    // Bitbucket Server/DC installed under a context path: the http(s) "scm" marker is stripped
    // wherever it sits, so this converges with the root-mounted and SSH forms on "proj/repo".
    ['scm not the leading segment (context-path install)', 'https://bitbucket.example.com/bitbucket/scm/PROJ/repo.git', 'proj/repo'],
    ['~ not at start of first segment is preserved', 'https://example.com/group/a~b/repo.git', 'group/a~b/repo'],
    ['_git/v3 kept on non-Azure host (v3 path)', 'https://gitlab.example.com/group/v3/_git.git', 'group/v3/_git'],
    // Deliberate placeholder: this is also the shape of self-hosted Azure DevOps Server / TFS
    // (deferred). Supporting that later reverses this expectation; keep it a conscious choice.
    ['_git kept on non-Azure host', 'https://git.example.com/team/_git/repo.git', 'team/_git/repo'],
    ['lone ~ segment is kept', 'https://bitbucket.example.com/~/repo.git', '~/repo'],
  ])('guards: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });

  it.each([
    ['visualstudio.com _git only', 'https://org.visualstudio.com/_git'],
    ['visualstudio.com DefaultCollection only', 'https://org.visualstudio.com/DefaultCollection'],
    ['visualstudio.com DefaultCollection/_git only', 'https://org.visualstudio.com/DefaultCollection/_git'],
    ['lone ~ as only segment is not a useful repository name', 'https://example.com/~'],
  ])('returns undefined without a repo path: %s', async (_label, url) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBeUndefined();
  });
});

describe('detectGitRemoteRepo - lower-casing', () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
  });

  it.each([
    ['generic host', 'https://github.com/MyOrg/MyRepo.git', 'myorg/myrepo'],
    ['bare filesystem fallback', '/Home/User/Repo.git', 'user/repo'],
  ])('lower-cases the result: %s', async (_label, url, expected) => {
    mockExecAsync.mockResolvedValue({ stdout: `${url}\n`, stderr: '' });
    expect(await detectGitRemoteRepo('/repo')).toBe(expected);
  });
});
