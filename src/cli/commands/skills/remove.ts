/**
 * `codemie skills remove [skills...]` — pass-through wrapper around the
 * upstream `skills remove` subcommand. Auth-gated and lifecycle-metricked.
 *
 * `target_agents` is emitted only when the user explicitly passed `--agent`
 * — the wrapper never auto-detects on remove because removal is destructive
 * and the user should be specific.
 */

import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { runSkillsCli } from './lib/run-skills-cli.js';
import { requireAuthenticatedSession } from './lib/require-auth.js';
import { capList } from './lib/sanitize.js';
import { classifySkillError } from './lib/error-classify.js';
import {
  emitCompleted,
  emitFailed,
  startSkillMetric,
  type AgentSelectionMode,
  type SkillScope,
} from './lib/skills-metrics.js';
import { parseSkillNamesFromSkillsTelemetry } from './lib/skills-sh-telemetry.js';

interface RemoveOptions {
  global?: boolean;
  agent?: string[];
  skill?: string[];
  yes?: boolean;
}

export function createRemoveCommand(): Command {
  return new Command('remove')
    .description('Remove installed skills via the upstream skills CLI')
    .argument('[skills...]', 'specific skill names to remove (default: prompt)')
    .option('-g, --global', 'remove from user (~/) directory')
    .option('-a, --agent <agents...>', 'restrict removal to specific agents')
    .option('-s, --skill <skills...>', 'restrict removal to specific skill names')
    .option('-y, --yes', 'skip interactive confirmations')
    .action(async (skills: string[] = [], options: RemoveOptions) => {
      await requireAuthenticatedSession();

      const cwd = process.cwd();
      const scope: SkillScope = options.global ? 'global' : 'project';

      const explicitSkills = [
        ...(skills ?? []),
        ...(options.skill ?? []),
      ];
      const skillNames = capList(explicitSkills);
      const skillCount = explicitSkills.length || undefined;
      const targetAgents = capList(options.agent);
      const selectionMode: AgentSelectionMode | undefined =
        options.agent && options.agent.length > 0 ? 'explicit' : undefined;

      const metric = await startSkillMetric('remove', cwd);

      const args = ['remove'];
      if (options.global) args.push('--global');
      if (options.yes) args.push('--yes');
      if (options.skill && options.skill.length > 0) {
        args.push('--skill', ...options.skill);
      }
      if (options.agent && options.agent.length > 0) {
        args.push('--agent', ...options.agent);
      }
      if (skills.length > 0) args.push(...skills);

      try {
        const result = await runSkillsCli(args, { cwd });
        if (result.code === 0) {
          // Explicit names describe the requested removal. Interactive mode has
          // no request-time names, so use the upstream success payload instead.
          const metricSkillNames =
            skillNames ?? parseSkillNamesFromSkillsTelemetry(result.stderr, 'remove');
          const metricSkillCount = metricSkillNames?.length;
          await emitCompleted(metric, {
            scope,
            skill_names: metricSkillNames,
            skill_count: metricSkillCount,
            target_agents: targetAgents,
            agent_selection_mode: selectionMode,
          });
          return;
        }
        const errorCode = classifySkillError({ result });
        await emitFailed(metric, {
          scope,
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
          `[skills] remove failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await emitFailed(metric, {
          scope,
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
