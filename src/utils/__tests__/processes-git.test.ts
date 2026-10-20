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
});
