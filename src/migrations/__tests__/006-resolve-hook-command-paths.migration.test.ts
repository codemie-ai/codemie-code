/**
 * Migration 006 rewrites already-installed Claude/Gemini hook commands to the
 * absolute codemie path. Belt-and-suspenders for users on the fixed version
 * whose plugin version did not bump. Covers EPMCDME-14035 (Bug 1).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('006-resolve-hook-command-paths', () => {
  let home = '';

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'mig006-'));
    vi.doMock('os', async (imp) => ({ ...(await imp<typeof import('os')>()), homedir: () => home }));
    vi.doMock('../../utils/processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('/abs/codemie'),
    }));
    // homedir() is mocked to the temp dir, so the real file-backed logger would
    // write (and keep open) log files under <temp>/.codemie/logs. On Windows an
    // open handle blocks rmdir (ENOTEMPTY) in afterEach — mock it to a no-op.
    vi.doMock('../../utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  async function seedClaudeHooks(): Promise<string> {
    const dir = join(home, '.codemie', 'claude-plugin', 'hooks');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    await writeFile(
      file,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie sound UserPromptSubmit' }] }],
        },
      }),
    );
    return file;
  }

  it('rewrites bare codemie commands in installed claude hooks', async () => {
    const file = await seedClaudeHooks();
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    const res = await new RewriteHookCommandPathsMigration().up();
    expect(res.success).toBe(true);
    expect(res.migrated).toBe(true);
    const installed = JSON.parse(await readFile(file, 'utf-8'));
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(installed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/abs/codemie sound UserPromptSubmit');
  });

  it('is a no-op when no installed hook files exist', async () => {
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    const res = await new RewriteHookCommandPathsMigration().up();
    expect(res.success).toBe(true);
    expect(res.migrated).toBe(false);
  });

  it('is idempotent — second run makes no further changes', async () => {
    await seedClaudeHooks();
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    await new RewriteHookCommandPathsMigration().up();
    const res2 = await new RewriteHookCommandPathsMigration().up();
    expect(res2.success).toBe(true);
    expect(res2.migrated).toBe(false);
  });

  it('returns success:false when a needed rewrite cannot be written (so the runner retries)', async () => {
    await seedClaudeHooks(); // seeded with the real fs/promises before the mock below
    vi.doMock('fs/promises', async (imp) => {
      const actual = await imp<typeof import('fs/promises')>();
      return { ...actual, writeFile: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })) };
    });
    const { RewriteHookCommandPathsMigration } = await import('../006-resolve-hook-command-paths.migration.js');
    const res = await new RewriteHookCommandPathsMigration().up();
    // success:false leaves the migration pending so it retries on the next launch,
    // instead of being permanently recorded as applied with the hooks still broken.
    expect(res.success).toBe(false);
    expect(res.migrated).toBe(false);
  });
});
