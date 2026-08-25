import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * CodeMie connectivity identity — always sourced from a single profile together,
 * never mixed across profiles. A codeMieUrl from one provider paired with a
 * codeMieProject/codeMieIntegration from another would point the client at the
 * wrong project/integration, so these three resolve as one atomic group.
 */
const IDENTITY_KEYS: (keyof WorkspaceConfig)[] = ['codeMieUrl', 'codeMieProject', 'codeMieIntegration'];

/**
 * Remaining repo/tooling-context fields. Unlike the identity trio, these carry
 * no cross-field consistency requirement, so each resolves independently —
 * whichever profile defines it.
 */
const OTHER_WORKSPACE_KEYS: (keyof WorkspaceConfig)[] = [
  'hooks',
  'plugins',
  'assistants',
  'skillsSearchUrl',
  'claudeAutocompactPct',
  'metrics'
];

/**
 * Keys that moved from ProviderProfile to WorkspaceConfig. Mirrors
 * ConfigLoader's private WORKSPACE_KEYS list (src/utils/config.ts) — kept as
 * an independent literal here so the migration has no runtime dependency on
 * ConfigLoader internals.
 */
const WORKSPACE_KEYS: (keyof WorkspaceConfig)[] = [...IDENTITY_KEYS, ...OTHER_WORKSPACE_KEYS];

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
    const activeProfile = config.activeProfile ? config.profiles?.[config.activeProfile] : undefined;

    const hasAnyKey = (profile: ProviderProfile, keys: (keyof WorkspaceConfig)[]): boolean =>
      keys.some(key => (profile as any)[key] !== undefined);

    const workspace: WorkspaceConfig = {};

    // Identity trio: prefer the active profile if it defines any of codeMieUrl/
    // codeMieProject/codeMieIntegration; otherwise fall back to the first profile
    // (iteration order) that does. All three come from that ONE profile together.
    const identitySourceEntry = activeProfile && hasAnyKey(activeProfile, IDENTITY_KEYS)
      ? ([config.activeProfile, activeProfile] as [string, ProviderProfile])
      : profileEntries.find(([, profile]) => hasAnyKey(profile, IDENTITY_KEYS));
    if (identitySourceEntry) {
      const [, sourceProfile] = identitySourceEntry;
      for (const key of IDENTITY_KEYS) {
        const value = (sourceProfile as any)[key];
        if (value !== undefined) {
          (workspace as any)[key] = value;
        }
      }
    }

    // Remaining fields carry no cross-field consistency requirement, so each
    // resolves independently: the active profile's value if it defines one,
    // else the first profile (iteration order) that does.
    for (const key of OTHER_WORKSPACE_KEYS) {
      const activeValue = activeProfile && (activeProfile as any)[key];
      if (activeValue !== undefined) {
        (workspace as any)[key] = activeValue;
        continue;
      }
      const found = profileEntries.find(([, profile]) => (profile as any)[key] !== undefined);
      if (found) {
        (workspace as any)[key] = (found[1] as any)[key];
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

    // Mirror the non-empty guard saveProfile()/initProjectConfig() use before writing
    // `workspace`: an empty {} is a *defined* workspace to resolveWorkspace()'s
    // whole-object-override rule, so writing one here for every scope that never had
    // a moving field would permanently cut that scope off from its global fallback.
    // Leave `workspace` unset in that case instead.
    const hasWorkspaceFields = Object.keys(workspace).length > 0;

    return {
      ...config,
      profiles,
      ...(hasWorkspaceFields ? { workspace } : {})
    };
  }
}

const migration = new DecoupleProviderWorkspaceConfigMigration();
MigrationRegistry.register(migration);
export { DecoupleProviderWorkspaceConfigMigration };
