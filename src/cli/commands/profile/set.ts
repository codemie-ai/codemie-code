import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';

interface FlagDef {
  type: 'boolean' | 'number';
  description: string;
  nullable?: boolean;
  min?: number;
  max?: number;
}

const FEATURE_GROUPS: Record<string, Record<string, FlagDef>> = {
  contextCompression: {
    enabled: { type: 'boolean', description: 'Enable context compression' },
    cacheAligner: { type: 'boolean', description: 'Stabilize system-message prefix for KV-cache hits' },
    compressUserMessages: { type: 'boolean', description: 'Compress user-role messages' },
    compressSystemMessages: { type: 'boolean', description: 'Compress system-role messages' },
    protectAnalysisContext: { type: 'boolean', description: 'Freeze tool-result messages from compression' },
    protectRecent: { type: 'number', description: 'Number of recent messages protected as tail' },
    targetRatio: { type: 'number', description: 'Stop compressing at this ratio (0–1); use "none" to disable', nullable: true, min: 0, max: 1 },
    minTokensToCompress: { type: 'number', description: 'Skip pipeline if total tokens <= this' },
  },
};

function coerceValue(def: FlagDef, raw: string): boolean | number | null {
  if (def.nullable && raw === 'none') return null;

  if (def.type === 'boolean') {
    if (raw === 'true' || raw === 'on') return true;
    if (raw === 'false' || raw === 'off') return false;
    throw new Error(`Expected boolean (true/false/on/off), got "${raw}"`);
  }

  const n = Number(raw);
  if (isNaN(n)) throw new Error(`Expected number, got "${raw}"`);
  if (def.min !== undefined && n < def.min) throw new Error(`Value must be >= ${def.min}, got ${n}`);
  if (def.max !== undefined && n > def.max) throw new Error(`Value must be <= ${def.max}, got ${n}`);
  return n;
}

async function handleSet(key: string, rawValue: string, profileFlag?: string): Promise<void> {
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'features') {
    throw new Error(`Only features.* keys are supported. Got: "${key}"`);
  }

  const [, group, flag] = parts;

  const groupDefs = FEATURE_GROUPS[group];
  if (!groupDefs) {
    const validGroups = Object.keys(FEATURE_GROUPS).join(', ');
    throw new Error(`Unknown feature group '${group}'. Valid groups: ${validGroups}`);
  }

  const flagDef = groupDefs[flag];
  if (!flagDef) {
    const validFlags = Object.keys(groupDefs).join(', ');
    throw new Error(`Unknown flag '${flag}' in group '${group}'. Valid flags: ${validFlags}`);
  }

  if (rawValue === 'none' && !flagDef.nullable) {
    throw new Error(`features.${group}.${flag} cannot be set to null`);
  }

  const coerced = coerceValue(flagDef, rawValue);

  const workingDir = process.cwd();
  let profileName: string;

  if (profileFlag) {
    profileName = profileFlag;
  } else {
    const active = await ConfigLoader.getActiveProfileName(workingDir);
    if (!active) {
      throw new Error('No active profile. Run: codemie setup or use --profile <name>');
    }
    profileName = active;
  }

  const profile = await ConfigLoader.getProfile(profileName, workingDir);
  if (!profile) {
    throw new Error(`Profile "${profileName}" not found`);
  }

  if (!profile.features) profile.features = {};

  if (group === 'contextCompression') {
    if (!profile.features.contextCompression) profile.features.contextCompression = {};
    Object.assign(profile.features.contextCompression, { [flag]: coerced });
  }

  await ConfigLoader.saveProfile(profileName, profile);

  const displayValue = coerced === null ? 'null' : String(coerced);
  console.log(chalk.green('✓') + ` Set features.${group}.${flag} = ${displayValue} on profile "${profileName}"`);
}

export function createSetCommand(): Command {
  const command = new Command('set');

  command
    .description('Set a feature flag on the active profile (e.g. features.contextCompression.enabled true)')
    .argument('<key>', 'Feature key in features.<group>.<flag> format')
    .argument('<value>', 'Value: true/false/on/off for booleans, number for numerics, "none" to unset nullable')
    .option('--profile <name>', 'Target a specific profile instead of the active one')
    .action(async (key: string, value: string, options: { profile?: string }) => {
      try {
        await handleSet(key, value, options.profile);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  return command;
}
