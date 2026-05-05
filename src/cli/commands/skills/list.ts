/**
 * `codemie skills list` — pass-through wrapper around the upstream
 * `skills list` subcommand. Auth-gated and lifecycle-metricked.
 *
 * `--json` is forwarded to the upstream CLI so machine-readable output
 * stays under upstream's control. The wrapper never parses output to
 * extract installed skill metadata.
 */

import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { runSkillsCli } from './lib/run-skills-cli.js';
import { requireAuthenticatedSession } from './lib/require-auth.js';
import { classifySkillError } from './lib/error-classify.js';
import {
  emitCompleted,
  emitFailed,
  startSkillMetric,
  type SkillScope,
} from './lib/skills-metrics.js';

interface ListOptions {
  global?: boolean;
  agent?: string;
  json?: boolean;
}

export function createListCommand(): Command {
  return new Command('list')
    .description('List installed skills via the upstream skills CLI')
    .option('-g, --global', 'list user-scoped skills')
    .option('-a, --agent <agent>', 'filter by target agent')
    .option('--json', 'emit JSON output (forwarded to upstream)')
    .action(async (options: ListOptions) => {
      await requireAuthenticatedSession();

      const cwd = process.cwd();
      const scope: SkillScope = options.global ? 'global' : 'project';

      const metric = await startSkillMetric('list', cwd);

      const args = ['list'];
      if (options.global) args.push('--global');
      if (options.agent) args.push('--agent', options.agent);
      if (options.json) args.push('--json');

      // List is read-only; capture output instead of inheriting stdio so the
      // upstream JSON mode (when requested) can be piped cleanly.
      const interactive = !options.json;

      try {
        const result = await runSkillsCli(args, { cwd, interactive });

        // In non-interactive (--json) mode the child output was captured but
        // not echoed, so forward it to the caller verbatim.
        if (!interactive) {
          if (result.stdout) process.stdout.write(`${result.stdout}\n`);
          if (result.stderr) process.stderr.write(`${result.stderr}\n`);
        }

        if (result.code === 0) {
          await emitCompleted(metric, { scope });
          return;
        }
        await emitFailed(metric, {
          scope,
          error_code: classifySkillError({ result }),
        });
        process.exit(result.code || 1);
      } catch (error) {
        logger.error(
          `[skills] list failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await emitFailed(metric, {
          scope,
          error_code: classifySkillError({ error }),
        });
        process.exit(1);
      }
    });
}
