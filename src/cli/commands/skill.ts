import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { SkillManager, SkillSync } from '../../skills/index.js';
import { logger } from '../../utils/logger.js';
import type { Skill } from '../../skills/index.js';

/**
 * Format skill source with color
 */
function formatSource(source: Skill['source']): string {
  switch (source) {
    case 'project':
      return chalk.green('project');
    case 'mode-specific':
      return chalk.blue('mode-specific');
    case 'plugin':
      return chalk.magenta('plugin');
    case 'global':
      return chalk.white('global');
    default:
      return source;
  }
}

/**
 * Format priority with color
 */
function formatPriority(priority: number): string {
  if (priority >= 1000) return chalk.green(priority.toString());
  if (priority >= 500) return chalk.blue(priority.toString());
  return chalk.white(priority.toString());
}

/**
 * Create skill list command
 */
function createListCommand(): Command {
  return new Command('list')
    .description('List all discovered skills')
    .option('--mode <mode>', 'Filter by mode (e.g., code, architect)')
    .option('--agent <agent>', 'Filter by agent compatibility (e.g., codemie-code)')
    .option('--cwd <path>', 'Working directory for project skills', process.cwd())
    .action(async (options) => {
      try {
        const manager = SkillManager.getInstance();

        // Discover skills
        const skills = await manager.listSkills({
          cwd: options.cwd,
          mode: options.mode,
          agentName: options.agent,
          forceReload: false,
        });

        if (skills.length === 0) {
          console.log(chalk.yellow('\n⚠️  No skills found\n'));
          console.log(chalk.white('Skills can be created in:'));
          console.log(`  • ${chalk.cyan('.codemie/skills/')} (project-specific)`);
          console.log(`  • ${chalk.cyan('~/.codemie/skills/')} (global)`);
          if (options.mode) {
            console.log(`  • ${chalk.cyan(`~/.codemie/skills-${options.mode}/`)} (mode-specific)`);
          }
          console.log('');
          return;
        }

        // Create table
        const table = new Table({
          head: [
            chalk.bold('Name'),
            chalk.bold('Description'),
            chalk.bold('Source'),
            chalk.bold('Priority'),
            chalk.bold('Modes'),
            chalk.bold('Agents'),
          ],
          colWidths: [25, 40, 15, 10, 15, 15],
          wordWrap: true,
        });

        // Add rows
        for (const skill of skills) {
          table.push([
            chalk.bold(skill.metadata.name),
            skill.metadata.description,
            formatSource(skill.source),
            formatPriority(skill.computedPriority),
            skill.metadata.modes?.join(', ') || chalk.dim('all'),
            skill.metadata.compatibility?.agents?.join(', ') || chalk.dim('all'),
          ]);
        }

        console.log('');
        console.log(chalk.bold(`📚 Skills (${skills.length} found)`));
        console.log(table.toString());
        console.log('');

        // Show filters if applied
        if (options.mode || options.agent) {
          console.log(chalk.dim('Filters:'));
          if (options.mode) console.log(chalk.dim(`  Mode: ${options.mode}`));
          if (options.agent) console.log(chalk.dim(`  Agent: ${options.agent}`));
          console.log('');
        }
      } catch (error) {
        logger.error('Failed to list skills:', error);
        process.exit(1);
      }
    });
}

/**
 * Create skill validate command
 */
function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate all skill files')
    .option('--cwd <path>', 'Working directory for project skills', process.cwd())
    .action(async (options) => {
      try {
        const manager = SkillManager.getInstance();

        console.log(chalk.white('\n🔍 Validating skills...\n'));

        // Validate all skills
        const { valid, invalid } = await manager.validateAll({
          cwd: options.cwd,
          forceReload: true, // Force reload to ensure fresh validation
        });

        // Show results
        if (valid.length > 0) {
          console.log(chalk.green(`✓ Valid skills: ${valid.length}`));
          for (const skill of valid) {
            console.log(chalk.green(`  ✓ ${skill.metadata.name}`), chalk.dim(`(${skill.filePath})`));
          }
          console.log('');
        }

        if (invalid.length > 0) {
          console.log(chalk.red(`✗ Invalid skills: ${invalid.length}`));
          for (const result of invalid) {
            console.log(chalk.red(`  ✗ ${result.skillName || result.filePath}`));
            for (const error of result.errors) {
              console.log(chalk.red(`    • ${error}`));
            }
          }
          console.log('');
          process.exit(1); // Exit with error if any invalid
        }

        if (valid.length === 0 && invalid.length === 0) {
          console.log(chalk.yellow('No skills found to validate'));
          console.log('');
          process.exit(0);
        }

        console.log(chalk.green('✓ All skills are valid'));
        console.log('');
        process.exit(0);
      } catch (error) {
        logger.error('Failed to validate skills:', error);
        process.exit(1);
      }
    });
}

