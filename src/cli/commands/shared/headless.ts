/**
 * Headless-mode detection and flag validation shared by `codemie setup assistants`
 * and `codemie setup skills`.
 */

import { ConfigurationError } from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';

export interface HeadlessFlags {
  yes?: boolean;
  scope?: string;
  agent?: string;
  assistant?: string;
  skill?: string;
  mode?: string;
}

/**
 * Determines whether a command should run in non-interactive (headless) mode:
 * true when any relevant flag is set, or when stdout is not a TTY.
 */
export function isHeadlessMode(flags: HeadlessFlags, isTty: boolean): boolean {
  if (!isTty) {
    return true;
  }

  return Boolean(flags.yes || flags.scope || flags.agent || flags.assistant || flags.skill || flags.mode);
}

/**
 * Returns the given flag value, or throws a ConfigurationError naming the flag when missing.
 */
export function requireFlag(value: string | undefined, flagName: string): string {
  if (!value) {
    throw new ConfigurationError(`Missing required flag: ${flagName}`);
  }

  return value;
}

/**
 * Parses a scope flag value into a StorageScope, throwing a ConfigurationError for
 * any other value.
 */
export function parseScopeFlag(value: string): StorageScope {
  const normalized = value.trim().toLowerCase();

  if (normalized === StorageScope.GLOBAL) {
    return StorageScope.GLOBAL;
  }

  if (normalized === StorageScope.LOCAL) {
    return StorageScope.LOCAL;
  }

  throw new ConfigurationError(`Invalid scope: "${value}". Expected "global" or "local".`);
}

/**
 * Splits a comma-separated flag value into trimmed, de-duplicated, non-empty entries.
 * Throws a ConfigurationError when no non-empty values remain.
 */
export function parseListFlag(value: string): string[] {
  const items = Array.from(new Set(value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)));

  if (items.length === 0) {
    throw new ConfigurationError(`Expected a comma-separated list of values, got: "${value}"`);
  }

  return items;
}
