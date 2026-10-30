import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectGitBranch } from '../processes.js';

// Real git, no mocks: the bug (EPMCDME-16530) is in how git itself answers for an unborn HEAD.
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();
}

async function tempDir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'codemie-git-branch-'));
  dirs.push(cwd);
  return cwd;
}

async function repo(init: (cwd: string) => void = () => {}): Promise<string> {
  const cwd = await tempDir();
  git(cwd, 'init', '-q', '-b', 'main');
  init(cwd);
  return cwd;
}

describe('detectGitBranch (real git)', () => {
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('returns the branch of a repository without commits (unborn HEAD)', async () => {
    const cwd = await repo();
    expect(await detectGitBranch(cwd)).toBe('main');
  });

  it('returns a non-default unborn branch', async () => {
    const cwd = await repo((c) => git(c, 'checkout', '-q', '-b', 'feature/x'));
    expect(await detectGitBranch(cwd)).toBe('feature/x');
  });

  it('returns the branch of a repository with a commit', async () => {
    const cwd = await repo((c) => git(c, 'commit', '-q', '--allow-empty', '-m', 'init'));
    expect(await detectGitBranch(cwd)).toBe('main');
  });

  it('returns the branch from a subdirectory', async () => {
    const cwd = await repo((c) => git(c, 'commit', '-q', '--allow-empty', '-m', 'init'));
    await mkdir(join(cwd, 'a', 'b'), { recursive: true });
    expect(await detectGitBranch(join(cwd, 'a', 'b'))).toBe('main');
  });

  it('returns undefined for a detached HEAD', async () => {
    const cwd = await repo((c) => {
      git(c, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(c, 'checkout', '-q', '--detach');
    });
    expect(await detectGitBranch(cwd)).toBeUndefined();
  });

  it('returns undefined outside a git repository', async () => {
    const cwd = await tempDir();
    expect(await detectGitBranch(cwd)).toBeUndefined();
  });
});
