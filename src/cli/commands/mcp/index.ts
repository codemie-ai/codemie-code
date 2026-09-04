import { Command } from 'commander';
import os from 'os';
import { exec } from '../../../utils/exec.js';
import { getCommandPath } from '../../../utils/processes.js';
import { resolveHomeDir } from '../../../utils/paths.js';

async function ensureProxyCommandExists(): Promise<void> {
  const proxyCommand = await getCommandPath('codemie-mcp-proxy');
  if (!proxyCommand) {
    throw new Error('proxy-not-found');
  }
}

async function resolveClaudeCommand(): Promise<{ command: string; shell: boolean }> {
  if (process.platform !== 'win32') {
    const fullPath = resolveHomeDir('.local/bin/claude');
    try {
      const result = await exec(fullPath, ['--version']);
      if (result.code === 0) {
        return { command: fullPath, shell: false };
      }
    } catch {
      // Fall back to PATH lookup below.
    }
  }

  const claudeCommand = await getCommandPath('claude');
  if (!claudeCommand) {
    throw new Error('claude-not-found');
  }

  return {
    command: claudeCommand,
    shell: os.platform() === 'win32',
  };
}

async function runClaudeMcpCommand(claudeCommand: string, useShell: boolean, args: string[]): Promise<never> {
  try {
    const result = await exec(claudeCommand, args, {
      interactive: true,
      shell: useShell,
    });
    process.exit(result.code);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
      process.exit(1);
    }

    if (message.includes('terminated by signal')) {
      process.exit(1);
    }

    // exec rejects on non-zero exit in interactive mode — extract and propagate the code
    const match = /code (\d+)/.exec(message);
    process.exit(match ? parseInt(match[1], 10) : 1);
  }
}

function createMcpAddCommand(): Command {
  const command = new Command('add');

  command
    .description('Register an MCP server via codemie-mcp-proxy')
    .argument('<name>', 'Name for the MCP server')
    .argument('<url>', 'MCP server URL')
    .option('--scope <scope>', 'Scope for the MCP server (e.g. project, user)')
    .action(async (name: string, url: string, options: { scope?: string }) => {
      // Validate URL early, before spawning claude
      try {
        new URL(url);
      } catch {
        console.error(`Invalid MCP server URL: ${url}`);
        process.exit(1);
      }

      // Reject names that look like flags to avoid corrupting the claude command
      if (name.startsWith('-')) {
        console.error(`Invalid server name: ${name}`);
        process.exit(1);
      }

      let claudeCommand: string;
      let useShell: boolean;
      try {
        await ensureProxyCommandExists();
        ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'proxy-not-found') {
          console.error('codemie-mcp-proxy not found. Reinstall @codemieai/code to restore the MCP proxy binary.');
          process.exit(1);
        }

        console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
        process.exit(1);
      }

      const args: string[] = ['mcp', 'add'];

      if (options.scope) {
        args.push('--scope', options.scope);
      }

      args.push(name, '--', 'codemie-mcp-proxy', url);

      await runClaudeMcpCommand(claudeCommand, useShell, args);
    });

  return command;
}

function createMcpRemoveCommand(): Command {
  const command = new Command('remove');

  command
    .description('Remove a registered MCP server')
    .argument('<name>', 'Name of the MCP server to remove')
    .option('--scope <scope>', 'Scope for the MCP server (e.g. project, user)')
    .action(async (name: string, options: { scope?: string }) => {
      // Reject names that look like flags to avoid corrupting the claude command
      if (name.startsWith('-')) {
        console.error(`Invalid server name: ${name}`);
        process.exit(1);
      }

      let claudeCommand: string;
      let useShell: boolean;
      try {
        ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
      } catch {
        console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
        process.exit(1);
      }

      const args: string[] = ['mcp', 'remove'];

      if (options.scope) {
        args.push('--scope', options.scope);
      }

      args.push(name);

      await runClaudeMcpCommand(claudeCommand, useShell, args);
    });

  return command;
}

function createMcpListCommand(): Command {
  const command = new Command('list');

  command.description('List registered MCP servers').action(async () => {
    let claudeCommand: string;
    let useShell: boolean;
    try {
      ({ command: claudeCommand, shell: useShell } = await resolveClaudeCommand());
    } catch {
      console.error('claude CLI not found. Install Claude Code: https://claude.ai/code');
      process.exit(1);
    }

    await runClaudeMcpCommand(claudeCommand, useShell, ['mcp', 'list']);
  });

  return command;
}

export function createMcpCommand(): Command {
  const mcp = new Command('mcp').description('Manage MCP servers');
  mcp.addCommand(createMcpAddCommand());
  mcp.addCommand(createMcpRemoveCommand());
  mcp.addCommand(createMcpListCommand());
  return mcp;
}
