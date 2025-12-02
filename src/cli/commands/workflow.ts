/**
 * Workflow management CLI commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import {
  detectVCSProvider,
  getTemplatesByProvider,
  getAllTemplates,
  getTemplate,
  installWorkflow,
  uninstallWorkflow,
  listInstalledWorkflows,
  isWorkflowInstalled,
  validateDependencies,
  type VCSProvider,
  type WorkflowInstallOptions,
} from '../../workflows/index.js';

export function createWorkflowCommand(): Command {
  const workflow = new Command('workflow')
    .description('Manage CI/CD workflows (GitHub Actions, GitLab CI)')
    .addHelpText('after', `

Examples:
  $ codemie workflow list                    # List all available workflows
  $ codemie workflow list --installed        # Show only installed workflows

  $ codemie workflow install pr-review       # Install PR review workflow
  $ codemie workflow install pr-review -i    # Install with interactive prompts
  $ codemie workflow install pr-review --timeout 30 --max-turns 100

  $ codemie workflow uninstall pr-review     # Remove installed workflow

Available Workflows:
  pr-review   - Automated code review on pull requests
  inline-fix  - Quick fixes from PR comments mentioning @codemie
  code-ci     - Full feature implementation from issues

Configuration Options:
  --timeout <minutes>   How long the workflow can run (default: 15)
  --max-turns <number>  Maximum AI conversation turns (default: 50)
  --environment <env>   GitHub environment for protection rules
  --interactive, -i     Interactive mode with helpful prompts

Note: Workflows require repository secrets to be configured.
Run 'codemie workflow install <id>' to see required secrets for each workflow.
`);

  // List command
  workflow
    .command('list')
    .description('List available workflow templates')
    .option('--remote', 'Include remote templates (not yet implemented)')
    .option('--installed', 'Show only installed workflows')
    .option('--github', 'Show only GitHub workflows')
    .option('--gitlab', 'Show only GitLab workflows')
    .addHelpText('after', `

Examples:
  $ codemie workflow list                # List all workflows
  $ codemie workflow list --installed    # Show only what's installed
  $ codemie workflow list --github       # GitHub workflows only
`)
    .action(async (options: { remote?: boolean; installed?: boolean; github?: boolean; gitlab?: boolean }) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║       Available Workflows            ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      // Detect provider or use specified
      let provider: VCSProvider | undefined;
      if (options.github) {
        provider = 'github';
      } else if (options.gitlab) {
        provider = 'gitlab';
      } else {
        const detection = detectVCSProvider();
        if (detection.provider) {
          provider = detection.provider;
          console.log(chalk.white(`Auto-detected: ${provider} repository\n`));
        }
      }

      if (options.installed) {
        // Show installed workflows
        if (!provider) {
          console.log(chalk.yellow('⚠ Cannot detect provider. Use --github or --gitlab\n'));
          return;
        }

        const installed = listInstalledWorkflows(provider);
        if (installed.length === 0) {
          console.log(chalk.white('No workflows installed\n'));
        } else {
          console.log(chalk.bold('Installed Workflows:'));
          installed.forEach(file => {
            console.log(`  ${chalk.green('✓')} ${file}`);
          });
          console.log('');
        }
      } else {
        // Show available templates
        const templates = provider
          ? getTemplatesByProvider(provider)
          : getAllTemplates();

        if (templates.length === 0) {
          console.log(chalk.white('No templates available\n'));
          return;
        }

        // Group by provider
        const grouped = templates.reduce((acc, template) => {
          if (!acc[template.provider]) {
            acc[template.provider] = [];
          }
          acc[template.provider].push(template);
          return acc;
        }, {} as Record<VCSProvider, typeof templates>);

        for (const [prov, temps] of Object.entries(grouped)) {
          console.log(chalk.bold.cyan(`${prov.toUpperCase()} Workflows:`));
          console.log('');

          temps.forEach(template => {
            const installed = isWorkflowInstalled(template.id, template.provider);
            const status = installed ? chalk.green('✓ installed') : chalk.white('not installed');

            console.log(chalk.bold(`  ${template.name}`));
            console.log(chalk.white(`    ${template.description}`));
            console.log(`    ${chalk.bold('ID:')} ${chalk.cyan(template.id)} | Category: ${template.category} | Status: ${status}`);
            console.log('');
          });
        }

        // Show usage hint
        console.log(chalk.white('To install a workflow:'));
        console.log(chalk.white(`  codemie workflow install ${chalk.cyan('<workflow-id>')}`));
        console.log('');
        console.log(chalk.white('Example:'));
        console.log(chalk.white(`  codemie workflow install ${chalk.cyan('pr-review')}\n`));
      }
    });

  // Install command
  workflow
    .command('install <workflow-id>')
    .description('Install a workflow template')
    .option('--github', 'Force GitHub provider')
    .option('--gitlab', 'Force GitLab provider')
    .option('-i, --interactive', 'Interactive configuration with prompts and help text')
    .option('-f, --force', 'Force reinstall if already installed')
    .option('--dry-run', 'Preview installation without writing files')
    .option('--timeout <minutes>', 'Workflow timeout in minutes (default: 15)', parseInt)
    .option('--max-turns <number>', 'Maximum AI conversation turns (default: 50)', parseInt)
    .option('--environment <env>', 'GitHub environment name for protection rules')
    .addHelpText('after', `

Examples:
  $ codemie workflow install pr-review                    # Basic installation
  $ codemie workflow install pr-review -i                 # Interactive mode (recommended)
  $ codemie workflow install pr-review --force            # Reinstall existing workflow
  $ codemie workflow install pr-review --dry-run          # Preview without installing
  $ codemie workflow install pr-review --timeout 30 --max-turns 100 --environment prod

Interactive Mode (-i):
  Prompts you for each configuration option with helpful explanations.
  Recommended for first-time setup or when you're unsure about values.

Configuration Guide:
  --timeout:     How long CI can run before timing out (15-60 minutes recommended)
  --max-turns:   AI conversation depth (50 = simple tasks, 100+ = complex features)
  --environment: GitHub environment name for secrets and protection rules
`)
    .action(async (workflowId: string, options: {
      github?: boolean;
      gitlab?: boolean;
      interactive?: boolean;
      force?: boolean;
      dryRun?: boolean;
      timeout?: number;
      maxTurns?: number;
      environment?: string;
    }) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║        Install Workflow              ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      // Determine provider
      let provider: VCSProvider;
      if (options.github) {
        provider = 'github';
      } else if (options.gitlab) {
        provider = 'gitlab';
      } else {
        const detection = detectVCSProvider();
        if (!detection.provider) {
          console.log(chalk.red('✗ Could not detect VCS provider'));
          console.log(chalk.white('  Use --github or --gitlab to specify provider\n'));
          console.log(chalk.yellow('Installation cancelled\n'));
          return;
        }
        provider = detection.provider;
        console.log(chalk.white(`Auto-detected: ${provider} repository\n`));
      }

      // Get template
      const template = getTemplate(workflowId, provider);
      if (!template) {
        console.log(chalk.red(`✗ Workflow template '${workflowId}' not found for ${provider}`));
        console.log(chalk.white('\n  Available workflows:'));

        const templates = getTemplatesByProvider(provider);
        if (templates.length === 0) {
          console.log(chalk.yellow(`\n  No ${provider} workflows are currently available.`));
          console.log(chalk.white(`  GitLab workflows are coming soon!`));
          console.log(chalk.white(`  Try using GitHub workflows instead: codemie workflow list --github\n`));
        } else {
          templates.forEach(t => {
            console.log(chalk.white(`    - ${t.id}: ${t.name}`));
          });
          console.log('');
        }

        console.log(chalk.yellow('Installation cancelled\n'));
        return;
      }

      console.log(chalk.bold(template.name));
      console.log(chalk.white(template.description));
      console.log('');

      // Validate dependencies
      const validation = validateDependencies(template);

      if (validation.missing.length > 0) {
        console.log(chalk.yellow('⚠ Missing dependencies:'));
        validation.missing.forEach(dep => {
          console.log(chalk.yellow(`  - ${dep}`));
        });
        console.log('');
        console.log(chalk.yellow('Please install the required tools manually before proceeding.\n'));
        return;
      }

      // Show warnings
      if (validation.warnings.length > 0) {
        console.log(chalk.yellow('⚠ Configuration needed:'));
        validation.warnings.forEach(warning => {
          // Highlight environment variables in the warning text
          const highlightedWarning = warning.replaceAll(/[A-Z_]{3,}/, (match) => chalk.cyan(match));
          console.log('  ' + highlightedWarning);
        });
        console.log('');
      }

      // Interactive mode
      let installOptions: WorkflowInstallOptions = {
        force: options.force,
        dryRun: options.dryRun,
        provider,
      };

      if (options.interactive) {
        console.log(chalk.bold('Workflow Configuration'));
        console.log(chalk.white('Customize the workflow settings below'));
        console.log(chalk.white('Press Enter to use default values\n'));

        const questions: any[] = [
          {
            type: 'input',
            name: 'timeout',
            message: 'Workflow timeout (minutes):',
            default: String(template.config.timeout || 15),
            validate: (value: string) => {
              if (!value || value.trim() === '') return true; // Allow empty to use default
              const num = parseInt(value);
              if (isNaN(num) || num <= 0) {
                return 'Please enter a valid positive number';
              }
              return true;
            }
          },
          {
            type: 'input',
            name: 'maxTurns',
            message: 'Maximum AI turns:',
            default: String(template.config.maxTurns || 50),
            validate: (value: string) => {
              if (!value || value.trim() === '') return true; // Allow empty to use default
              const num = parseInt(value);
              if (isNaN(num) || num <= 0) {
                return 'Please enter a valid positive number';
              }
              return true;
            }
          }
        ];

        if (provider === 'github') {
          questions.push({
            type: 'input',
            name: 'environment',
            message: 'GitHub environment (optional):',
            default: template.config.environment || ''
          });
        }

        const answers = await inquirer.prompt(questions);

        if (answers.timeout && answers.timeout.trim() !== '') {
          installOptions.timeout = parseInt(answers.timeout);
        }

        if (answers.maxTurns && answers.maxTurns.trim() !== '') {
          installOptions.maxTurns = parseInt(answers.maxTurns);
        }

        if (provider === 'github' && answers.environment && answers.environment.trim() !== '') {
          installOptions.environment = answers.environment;
        }

        console.log('');
        console.log(chalk.white('Configuration notes:'));
        console.log(chalk.white('  • Timeout: How long the workflow can run (15-60 minutes recommended)'));
        console.log(chalk.white('  • Max turns: AI conversation depth (50 = simple, 100+ = complex tasks)'));
        if (provider === 'github') {
          console.log(chalk.white('  • Environment: GitHub deployment environment for protection rules\n'));
        } else {
          console.log('');
        }
      } else {
        // Use CLI options
        if (options.timeout) installOptions.timeout = options.timeout;
        if (options.maxTurns) installOptions.maxTurns = options.maxTurns;
        if (options.environment) installOptions.environment = options.environment;
      }

      // Install workflow
      const spinner = ora('Installing workflow...').start();
      try {
        const result = await installWorkflow(workflowId, provider, installOptions);

        if (result.action === 'skipped') {
          spinner.warn(chalk.yellow('Installation skipped'));
          console.log('');
          console.log(chalk.white('Workflow is already installed at:'), result.path);
          console.log('');
          console.log(chalk.white('Use --force to reinstall\n'));
          return;
        }

        spinner.succeed(chalk.green('Workflow installed'));

        console.log('');
        console.log(chalk.bold('Installed to:'), result.path);
        console.log('');

        if (!options.dryRun) {
          console.log(chalk.green('✅ Workflow installation complete'));
          console.log('');
          console.log(chalk.bold('Next steps:'));
          console.log(chalk.white('  1. Configure required secrets in your repository settings'));
          console.log(chalk.white('  2. Commit and push the workflow file'));
          console.log(chalk.white('  3. The workflow will run automatically based on configured triggers\n'));
        }
      } catch (error) {
        spinner.fail(chalk.red('Installation failed'));
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
    });

  // Uninstall command
  workflow
    .command('uninstall <workflow-id>')
    .description('Uninstall a workflow')
    .option('--github', 'Force GitHub provider')
    .option('--gitlab', 'Force GitLab provider')
    .addHelpText('after', `

Examples:
  $ codemie workflow uninstall pr-review     # Remove PR review workflow
  $ codemie workflow uninstall pr-review --github

Note: This removes the workflow file but doesn't delete workflow runs or history.
`)
    .action(async (workflowId: string, options: { github?: boolean; gitlab?: boolean }) => {
      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║       Uninstall Workflow             ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

      // Determine provider
      let provider: VCSProvider;
      if (options.github) {
        provider = 'github';
      } else if (options.gitlab) {
        provider = 'gitlab';
      } else {
        const detection = detectVCSProvider();
        if (!detection.provider) {
          console.log(chalk.red('✗ Could not detect VCS provider'));
          console.log(chalk.white('  Use --github or --gitlab to specify provider\n'));
          console.log(chalk.yellow('Uninstall cancelled\n'));
          return;
        }
        provider = detection.provider;
      }

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to uninstall ${workflowId}?`,
          default: false
        }
      ]);

      if (!confirm) {
        console.log(chalk.yellow('\nUninstall cancelled\n'));
        return;
      }

      const spinner = ora('Uninstalling workflow...').start();
      try {
        await uninstallWorkflow(workflowId, provider);
        spinner.succeed(chalk.green(`Workflow ${workflowId} uninstalled successfully`));
        console.log('');
      } catch (error) {
        spinner.fail(chalk.red('Uninstall failed'));
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
    });

  return workflow;
}