/**
 * Create skill reload command
 */
function createReloadCommand(): Command {
  return new Command('reload')
    .description('Clear skill cache and force reload')
    .action(() => {
      try {
        const manager = SkillManager.getInstance();

        // Get cache stats before
        const statsBefore = manager.getCacheStats();

        // Reload (clear cache)
        manager.reload();

        // Get cache stats after
        const statsAfter = manager.getCacheStats();

        console.log('');
        console.log(chalk.green('✓ Skill cache cleared'));
        console.log(chalk.dim(`  Cache entries cleared: ${statsBefore.size}`));
        console.log(chalk.dim(`  Cache entries now: ${statsAfter.size}`));
        console.log('');
        console.log(chalk.white('Skills will be reloaded on next agent start'));
        console.log('');
      } catch (error) {
        logger.error('Failed to reload skills:', error);
        process.exit(1);
      }
    });
}

/**
 * Create skill sync command
 */
function createSyncCommand(): Command {
  return new Command('sync')
    .description('Sync CodeMie skills to a target agent (e.g., Claude Code)')
    .option('--target <agent>', 'Target agent to sync skills to', 'claude')
    .option('--clean', 'Remove synced skills that no longer exist in CodeMie')
    .option('--dry-run', 'Preview what would be synced without writing')
    .option('--cwd <path>', 'Working directory for project skills', process.cwd())
    .action(async (options) => {
      try {
        if (options.target !== 'claude') {
          console.error(chalk.red(`\nUnsupported target: ${options.target}. Only "claude" is currently supported.\n`));
          process.exit(1);
        }

        const sync = new SkillSync();
        const result = await sync.syncToClaude({
          cwd: options.cwd,
          clean: options.clean,
          dryRun: options.dryRun,
        });

        const prefix = options.dryRun ? chalk.yellow('[dry-run] ') : '';

        console.log('');
        console.log(chalk.bold(`${prefix}Skill Sync → .claude/skills/`));
        console.log('');

        // Summary table
        const table = new Table({
          head: [chalk.bold('Status'), chalk.bold('Count'), chalk.bold('Skills')],
          colWidths: [15, 10, 60],
          wordWrap: true,
        });

        if (result.synced.length > 0) {
          table.push([
            chalk.green('Synced'),
            result.synced.length.toString(),
            result.synced.join(', '),
          ]);
        }

        if (result.skipped.length > 0) {
          table.push([
            chalk.dim('Skipped'),
            result.skipped.length.toString(),
            result.skipped.join(', '),
          ]);
        }

        if (result.removed.length > 0) {
          table.push([
            chalk.red('Removed'),
            result.removed.length.toString(),
            result.removed.join(', '),
          ]);
        }

        if (result.errors.length > 0) {
          table.push([
            chalk.red('Errors'),
            result.errors.length.toString(),
            result.errors.join(', '),
          ]);
        }

        if (result.synced.length === 0 && result.skipped.length === 0 &&
            result.removed.length === 0 && result.errors.length === 0) {
          console.log(chalk.yellow('No skills found to sync'));
        } else {
          console.log(table.toString());
        }

        console.log('');

        if (result.errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        logger.error('Failed to sync skills:', error);
        process.exit(1);
      }
    });
}

/**
 * Create main skill command with subcommands
 */
export function createSkillCommand(): Command {
  const skill = new Command('skill')
    .description('Manage skills for CodeMie agents');

  // Add subcommands
  skill.addCommand(createListCommand());
  skill.addCommand(createValidateCommand());
  skill.addCommand(createReloadCommand());
  skill.addCommand(createSyncCommand());

  return skill;
}
