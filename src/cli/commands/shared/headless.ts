/**
 * Headless-mode detection and flag validation shared by `codemie setup assistants`
 * and `codemie setup skills`.
 */

import { ConfigurationError } from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';
import {
  parseAgentSetupTarget,
  type AgentSetupTarget,
  type TargetAgent,
} from '@/cli/commands/shared/agent-targets.js';

export interface HeadlessFlags {
  yes?: boolean;
  assistant?: string;
  skill?: string;
  /**
   * Accepted so callers can hand over their whole options object, but deliberately
   * not part of the headless decision — see `isHeadlessMode`.
   */
  scope?: string;
  agent?: string;
  mode?: string;
}

/**
 * Determines whether a command should run in non-interactive (headless) mode:
 * true when stdin is not a TTY, or when a flag that only makes sense
 * non-interactively is present — the item-selection flags (`--assistant` /
 * `--skill`) or `-y/--yes`.
 *
 * `--agent`, `--scope` and `--mode` must NOT select headless mode. `--agent`
 * shipped long before headless mode as a wizard preselector, so treating it as a
 * headless trigger would break `codemie setup assistants --agent claude` at a
 * TTY; `--scope` and `--mode` are preselectors on the same surface.
 */
export function isHeadlessMode(flags: HeadlessFlags, isTty: boolean): boolean {
  if (!isTty) {
    return true;
  }

  return Boolean(flags.yes || flags.assistant || flags.skill);
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

/**
 * Resolves the headless agent target from `--agent`, falling back to the agent
 * hosting the command (`codemie-<agent> setup ...` wires its adapter name in as
 * `hostAgent`), which determines the target just as unambiguously as the flag.
 * Throws a ConfigurationError naming `--agent` only when neither is available,
 * so the generic `codemie setup` surface still requires an explicit target.
 * Agent targets are never auto-detected on this path.
 */
export function resolveHeadlessAgentTarget(
  value: string | undefined,
  hostAgent?: TargetAgent
): AgentSetupTarget {
  return parseAgentSetupTarget(requireFlag(value ?? hostAgent, '--agent'));
}

export interface RegisteredPartition<T> {
  /** Already-registered records the request names, which will be re-registered. */
  inScope: T[];
  /** Already-registered records the request does not name, which must survive untouched. */
  untouched: T[];
}

/**
 * Splits already-registered records against the requested ids. Headless
 * registration is purely additive, so the "currently registered" set handed to
 * the change calculation must be narrowed to the overlap with the request —
 * anything outside it would otherwise be derived as a removal.
 */
export function partitionRegisteredByRequest<T extends { id: string }>(
  registered: T[],
  selectedIds: string[]
): RegisteredPartition<T> {
  const selected = new Set(selectedIds);

  return {
    inScope: registered.filter((item) => selected.has(item.id)),
    untouched: registered.filter((item) => !selected.has(item.id)),
  };
}
