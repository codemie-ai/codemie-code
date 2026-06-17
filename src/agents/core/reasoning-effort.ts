import type { CanonicalReasoningEffort, ReasoningEffortConfig } from './types.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

export const CANONICAL_EFFORT_ORDER: CanonicalReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeReasoningEffort(raw: string): CanonicalReasoningEffort | undefined {
  const lower = raw.toLowerCase();
  return CANONICAL_EFFORT_ORDER.includes(lower as CanonicalReasoningEffort)
    ? (lower as CanonicalReasoningEffort)
    : undefined;
}

export function clampToSupported(
  level: CanonicalReasoningEffort,
  supported: CanonicalReasoningEffort[],
): CanonicalReasoningEffort {
  if (supported.includes(level)) return level;
  const idx = CANONICAL_EFFORT_ORDER.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(CANONICAL_EFFORT_ORDER[i])) return CANONICAL_EFFORT_ORDER[i];
  }
  for (let i = idx + 1; i < CANONICAL_EFFORT_ORDER.length; i++) {
    if (supported.includes(CANONICAL_EFFORT_ORDER[i])) return CANONICAL_EFFORT_ORDER[i];
  }
  return level;
}

function hasUserOverride(args: string[], config: ReasoningEffortConfig): boolean {
  if (!config.userOverrideFlags?.length) return false;
  if (config.strategy === 'cli-config') {
    return args.some(arg => config.userOverrideFlags!.some(key => arg.includes(key)));
  }
  return args.some(arg =>
    config.userOverrideFlags!.some(
      flag => arg === flag || arg.startsWith(flag + '=')
    )
  );
}

export function applyReasoningEffort(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: ReasoningEffortConfig,
  rawLevel: string | undefined,
  agentName: string,
): { args: string[] } {
  if (!rawLevel) return { args };

  const normalized = normalizeReasoningEffort(rawLevel);
  if (!normalized) {
    logger.debug(`[${agentName}] reasoning-effort: unrecognized level '${rawLevel}', skipping`);
    return { args };
  }

  if (hasUserOverride(args, config)) {
    logger.debug(`[${agentName}] reasoning-effort: native override detected, skipping injection`);
    return { args };
  }

  const clamped = clampToSupported(normalized, config.supportedLevels);
  if (clamped !== normalized) {
    logger.debug(`[${agentName}] reasoning-effort: clamped '${normalized}' → '${clamped}'`);
    console.error(
      chalk.dim(`  ℹ  [${agentName}] --reasoning-effort '${normalized}' not supported; using '${clamped}'`)
    );
  }

  const mappedLevel = config.mapLevel ? (config.mapLevel(clamped) ?? clamped) : clamped;

  if (config.strategy === 'env') {
    for (const [key, template] of Object.entries(config.envVars ?? {})) {
      env[key] = template === '%s' ? mappedLevel : template;
    }
    return { args };
  }

  if (config.strategy === 'cli-flag') {
    const flag = config.flag!;
    const pair = [flag, mappedLevel];
    const placement = config.placement ?? 'append';
    return { args: placement === 'prepend' ? [...pair, ...args] : [...args, ...pair] };
  }

  if (config.strategy === 'cli-config') {
    const flag = config.configFlag ?? '--config';
    const pair = [flag, `${config.configKey!}="${mappedLevel}"`];
    const placement = config.placement ?? 'append';
    return { args: placement === 'prepend' ? [...pair, ...args] : [...args, ...pair] };
  }

  return { args };
}
