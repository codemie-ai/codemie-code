import * as fs from 'fs/promises';
import * as path from 'path';
import { isLegacyConfig, isMultiProviderConfig } from '../env/types.js';
import type { MultiProviderConfig, ProviderProfile } from '../env/types.js';

export interface ProfileEntry {
  name: string;
  active: boolean;
  profile: ProviderProfile;
  source: 'local' | 'global';
}

/** Match ConfigLoader's tolerant JSON reads without loading provider plugins or a logger. */
export async function readProfileConfig(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

export function asGlobalProfileConfig(rawConfig: unknown): MultiProviderConfig {
  if (isMultiProviderConfig(rawConfig)) return rawConfig;
  if (isLegacyConfig(rawConfig)) {
    return {
      version: 2,
      activeProfile: 'default',
      profiles: { default: { name: 'default', ...rawConfig } },
    };
  }
  return { version: 2, activeProfile: 'default', profiles: {} };
}

/** Preserve global insertion order while replacing duplicate entries with local profiles. */
export function profileEntries(globalConfig: MultiProviderConfig, localConfig: unknown): ProfileEntry[] {
  const profiles: ProfileEntry[] = Object.entries(globalConfig.profiles).map(([name, profile]) => ({
    name, active: false, profile, source: 'global',
  }));
  let localActiveProfile: string | null = null;
  if (isMultiProviderConfig(localConfig)) {
    localActiveProfile = localConfig.activeProfile;
    for (const [name, profile] of Object.entries(localConfig.profiles)) {
      const entry: ProfileEntry = { name, active: false, profile, source: 'local' };
      const index = profiles.findIndex(existing => existing.name === name);
      if (index >= 0) profiles[index] = entry;
      else profiles.push(entry);
    }
  }
  const activeName = localActiveProfile || globalConfig.activeProfile;
  for (const profile of profiles) profile.active = profile.name === activeName;
  return profiles;
}

/** List profile entries with the same file and legacy handling as ConfigLoader.listProfiles. */
export async function readProfileEntries(globalPath: string, cwd: string): Promise<ProfileEntry[]> {
  const globalConfig = asGlobalProfileConfig(await readProfileConfig(globalPath));
  const localPath = path.join(cwd, '.codemie/codemie-cli.config.json');
  let localConfig: unknown = {};
  try {
    await fs.access(localPath);
    localConfig = await readProfileConfig(localPath);
  } catch {
    // No accessible local configuration.
  }
  return profileEntries(globalConfig, localConfig);
}
