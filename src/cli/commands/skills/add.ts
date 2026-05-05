/**
 * `codemie skills add <source>` — install one or more skills via the upstream
 * `skills` CLI with CodeMie auth gating, optional local agent detection, and
 * lifecycle metrics. The wrapper never classifies source domains or parses
 * upstream interactive output.
 */

import os from 'node:os';
import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { runSkillsCli } from './lib/run-skills-cli.js';
import { requireAuthenticatedSession } from './lib/require-auth.js';
import {
  resolveAgentSelection,
  type AgentSelection,
} from './lib/agent-detection.js';
import { capList, sanitizeSource } from './lib/sanitize.js';
import { classifySkillError } from './lib/error-classify.js';
import {
  emitCompleted,
  emitFailed,
  startSkillMetric,
} from './lib/skills-metrics.js';

interface AddOptions {
  global?: boolean;
  skill?: string[];
  agent?: string[];
  yes?: boolean;
  copy?: boolean;
}

export function createAddCommand(): Command {
  return new Command('add')
    .description('Install skills via the upstream skills CLI')
    .argument(
      '<source>',
      'skills.sh source: owner/repo, full URL, SSH URL, local path, or well-known endpoint'
    )
    .option('-g, --global', 'install to user (~/) directory')
    .option('-s, --skill <skills...>', 'install specific skills by name')
    .option('-a, --agent <agents...>', 'target agents (passed to skills.sh)')
    .option('-y, --yes', 'skip interactive confirmations')
    .option('--copy', 'copy instead of symlink (forced on Windows)')
    .action(async (source: string, options: AddOptions) => {
      await requireAuthenticatedSession();

      const cwd = process.cwd();
      const interactive = !options.yes && process.stdin.isTTY === true;

      let agentSelection: AgentSelection;
      try {
        agentSelection = await resolveAgentSelection({
          cwd,
          explicitAgents: options.agent,
          interactive,
        });
      } catch (error) {
        logger.debug('[skills] Agent detection failed; deferring to upstream', error);
        agentSelection = { agents: [], mode: 'upstream' };
      }

      const scope = options.global ? 'global' : 'project';
      const sanitizedSource = sanitizeSource(source);
      const skillNames = capList(options.skill);
      const skillCount = options.skill?.length;
      const targetAgents =
        agentSelection.mode === 'upstream' ? undefined : capList(agentSelection.agents);
      const selectionMode =
        agentSelection.mode === 'upstream' ? undefined : agentSelection.mode;

      const metric = await startSkillMetric('add', cwd);

      const args = buildAddArgs(source, options, agentSelection.agents);

      try {
        const result = await runSkillsCli(args, { cwd });

        if (result.code === 0) {
          await emitCompleted(metric, {
            scope,
            source: sanitizedSource,
            skill_names: skillNames,
            skill_count: skillCount,
            target_agents: targetAgents,
            agent_selection_mode: selectionMode,
          });
          return;
        }

        const errorCode = classifySkillError({ result });
        await emitFailed(metric, {
          scope,
          source: sanitizedSource,
          skill_names: skillNames,
          skill_count: skillCount,
          target_agents: targetAgents,
          agent_selection_mode: selectionMode,
          error_code: errorCode,
        });
        process.exit(result.code || 1);
      } catch (error) {
        const errorCode = classifySkillError({ error });
        logger.error(
          `[skills] add failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await emitFailed(metric, {
          scope,
          source: sanitizedSource,
          skill_names: skillNames,
          skill_count: skillCount,
          target_agents: targetAgents,
          agent_selection_mode: selectionMode,
          error_code: errorCode,
        });
        process.exit(1);
      }
    });
}

function buildAddArgs(
  source: string,
  options: AddOptions,
  resolvedAgents: readonly string[]
): string[] {
  const args = ['add', source];

  if (options.global) args.push('--global');
  if (options.yes) args.push('--yes');
  if (options.copy || os.platform() === 'win32') args.push('--copy');

  if (options.skill && options.skill.length > 0) {
    args.push('--skill', ...options.skill);
  }
  if (resolvedAgents.length > 0) {
    args.push('--agent', ...resolvedAgents);
  }

  return args;
}
