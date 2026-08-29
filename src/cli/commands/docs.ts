import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import { FrameworkRegistry } from '../../frameworks/core/registry.js';
import type { FrameworkAdapter } from '../../frameworks/core/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { getErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Documentation & knowledge tools command group.
 *
 * Docs tools (codegraph, graphify, codebase-memory) are framework adapters
 * tagged group: 'documentation' — they are deterministic local tooling, not
 * agent harnesses. OpenWiki is the exception: it is model-backed and managed
 * as an agent (`codemie install openwiki`, `codemie-openwiki`), so here it is
 * listed as a pointer only.
 */
export function createDocsCommand(): Command {
  const docs = new Command('docs');
  docs.description('Manage documentation & knowledge tools (install and initialize per project)');

  const listAction = async (): Promise<void> => {
    const tools = FrameworkRegistry.getFrameworksByGroup('documentation');

    console.log();
    console.log(chalk.bold('📚 Documentation & Knowledge Tools:\n'));

    for (const tool of tools) {
      await printToolStatus(tool);
    }

    await printOpenwikiStatus();
  };

  docs
    .command('list')
    .description('List available documentation tools and their status')
    .action(listAction);

  docs
    .command('install <name>')
    .description('Install a documentation tool (see: codemie docs list)')
    .action(async (name: string) => {
      const tool = resolveDocsTool(name);
      if (!tool) {
        process.exitCode = 1;
        return;
      }

      try {
        await tool.install();
      } catch (error) {
        logger.error(getErrorMessage(error));
        process.exitCode = 1;
      }
    });

  docs
    .command('uninstall <name>')
    .description('Uninstall a documentation tool')
    .action(async (name: string) => {
      const tool = resolveDocsTool(name);
      if (!tool) {
        process.exitCode = 1;
        return;
      }

      try {
        await tool.uninstall();
      } catch (error) {
        logger.error(getErrorMessage(error));
        process.exitCode = 1;
      }
    });

  docs
    .command('init <name>')
    .description('Initialize a documentation tool in the current project')
    .option('--cwd <path>', 'Project directory (default: current directory)')
    .action(async (name: string, options: { cwd?: string }) => {
      const tool = resolveDocsTool(name);
      if (!tool) {
        process.exitCode = 1;
        return;
      }

      try {
        // FrameworkAdapter.init is agent-centric; docs tools are agent-agnostic
        // except agent-specific ones (e.g. graphify ships a Claude Code skill),
        // which declare their target in supportedAgents.
        const agentName = tool.metadata.supportedAgents?.[0] ?? 'docs';
        await tool.init(agentName, { cwd: options.cwd });
      } catch (error) {
        logger.error(getErrorMessage(error));
        process.exitCode = 1;
      }
    });

  // Bare `codemie docs` behaves like `codemie docs list`
  docs.action(listAction);

  return docs;
}

async function printToolStatus(tool: FrameworkAdapter): Promise<void> {
  const installed = await tool.isInstalled();
  const status = installed ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
  const version = installed ? await tool.getVersion() : null;
  const versionStr = version ? chalk.white(` (${version})`) : '';
  const initialized = await tool.isInitialized();
  const initStr = initialized ? chalk.green('✓ initialized in this project') : chalk.gray('○ not initialized here');

  console.log(chalk.bold(`  ${tool.metadata.displayName}`) + versionStr);
  console.log(`    Install: ${chalk.cyan(`codemie docs install ${tool.metadata.name}`)} — ${status}`);
  console.log(`    Init:    ${chalk.cyan(`codemie docs init ${tool.metadata.name}`)} — ${initStr}`);
  console.log(`    ${chalk.white(tool.metadata.description)}`);
  if (tool.metadata.docsUrl) {
    console.log(chalk.gray(`    Docs: ${tool.metadata.docsUrl}`));
  }
  console.log();
}

async function printOpenwikiStatus(): Promise<void> {
  const agent = AgentRegistry.getAgent('openwiki');
  const installed = agent ? await agent.isInstalled() : false;
  const status = installed ? chalk.green('✓ installed') : chalk.yellow('○ not installed');
  const version = installed && agent ? await agent.getVersion() : null;
  const versionStr = version ? chalk.white(` (${version})`) : '';
  const initialized = existsSync(join(process.cwd(), 'openwiki'));
  const initStr = initialized ? chalk.green('✓ initialized in this project') : chalk.gray('○ not initialized here');

  console.log(chalk.bold('  OpenWiki') + versionStr + chalk.gray(' (agent-managed, uses your CodeMie profile)'));
  console.log(`    Install: ${chalk.cyan('codemie install openwiki')} — ${status}`);
  console.log(`    Init:    ${chalk.cyan('codemie-openwiki --init')} — ${initStr}`);
  console.log(`    ${chalk.white('Agent-written, self-updating wiki for your codebase')}`);
  console.log();
}

function resolveDocsTool(name: string): FrameworkAdapter | undefined {
  if (name === 'openwiki') {
    console.log(chalk.yellow('OpenWiki is managed as an agent, not a docs tool:'));
    console.log(`  Install: ${chalk.cyan('codemie install openwiki')}`);
    console.log(`  Init:    ${chalk.cyan('codemie-openwiki --init')}`);
    return undefined;
  }

  const tool = FrameworkRegistry.getFramework(name);
  if (!tool || (tool.metadata.group ?? 'framework') !== 'documentation') {
    const available = FrameworkRegistry.getFrameworksByGroup('documentation')
      .map((t) => t.metadata.name)
      .join(', ');
    console.error(chalk.red(`✗ Unknown documentation tool '${name}'. Available: ${available}, openwiki`));
    return undefined;
  }

  return tool;
}
