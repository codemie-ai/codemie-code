/**
 * Claude's launch-config lines for `codemie doctor`, shown under the agent in Installed Agents.
 *
 * Reports which prompt-cache TTL a session started from this directory would ask for, which
 * variable or Claude settings file decides it, and how to change it. Same resolver as the launch
 * debug line; reads only (no settings file is written, nothing is spawned, no model request is
 * sent). Anything other than the 1h TTL is a warning with the way to remove it.
 */

import type { ClaudeSettingsLayer } from '../claude-code-otlp/event-fields/claude-settings-env.js';
import type { LaunchConfigContext, LaunchConfigLine, LaunchSettingsLayer } from '../../core/types.js';
import { stripTerminalControls } from '../../../utils/terminal-text.js';
import {
  describePromptCacheSource,
  resolvePromptCacheSetup,
  type CacheSource,
  type PromptCacheSetup,
} from './prompt-cache.js';
import { CLAUDE_LAUNCH_ENV_ROWS } from './launch-env-defaults.js';

const UNREADABLE = 'unreadable settings';

/** Variables `codemie doctor` already lists as environment rows under Claude. */
const ROW_NAMES = new Set(CLAUDE_LAUNCH_ENV_ROWS.map((row) => row.name));

/**
 * Names, values and paths below can come from the Claude settings files of whatever repository
 * doctor runs in, and doctor prints them as is: strip anything that could drive the terminal.
 */
const clean = stripTerminalControls;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude settings layers as the agent-neutral launch layers: just each file's `env` block. A file
 * whose `env` is present but not an object cannot be trusted, so it reads as unreadable.
 */
export function toLaunchSettingsLayers(layers: ClaudeSettingsLayer[]): LaunchSettingsLayer[] {
  return layers.map((layer): LaunchSettingsLayer => {
    if (layer.state !== 'ok') return { path: layer.path, state: layer.state };
    const env = layer.settings?.env;
    if (env === undefined) return { path: layer.path, state: 'ok' };
    return isPlainObject(env) ? { path: layer.path, state: 'ok', env } : { path: layer.path, state: 'unreadable' };
  });
}

/** How to remove what decided: unset the variable, delete the key from the file, or repair the file. */
function removalHint(decidedBy: string, source: CacheSource): string {
  if (source.kind === 'settings') {
    return decidedBy === UNREADABLE
      ? `Fix the JSON or the permissions of ${clean(source.path)}`
      : `Remove ${clean(decidedBy)} from ${clean(source.path)}`;
  }
  if (source.kind === 'shell') return `unset ${clean(decidedBy)}`;
  return 'Set ENABLE_PROMPT_CACHING_1H=1 in the shell';
}

function decidedByText(decidedBy: string, value: string | undefined, source: CacheSource): string {
  const shown = value === undefined ? '' : `=${value === '' ? '(empty)' : clean(value)}`;
  return `${clean(decidedBy)}${shown}, from ${clean(describePromptCacheSource(source))}`;
}

function outcomeLine(setup: PromptCacheSetup, ctx: LaunchConfigContext, command: string): LaunchConfigLine {
  const decided = decidedByText(setup.decidedBy, setup.value, setup.source);

  if (setup.ttl === '1h') {
    // ok only where CodeMie's own launch defaults apply; elsewhere a requested 1h is not verified.
    return setup.confirmed && ctx.defaultsApply
      ? { status: 'ok', message: `Prompt cache: 1h TTL (set by ${decided})` }
      : { status: 'info', message: 'Prompt cache: 1h TTL requested, not verified on this provider' };
  }

  if (!ctx.defaultsApply && setup.source.kind === 'upstream-default') {
    return {
      status: 'info',
      message:
        `Prompt cache: Claude Code's default TTL — CodeMie's 1h default is not applied to ${command} ` +
        `on ${clean(ctx.provider ?? 'this provider')} (known gap)`,
    };
  }

  const state = setup.ttl === 'disabled' ? 'disabled' : `${setup.ttl} TTL`;
  return {
    status: 'warn',
    message: `Prompt cache: ${state} (set by ${decided})`,
    hint: removalHint(setup.decidedBy, setup.source),
  };
}

/** The prompt-cache lines for one Claude agent (`claude` or `claude-acp`). Reads only. */
export async function describeClaudeLaunchConfig(ctx: LaunchConfigContext, agentName: string): Promise<LaunchConfigLine[]> {
  const command = `codemie-${agentName}`;
  const setup = await resolvePromptCacheSetup({
    env: { ...ctx.shellEnv, CODEMIE_PROVIDER: ctx.provider },
    codemieDefaults: ctx.defaultsApply,
    cwd: ctx.cwd,
  });

  const outcome = outcomeLine(setup, ctx, command);
  // A verified 1h decided by a variable is already an environment row (CLAUDE_LAUNCH_ENV_ROWS):
  // printing it again only repeats it. Anything else (another TTL, a settings key, unverified,
  // the known gap) is something the rows alone do not say.
  const shownAsRow = outcome.status === 'ok' && ROW_NAMES.has(setup.decidedBy);
  const lines: LaunchConfigLine[] = shownAsRow ? [] : [outcome];

  if (setup.subagent && setup.subagent.ttl !== '1h') {
    const { ttl, decidedBy, source } = setup.subagent;
    lines.push({
      status: 'warn',
      message: `Prompt cache for subagents: ${ttl} TTL (set by ${decidedByText(decidedBy, undefined, source)})`,
      hint: removalHint(decidedBy, source),
    });
  }

  return lines;
}
