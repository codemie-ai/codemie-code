import { readFile } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { SyncIdentityMissingError } from '@/utils/errors.js';

import { realIdentityDeps, resolveSyncIdentity } from '../identity.js';
import { includeExternalFor } from '../policy.js';

describe('resolveSyncIdentity', () => {
  it('uses the config email when it is present', async () => {
    const email = await resolveSyncIdentity({
      loadUserEmail: async () => 'config@example.invalid',
      gitEmail: async () => 'git@example.invalid',
    });

    expect(email).toBe('config@example.invalid');
  });

  it('falls back to git when the config email is empty', async () => {
    const email = await resolveSyncIdentity({
      loadUserEmail: async () => undefined,
      gitEmail: async () => 'git@example.invalid',
    });

    expect(email).toBe('git@example.invalid');
  });

  it('falls back to git when the config email is whitespace-only', async () => {
    const email = await resolveSyncIdentity({
      loadUserEmail: async () => '   ',
      gitEmail: async () => 'git@example.invalid',
    });

    expect(email).toBe('git@example.invalid');
  });

  it('throws SyncIdentityMissingError when both sources are empty', async () => {
    await expect(
      resolveSyncIdentity({
        loadUserEmail: async () => undefined,
        gitEmail: async () => undefined,
      })
    ).rejects.toThrow(SyncIdentityMissingError);
  });

  it('throws SyncIdentityMissingError when both sources are whitespace-only', async () => {
    await expect(
      resolveSyncIdentity({
        loadUserEmail: async () => '  ',
        gitEmail: async () => '',
      })
    ).rejects.toThrow(SyncIdentityMissingError);
  });

  it('never imports inquirer', async () => {
    const source = await readFile(new URL('../identity.ts', import.meta.url), 'utf-8');
    expect(source).not.toContain('inquirer');
  });
});

describe('realIdentityDeps.gitEmail', () => {
  it('reads the global git email, so install (any cwd) and the scheduled job agree', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: 'dev@example.invalid', stderr: '' }));
    vi.doMock('@/utils/exec.js', () => ({ exec }));
    try {
      await expect(realIdentityDeps.gitEmail()).resolves.toBe('dev@example.invalid');
      expect(exec).toHaveBeenCalledWith('git', ['config', '--global', 'user.email']);
    } finally {
      vi.doUnmock('@/utils/exec.js');
    }
  });
});

describe('includeExternalFor', () => {
  it('returns true for windows policy on win32', () => {
    expect(includeExternalFor('windows', 'win32')).toBe(true);
  });

  it('returns false for windows policy on linux', () => {
    expect(includeExternalFor('windows', 'linux')).toBe(false);
  });

  it('returns true for always policy on linux', () => {
    expect(includeExternalFor('always', 'linux')).toBe(true);
  });

  it('returns false for never policy on win32', () => {
    expect(includeExternalFor('never', 'win32')).toBe(false);
  });
});
