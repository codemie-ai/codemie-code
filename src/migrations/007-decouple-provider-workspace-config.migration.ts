import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * Keys that moved from ProviderProfile to WorkspaceConfig. Mirrors
 * ConfigLoader's private WORKSPACE_KEYS list (src/utils/config.ts) — kept as
 * an independent literal here so the migration has no runtime dependency on
 * ConfigLoader internals.
 */
const WORKSPACE_KEYS: (keyof WorkspaceConfig)[] = [
  'codeMieUrl',
  'codeMieProject',
  'codeMieIntegration',
  'hooks',
  'plugins',
  'assistants',
  'skillsSearchUrl',
  'claudeAutocompactPct',
  'metrics'
];

class DecoupleProviderWorkspaceConfigMigration implements Migration {
  id = '007-decouple-provider-workspace-config';
  description = 'Decouple repo/tooling-context fields from ProviderProfile into a scope-level WorkspaceConfig';

  async up(): Promise<MigrationResult> {
    const workingDir = process.cwd();
    let migrated = false;

    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    if (hasGlobal) {
      const globalConfig = await ConfigLoader.loadMultiProviderConfig();
      const migratedGlobal = this.migrate(globalConfig);
      if (migratedGlobal !== globalConfig) {
        await ConfigLoader.saveMultiProviderConfig(migratedGlobal);
        migrated = true;
      }
    }

    const hasLocal = await ConfigLoader.hasProjectConfig(workingDir);
    if (hasLocal) {
      const localConfig = await ConfigLoader.loadLocalMultiProviderConfig(workingDir);
      const migratedLocal = this.migrate(localConfig);
      if (migratedLocal !== localConfig) {
        await ConfigLoader.saveLocalMultiProviderConfig(workingDir, migratedLocal);
        migrated = true;
      }
    }

    return { success: true, migrated };
  }

  migrate(config: MultiProviderConfig): MultiProviderConfig {
    // Idempotent / no-op: a workspace already defined (including an explicit {})
    // means this config has already migrated.
    if (config.workspace !== undefined) return config;

    const profileEntries = Object.entries(config.profiles ?? {});

    const hasMovingField = (profile: ProviderProfile): boolean =>
      WORKSPACE_KEYS.some(key => (profile as any)[key] !== undefined);

    // Prefer the active profile as the source of truth for workspace fields; fall
    // back to the first profile (in object iteration order) that defines any.
    const activeProfile = config.activeProfile ? config.profiles?.[config.activeProfile] : undefined;
    const sourceEntry = activeProfile && hasMovingField(activeProfile)
      ? ([config.activeProfile, activeProfile] as [string, ProviderProfile])
      : profileEntries.find(([, profile]) => hasMovingField(profile));

    const workspace: WorkspaceConfig = {};
    if (sourceEntry) {
      const [, sourceProfile] = sourceEntry;
      for (const key of WORKSPACE_KEYS) {
        const value = (sourceProfile as any)[key];
        if (value !== undefined) {
          (workspace as any)[key] = value;
        }
      }
    }

    const profiles: Record<string, ProviderProfile> = {};
    for (const [name, profile] of profileEntries) {
      const clean: any = { ...profile };
      for (const key of WORKSPACE_KEYS) {
        delete clean[key];
      }
      profiles[name] = clean;
    }

    return {
      ...config,
      profiles,
      workspace
    };
  }
}

const migration = new DecoupleProviderWorkspaceConfigMigration();
MigrationRegistry.register(migration);
export { DecoupleProviderWorkspaceConfigMigration };
