/**
 * `codemie skills update [skills...]` — pass-through wrapper around the
 * upstream `skills update` subcommand. Auth-gated and lifecycle-metricked.
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
  type SkillScope,
} from './lib/skills-metrics.js';

interface UpdateOptions {
  global?: boolean;
  project?: boolean;
  yes?: boolean;
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update installed skills via the upstream skills CLI')
    .argument('[skills...]', 'specific skill names to update (default: all)')
    .option('-g, --global', 'restrict to user-scoped skills')
    .option('-p, --project', 'restrict to project-scoped skills')
    .option('-y, --yes', 'skip interactive confirmations')
    .action(async (skills: string[] = [], options: UpdateOptions) => {
      await requireAuthenticatedSession();

      const cwd = process.cwd();
      const scope: SkillScope = options.global
        ? 'global'
        : options.project
          ? 'project'
          : 'unknown';

      const skillNames = capList(skills);
      const skillCount = skills.length || undefined;

      const metric = await startSkillMetric('update', cwd);

      const args = ['update'];
      if (options.global) args.push('--global');
      if (options.project) args.push('--project');
      if (options.yes) args.push('--yes');
      if (skills.length > 0) args.push(...skills);

      try {
        const result = await runSkillsCli(args, { cwd });
        if (result.code === 0) {
          await emitCompleted(metric, {
            scope,
            skill_names: skillNames,
            skill_count: skillCount,
          });
          return;
        }
        const errorCode = classifySkillError({ result });
        await emitFailed(metric, {
          scope,
          skill_names: skillNames,
          skill_count: skillCount,
          error_code: errorCode,
        });
        process.exit(result.code || 1);
      } catch (error) {
        const errorCode = classifySkillError({ error });
        logger.error(
          `[skills] update failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await emitFailed(metric, {
          scope,
          skill_names: skillNames,
          skill_count: skillCount,
          error_code: errorCode,
        });
        process.exit(1);
      }
    });
}
