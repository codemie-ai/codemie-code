/**
 * `codemie skills update [skills...]` — pass-through wrapper around the
 * upstream `skills update` subcommand. Auth-gated and lifecycle-metricked.
 */

import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { runSkillsCli } from './lib/run-skills-cli.js';
import { requireAuthenticatedSession } from './lib/require-auth.js';
import { capList } from './lib/sanitize.js';
import {
  emitCompleted,
  startSkillMetric,
  type SkillScope,
} from './lib/skills-metrics.js';
import { parseSkillNamesFromSkillsTelemetry } from './lib/skills-sh-telemetry.js';

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

      const metric = await startSkillMetric('update', cwd);

      const args = ['update'];
      if (options.global) args.push('--global');
      if (options.project) args.push('--project');
      if (options.yes) args.push('--yes');
      if (skills.length > 0) args.push(...skills);

      try {
        const result = await runSkillsCli(args, { cwd });
        if (result.code === 0) {
          // Upstream update can partially fail while still exiting 0. The shim
          // emits only "Updated <skill>" success lines, so metrics represent
          // actual successful updates rather than requested or failed skills.
          const updatedSkillNames = parseSkillNamesFromSkillsTelemetry(
            result.stderr,
            'update'
          );
          if (!updatedSkillNames || updatedSkillNames.length === 0) {
            logger.debug('[skills] CodeMie update metric debug', {
              sent: false,
              reason: 'no successfully updated skills captured from skills.sh',
              scope,
              requested_skills: skillNames,
            });
            return;
          }
          await emitCompleted(metric, {
            scope,
            skill_names: updatedSkillNames,
            skill_count: updatedSkillNames.length,
          });
          return;
        }
        // Failed update attempts are intentionally not sent to CodeMie because
        // this metric tracks successful skill lifecycle changes only.
        process.exit(result.code || 1);
      } catch (error) {
        logger.error(
          `[skills] update failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    });
}
