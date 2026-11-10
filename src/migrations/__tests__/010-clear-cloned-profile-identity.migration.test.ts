/**
 * Migration 010 repairs #701 residue only (EPMCDME-15411, AC13).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MultiProviderConfig } from '../../env/types.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const SHARED = {
  codeMieUrl: 'https://codemie.example.com',
  codeMieProject: 'mtlx-amsd',
  codeMieIntegration: { id: 'i1', alias: 'a1' },
};

describe('010-clear-cloned-profile-identity', () => {
  let home = '';
  const originalHome = process.env.CODEMIE_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mig010-'));
    process.env.CODEMIE_HOME = home;
  });

  afterEach(async () => {
    process.env.CODEMIE_HOME = originalHome;
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const configFile = (): string => join(home, 'codemie-cli.config.json');
  const ledgerFile = (): string => join(home, 'migrations.json');

  async function seedConfig(profiles: MultiProviderConfig['profiles']): Promise<void> {
    const config: MultiProviderConfig = { version: 2, activeProfile: Object.keys(profiles)[0], profiles, workspace: SHARED };
    await writeFile(configFile(), JSON.stringify(config));
  }

  async function seedLedger(ids: string[]): Promise<void> {
    await writeFile(ledgerFile(), JSON.stringify({
      version: 1,
      migrations: ids.map((id) => ({ id, appliedAt: '2026-10-28T00:00:00.000Z', success: true })),
    }));
  }

  const read = async (): Promise<MultiProviderConfig> => JSON.parse(await readFile(configFile(), 'utf-8'));

  async function run(): Promise<{ success: boolean; migrated: boolean; reason?: string }> {
    const { ClearClonedProfileIdentityMigration } = await import('../010-clear-cloned-profile-identity.migration.js');
    return new ClearClonedProfileIdentityMigration().up();
  }

  it('pins the #701 migration id', async () => {
    const { PR701_MIGRATION_ID } = await import('../010-clear-cloned-profile-identity.migration.js');
    expect(PR701_MIGRATION_ID).toBe('008-isolate-global-profile-identity');
  });

  it('clears every global profile whose trio equals the shared trio when #701 is in the ledger', async () => {
    await seedLedger(['007-decouple-provider-workspace-config', '008-isolate-global-profile-identity']);
    await seedConfig({
      'mtlx-amsd': { provider: 'ai-run-sso', ...SHARED },
      'mtlx-csd': { provider: 'ai-run-sso', ...SHARED },
      other: { provider: 'ai-run-sso', codeMieUrl: SHARED.codeMieUrl, codeMieProject: 'mtlx-other' },
    });

    const result = await run();
    expect(result).toMatchObject({ success: true, migrated: true });
    const config = await read();
    for (const name of ['mtlx-amsd', 'mtlx-csd']) {
      expect(config.profiles[name].codeMieProject).toBeUndefined();
      expect(config.profiles[name].codeMieUrl).toBeUndefined();
      expect(config.profiles[name].codeMieIntegration).toBeUndefined();
    }
    // A different trio is kept; nothing is assigned; the shared identity stays.
    expect(config.profiles.other.codeMieProject).toBe('mtlx-other');
    expect(config.workspace).toEqual(SHARED);
  });

  it('clears only cloned trios, keeps distinct ones and assigns no project to any profile', async () => {
    // @case global-profiles-share-workspace-identity_TC_003
    await seedLedger(['008-isolate-global-profile-identity']);
    await seedConfig({
      cloned: { provider: 'ai-run-sso', ...SHARED },
      distinct: {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://other.example.com',
        codeMieProject: 'own-proj',
        codeMieIntegration: { id: 'i2', alias: 'a2' },
      },
      bare: { provider: 'ai-run-sso' },
    });

    expect(await run()).toMatchObject({ success: true, migrated: true });
    const config = await read();
    expect(config.profiles.cloned.codeMieUrl).toBeUndefined();
    expect(config.profiles.cloned.codeMieProject).toBeUndefined();
    expect(config.profiles.cloned.codeMieIntegration).toBeUndefined();
    expect(config.profiles.distinct).toMatchObject({
      codeMieUrl: 'https://other.example.com',
      codeMieProject: 'own-proj',
      codeMieIntegration: { id: 'i2', alias: 'a2' },
    });
    expect(config.profiles.bare.codeMieProject).toBeUndefined();
  });

  it('does nothing when #701 never ran (released upgrade path)', async () => {
    await seedLedger(['007-decouple-provider-workspace-config', '008-repair-hook-shell-and-stale-paths']);
    await seedConfig({ a: { provider: 'ai-run-sso', ...SHARED }, b: { provider: 'ai-run-sso' } });
    const before = await readFile(configFile(), 'utf-8');
    expect(await run()).toMatchObject({ success: true, migrated: false, reason: 'pr701-not-applied' });
    expect(await readFile(configFile(), 'utf-8')).toBe(before);
  });

  it('assigns nothing to a profile that has no identity', async () => {
    await seedLedger(['008-isolate-global-profile-identity']);
    await seedConfig({ a: { provider: 'ai-run-sso' }, b: { provider: 'anthropic-subscription', codeMieProject: null } });
    expect(await run()).toMatchObject({ migrated: false, reason: 'nothing-to-clear' });
    const config = await read();
    expect(config.profiles.a.codeMieProject).toBeUndefined();
    expect(config.profiles.b.codeMieProject).toBeNull();
  });

  it('an unparsable ledger is moved aside and treated as #701 possibly applied', async () => {
    await writeFile(ledgerFile(), '{ broken');
    await seedConfig({ a: { provider: 'ai-run-sso', ...SHARED }, b: { provider: 'ai-run-sso', codeMieProject: 'mine' } });
    // Any ledger read (e.g. the runner's pending check) moves it aside first.
    const { MigrationTracker } = await import('../tracker.js');
    await MigrationTracker.getPendingMigrations();
    await expect(access(`${ledgerFile()}.corrupt`)).resolves.toBeUndefined();
    expect(await readFile(`${ledgerFile()}.corrupt`, 'utf-8')).toBe('{ broken');

    expect(await run()).toMatchObject({ success: true, migrated: true });
    const config = await read();
    expect(config.profiles.a.codeMieProject).toBeUndefined();
    expect(config.profiles.b.codeMieProject).toBe('mine');
  });

  it('two concurrent runs reach one outcome', async () => {
    await seedLedger(['008-isolate-global-profile-identity']);
    await seedConfig({
      a: { provider: 'ai-run-sso', ...SHARED },
      b: { provider: 'ai-run-sso', ...SHARED },
      c: { provider: 'ai-run-sso', codeMieProject: 'c' },
    });
    const results = await Promise.all([run(), run()]);
    expect(results.every((r) => r.success)).toBe(true);
    const config = await read();
    expect(config.profiles.a.codeMieProject).toBeUndefined();
    expect(config.profiles.b.codeMieProject).toBeUndefined();
    expect(config.profiles.c.codeMieProject).toBe('c');
    expect(config.workspace).toEqual(SHARED);
  });

  it('an unparsable global config keeps the migration pending and is not overwritten', async () => {
    await seedLedger(['008-isolate-global-profile-identity']);
    await writeFile(configFile(), '{ nope');
    expect(await run()).toMatchObject({ success: false, reason: 'global-config-unreadable' });
    expect(await readFile(configFile(), 'utf-8')).toBe('{ nope');
  });
});

describe('migration 007 never re-strips per-profile identity', () => {
  it('skips a config written by saveProfile (it always carries a workspace key)', async () => {
    const { DecoupleProviderWorkspaceConfigMigration } = await import('../007-decouple-provider-workspace-config.migration.js');
    const config: MultiProviderConfig = {
      version: 2,
      activeProfile: 'a',
      profiles: { a: { provider: 'ai-run-sso', codeMieProject: 'pa' }, b: { provider: 'ai-run-sso', codeMieProject: 'pb' } },
      workspace: {},
    };
    expect(new DecoupleProviderWorkspaceConfigMigration().migrate(config)).toBe(config);
  });
});
