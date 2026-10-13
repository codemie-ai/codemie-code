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
});
