/**
 * Local project agent detection for `codemie skills add`.
 *
 * The wrapper inspects only strong project-local markers (well-known
 * directories that unambiguously identify an agent runtime in the current
 * project). Source-domain, registry ownership, or catalog labels are
 * intentionally NOT considered — discovery and trust live in the future
 * CodeMie UI/catalog, not in this CLI.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import inquirer from 'inquirer';
import { logger } from '@/utils/logger.js';

export type AgentSelectionMode =
  | 'explicit'
  | 'auto_detected'
  | 'prompted'
  | 'upstream';

export interface AgentSelection {
  agents: string[];
  mode: AgentSelectionMode;
}

interface StrongMarker {
  /** Directory name relative to the project root that proves the agent runtime. */
  dir: string;
  /** Value passed to skills.sh `--agent`. */
  agent: string;
  /** Human-friendly label used in prompts. */
  label: string;
}

const STRONG_MARKERS: readonly StrongMarker[] = [
  { dir: '.claude', agent: 'claude-code', label: 'Claude Code (.claude/)' },
  { dir: '.cursor', agent: 'cursor', label: 'Cursor (.cursor/)' },
];

export interface ResolveAgentSelectionOptions {
  cwd: string;
  /** Values from `--agent` exactly as supplied by the user (may be empty/undefined). */
  explicitAgents?: string[];
  /**
   * False when the wrapper must not prompt (e.g. `--yes`, non-TTY).
   * When ambiguous and non-interactive, the wrapper falls through to
   * upstream so skills.sh handles the selection itself.
   */
  interactive: boolean;
}

export async function resolveAgentSelection(
  options: ResolveAgentSelectionOptions
): Promise<AgentSelection> {
  const { cwd, explicitAgents, interactive } = options;

  if (explicitAgents && explicitAgents.length > 0) {
    return { agents: [...explicitAgents], mode: 'explicit' };
  }

  const detected = detectStrongMarkers(cwd);

  if (detected.length === 0) {
    return { agents: [], mode: 'upstream' };
  }

  if (detected.length === 1) {
    const marker = detected[0]!;
    logger.debug(
      `[skills] Auto-detected agent "${marker.agent}" from marker ${marker.dir}/`
    );
    return { agents: [marker.agent], mode: 'auto_detected' };
  }

  if (!interactive) {
    logger.debug(
      `[skills] Multiple agent markers detected but running non-interactively; deferring to upstream`
    );
    return { agents: [], mode: 'upstream' };
  }

  const answer = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Multiple agent markers detected. Select target agents:',
      choices: detected.map((m) => ({ name: m.label, value: m.agent })),
      validate: (input: readonly string[]) =>
        input.length > 0 ? true : 'Select at least one agent',
    },
  ]);

  return { agents: answer.selected, mode: 'prompted' };
}

function detectStrongMarkers(cwd: string): StrongMarker[] {
  return STRONG_MARKERS.filter((marker) => existsSync(path.join(cwd, marker.dir)));
}
