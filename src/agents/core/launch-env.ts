/**
 * Launch environment defaults.
 *
 * An agent declares the variables its launcher sets as `AgentMetadata.launchEnvDefaults`. The
 * launcher applies that list (`applyLaunchEnvDefaults`) and `codemie doctor` describes it
 * (`describeLaunchEnv` + `formatLaunchEnvReport`), so the two can never disagree.
 *
 * Describing is pure and reads nothing: the caller passes the shell environment and the agent's
 * settings layers, already read.
 */

import { ProviderRegistry } from '../../providers/core/registry.js';
import { safeTerminalValue } from '../../utils/terminal-text.js';
import type { LaunchConfigLine, LaunchEnvDefault, LaunchSettingsLayer } from './types.js';

export type LaunchEnvSource = 'settings' | 'shell' | 'provider' | 'profile' | 'codemie-default';

/** The value an agent ends up running with for one declared variable, and where it came from. */
export interface LaunchEnvRow {
  name: string;
  effective: string;
  source: LaunchEnvSource;
  /** The settings file, when `source` is `settings`. */
  path?: string;
  /**
   * What CodeMie would have set (the provider's value, else the agent default), when that differs
   * from `effective`. For a `provider` row it is the agent default the provider replaced.
   */
  codemieValue?: string;
}

export interface LaunchEnvReport {
  /** False when the provider replaces the agent's default `beforeRun`, so no launch default applies. */
  applied: boolean;
  rows: LaunchEnvRow[];
  /** Settings files that exist but could not be read; their values are not reflected in `rows`. */
  unreadable: string[];
}

export interface DescribeLaunchEnvInput {
  /** The environment before any launch default. */
  shellEnv: NodeJS.ProcessEnv;
  defaultsApply: boolean;
  /** Lowest to highest precedence. */
  settingsLayers: LaunchSettingsLayer[];
  /** What the provider declares for this agent (`providerAgentEnv`); applied before the agent defaults. */
  providerEnv?: Readonly<Record<string, string>>;
}

/** The env the provider declares for this agent in `agentHooks.<agent>.env`; empty when it declares none. */
export function providerAgentEnv(provider: string | undefined, agentName: string): Readonly<Record<string, string>> {
  if (!provider) return {};
  return ProviderRegistry.getProvider(provider)?.agentHooks?.[agentName]?.env ?? {};
}

/**
 * Sets each value the provider (`env.CODEMIE_PROVIDER`) declares for `agentName`, only where the
 * variable is unset or empty, so a value from the user's shell wins. Runs before the `beforeRun`
 * hooks (executeBeforeRun), so the agent's own defaults only fill what is still unset.
 */
export function applyProviderAgentEnv(env: NodeJS.ProcessEnv, agentName: string): void {
  for (const [name, value] of Object.entries(providerAgentEnv(env.CODEMIE_PROVIDER, agentName))) {
    if (!env[name]) env[name] = value;
  }
}

/** Sets each declared variable that is unset or empty in `env`, in declaration order. */
export function applyLaunchEnvDefaults(env: NodeJS.ProcessEnv, defaults: readonly LaunchEnvDefault[]): void {
  for (const declared of defaults) {
    if (env[declared.name]) continue;
    const resolved = declared.value(env);
    if (resolved) env[declared.name] = resolved.value;
  }
}

/**
 * Whether a launch of `agentName` on `provider` runs the agent's default `beforeRun`, which is what
 * applies its launch defaults. Same rule as `resolveHook` in lifecycle-helpers.ts: a provider that
 * declares its own `beforeRun` for that agent replaces the default.
 */
export function defaultsApplyOnProvider(agentName: string, provider: string | undefined): boolean {
  if (!provider) return true;
  return !ProviderRegistry.getProvider(provider)?.agentHooks?.[agentName]?.beforeRun;
}

/** The highest-precedence settings file that sets it: its `env` block, or a top-level key for `settingsKey`. */
function fromSettings(declared: LaunchEnvDefault, layers: LaunchSettingsLayer[]): { value: string; path: string } | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.state !== 'ok') continue;
    const value = (declared.settingsKey ? layer.settings : layer.env)?.[declared.name];
    if (value !== undefined && value !== null) return { value: String(value), path: layer.path };
  }
  return undefined;
}

/**
 * Pure. The value each declared variable ends up with: settings, then shell, then the provider's
 * declared value, then the agent's profile or default value. When the provider replaces the agent's
 * default `beforeRun` (`defaultsApply` false), only provider values apply.
 */
