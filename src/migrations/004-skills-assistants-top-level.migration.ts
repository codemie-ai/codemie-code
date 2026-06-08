import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import type { MultiProviderConfig, CodemieSkill, CodemieAssistant, ProviderProfile } from '../env/types.js';

class SkillsAssistantsTopLevelMigration implements Migration {
  id = '004-skills-assistants-top-level';
  description = 'Move codemieSkills and codemieAssistants from profile-level to top-level config';

  async up(): Promise<MigrationResult> {
    const workingDir = process.cwd();
    let migrated = false;

    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    if (!hasGlobal) return { success: true, migrated: false, reason: 'no-existing-config' };

    const globalConfig = await ConfigLoader.loadMultiProviderConfig();
    const migratedGlobal = this.migrate(globalConfig);
    if (migratedGlobal !== globalConfig) {
      await ConfigLoader.saveMultiProviderConfig(migratedGlobal);
      migrated = true;
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
    const skillsMissing = config.codemieSkills === undefined;
    const assistantsMissing = config.codemieAssistants === undefined;

    if (!skillsMissing && !assistantsMissing) return config;

    const skillsMap = new Map<string, CodemieSkill>();
    const assistantsMap = new Map<string, CodemieAssistant>();
    const cleanProfiles: Record<string, ProviderProfile> = {};

    for (const [name, profile] of Object.entries(config.profiles)) {
      const { codemieSkills: profileSkills, codemieAssistants: profileAssistants, ...clean } = profile as any;
      cleanProfiles[name] = clean;

      if (skillsMissing) {
        for (const skill of profileSkills ?? []) {
          const existing = skillsMap.get(skill.id);
          if (!existing || new Date(skill.registeredAt) > new Date(existing.registeredAt)) {
            skillsMap.set(skill.id, skill);
          }
        }
      }
      if (assistantsMissing) {
        for (const assistant of profileAssistants ?? []) {
          const existing = assistantsMap.get(assistant.id);
          if (!existing || new Date(assistant.registeredAt) > new Date(existing.registeredAt)) {
            assistantsMap.set(assistant.id, assistant);
          }
        }
      }
    }

    return {
      ...config,
      profiles: cleanProfiles,
      codemieSkills: skillsMissing ? [...skillsMap.values()] : config.codemieSkills!,
      codemieAssistants: assistantsMissing ? [...assistantsMap.values()] : config.codemieAssistants!,
    };
  }
}

const migration = new SkillsAssistantsTopLevelMigration();
MigrationRegistry.register(migration);
export { SkillsAssistantsTopLevelMigration };
