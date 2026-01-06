/**
 * CLI Runner - Helper utility for executing CLI commands in tests
 *
 * Provides a simple interface for running codemie commands and capturing output
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { join } from 'path';

export interface CommandResult {
  output: string;
  exitCode: number;
  error?: string;
}

export class CLIRunner {
  private readonly binPath: string;

  constructor(binPath: string = './bin/codemie.js') {
    this.binPath = binPath;
  }

  /**
   * Run a CLI command and return output
   * Throws if command fails
   */
  run(command: string, options?: ExecSyncOptions): string {
    try {
      return execSync(`node ${this.binPath} ${command}`, {
        encoding: 'utf-8',
        ...options,
      });
    } catch (error: any) {
      const errorMessage = error.stderr?.toString() || error.message;
      throw new Error(`Command failed: ${command}\n${errorMessage}`);
    }
  }

  /**
   * Run a CLI command silently and capture result with exit code
   * Does not throw on failure
   */
  runSilent(command: string, options?: ExecSyncOptions): CommandResult {
    try {
      const output = execSync(`node ${this.binPath} ${command}`, {
        encoding: 'utf-8',
        ...options,
      });
      return { output, exitCode: 0 };
    } catch (error: any) {
      const output = error.stdout?.toString() || '';
      const errorOutput = error.stderr?.toString() || error.message;
      return {
        output,
        exitCode: error.status || 1,
        error: errorOutput,
      };
    }
  }

  /**
   * Run an agent shortcut command (codemie-code, codemie-claude, etc.)
   */
  runAgent(agentName: string, args: string, options?: ExecSyncOptions): string {
    const agentBin = join('./bin/agent-executor.js');
    try {
      return execSync(`node ${agentBin} ${args}`, {
        encoding: 'utf-8',
        env: {
          ...process.env,
          // Set the executable name to simulate agent shortcut
          _: `codemie-${agentName}`,
        },
        ...options,
      });
    } catch (error: any) {
      const errorMessage = error.stderr?.toString() || error.message;
      throw new Error(`Agent command failed: codemie-${agentName} ${args}\n${errorMessage}`);
    }
  }

  /**
   * Check if a command succeeds (returns exit code 0)
   */
  succeeds(command: string, options?: ExecSyncOptions): boolean {
    const result = this.runSilent(command, options);
    return result.exitCode === 0;
  }

  /**
   * Check if a command fails (returns non-zero exit code)
   */
  fails(command: string, options?: ExecSyncOptions): boolean {
    return !this.succeeds(command, options);
  }
}

/**
 * Create a CLI runner for the main codemie command
 */
export function createCLIRunner(): CLIRunner {
  return new CLIRunner('./bin/codemie.js');
}

/**
 * Create a CLI runner for a specific agent shortcut
 */
export function createAgentRunner(_agentName: string): CLIRunner {
  return new CLIRunner(`./bin/agent-executor.js`);
}