export function describeLaunchEnv(defaults: readonly LaunchEnvDefault[], input: DescribeLaunchEnvInput): LaunchEnvReport {
  const providerEnv = input.providerEnv ?? {};
  if (!input.defaultsApply) {
    const rows: LaunchEnvRow[] = defaults
      .filter((declared) => providerEnv[declared.name])
      .map((declared) => ({ name: declared.name, effective: providerEnv[declared.name], source: 'provider' }));
    return { applied: false, rows, unreadable: [] };
  }

  const unreadable = input.settingsLayers.filter((layer) => layer.state === 'unreadable').map((layer) => layer.path);
  const rows: LaunchEnvRow[] = [];

  for (const declared of defaults) {
    const agentDefault = declared.value(input.shellEnv);
    const fromProvider = providerEnv[declared.name] || undefined;
    // What CodeMie would set when nothing outside it does: the provider's value, else the agent's.
    const codemie = fromProvider ?? agentDefault?.value;
    const differsFrom = (expected: string | undefined, row: LaunchEnvRow): LaunchEnvRow =>
      expected !== undefined && expected !== row.effective ? { ...row, codemieValue: expected } : row;

    const settings = fromSettings(declared, input.settingsLayers);
    if (settings) {
      rows.push(differsFrom(codemie, { name: declared.name, effective: settings.value, source: 'settings', path: settings.path }));
      continue;
    }
    if (declared.settingsKey) continue;
    const shell = input.shellEnv[declared.name];
    if (shell) {
      rows.push(differsFrom(codemie, { name: declared.name, effective: shell, source: 'shell' }));
      continue;
    }
    if (fromProvider) {
      rows.push(differsFrom(agentDefault?.value, { name: declared.name, effective: fromProvider, source: 'provider' }));
      continue;
    }
    if (agentDefault) rows.push({ name: declared.name, effective: agentDefault.value, source: agentDefault.from });
  }

  return { applied: true, rows, unreadable };
}

/** The line the launch-env rows sit under in `codemie doctor`. */
export const LAUNCH_ENV_HEADER = 'Environment at launch (value in effect, then where it comes from):';

/** Where the value in effect comes from, and what it overrides when CodeMie would have set something else. */
function sourceText(row: LaunchEnvRow, opts: { provider?: string; profileName: string }): string {
  const overrides = row.codemieValue === undefined ? '' : `, overrides CodeMie's ${safeTerminalValue(row.codemieValue)}`;
  switch (row.source) {
    case 'settings':
      return `${safeTerminalValue(row.path ?? '')}${overrides}`;
    case 'shell':
      return `your shell${overrides}`;
    case 'provider': {
      const replaces = row.codemieValue === undefined ? '' : `, replaces default ${safeTerminalValue(row.codemieValue)}`;
      return `provider ${safeTerminalValue(opts.provider ?? '')}${replaces}`;
    }
    case 'profile':
      return `profile "${safeTerminalValue(opts.profileName)}"`;
    default:
      return 'CodeMie default';
  }
}

/**
 * Doctor lines for a report: one header with a `NAME = value  source` row per variable under it
 * (names and values padded to one column each), then one line per unreadable settings file.
 * Nothing at all when there is nothing to show.
 */
export function formatLaunchEnvReport(
  report: LaunchEnvReport,
  opts: { provider?: string; profileName: string }
): LaunchConfigLine[] {
  const notApplied: LaunchConfigLine[] = report.applied
    ? []
    : [{ status: 'info', message: `Launch defaults not applied on ${safeTerminalValue(opts.provider ?? 'this provider')}` }];

  const shown = report.rows.map((row) => ({
    row,
    name: safeTerminalValue(row.name),
    value: row.effective === '' ? '(empty)' : safeTerminalValue(row.effective),
  }));
  const nameWidth = Math.max(0, ...shown.map((s) => s.name.length));
  const valueWidth = Math.max(0, ...shown.map((s) => s.value.length));

  const children: LaunchConfigLine[] = shown.map(({ row, name, value }) => {
    const message = `${name.padEnd(nameWidth)} = ${value.padEnd(valueWidth)}  ${sourceText(row, opts)}`;
    if (row.source === 'settings' && row.effective === '') {
      return { status: 'warn', message, hint: `Remove ${name} from ${safeTerminalValue(row.path ?? '')}` };
    }
    // ✓ for a value CodeMie manages (agent default, profile, provider); ○ for one set outside it.
    return { status: row.source === 'shell' || row.source === 'settings' ? 'info' : 'ok', message };
  });

  for (const path of report.unreadable) {
    const file = safeTerminalValue(path);
    children.push({
      status: 'info',
      message: `Could not read ${file}; its values are not shown`,
      hint: `Fix the JSON or the permissions of ${file}`,
    });
  }

  return [...notApplied, ...(children.length > 0 ? [{ status: 'info' as const, message: LAUNCH_ENV_HEADER, children }] : [])];
}
