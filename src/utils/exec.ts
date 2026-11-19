/**
 * Base Command Execution Utility
 *
 * Foundational cross-platform command execution that other process utilities build upon.
 * Separated from higher-level utilities to enable proper testing and mocking.
 */

import { spawn, type ChildProcess } from 'child_process';
import os from 'os';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Keys removed from the merged environment; `env` can only add keys, so this is how a child is kept from inheriting one. */
  unsetEnv?: string[];
  timeout?: number;
  shell?: boolean; // Allow override for specific cases
  interactive?: boolean; // Allow interactive mode (stdio: 'inherit')
  /**
   * Give the child an immediately-closed stdin (EOF) instead of an open pipe.
   * Ignored when `interactive` is set.
   */
  closeStdin?: boolean;
  /**
   * After SIGTERM on timeout, wait this long and then SIGKILL the child.
   * Only applies together with `timeout`; a no-op without it.
   */
  killGraceMs?: number;
}

/**
 * Options for agent `--version` probes: bounded, EOF on stdin, escalating kill.
 * New agent version probes should use this.
 */
export const VERSION_PROBE_OPTIONS: ExecOptions = { timeout: 5000, closeStdin: true, killGraceMs: 500 };

/** Stop a timed-out child and release its pipes so it cannot keep the process alive. */
function terminate(child: ChildProcess, killGraceMs: number | undefined, onGraceTimer: (t: NodeJS.Timeout) => void, isClosed: () => boolean): void {
  const release = (): void => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  };
  child.kill('SIGTERM');
  release();
  if (killGraceMs) {
    onGraceTimer(setTimeout(() => {
      if (isClosed()) return;
      child.kill('SIGKILL');
      release();
    }, killGraceMs));
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

/**
 * Execute command with cross-platform support
 *
 * On Windows, resolves full path to avoid shell: true deprecation (DEP0190)
 * On Unix, uses shell: false for better security
 *
 * @param command - Command to execute (e.g., 'npm', 'python', 'which')
 * @param args - Command arguments
 * @param options - Execution options
 */
export async function exec(
  command: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const isWindows = os.platform() === 'win32';

    // Determine if we should use shell
    // - If explicitly set in options, respect it
    // - Otherwise, avoid shell for security (resolve path on Windows instead)
    let useShell = false;
    if (options.shell !== undefined) {
      useShell = options.shell;
    }

    // Interactive mode: inherit stdio for user prompts
    const stdio: 'inherit' | 'pipe' | ['ignore', 'pipe', 'pipe'] = options.interactive
      ? 'inherit'
      : options.closeStdin ? ['ignore', 'pipe', 'pipe'] : 'pipe';

    // When using shell: true, merge args into command string to avoid DEP0190
    // Node.js deprecation warning: shell mode doesn't escape array arguments, only concatenates them
    let finalCommand = command;
    let finalArgs = args;

    if (useShell && args.length > 0) {
      // Quote arguments that contain spaces or shell-special characters.
      // On Windows CMD, & | < > ^ % are metacharacters and must be quoted.
      const needsQuoting = (arg: string) =>
        arg.includes(' ') || arg.includes('"') ||
        (isWindows && /[&|<>^%()[\]{}]/.test(arg));
      const quotedArgs = args.map(arg =>
        needsQuoting(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
      );
      finalCommand = `${command} ${quotedArgs.join(' ')}`;
      finalArgs = [];
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const key of options.unsetEnv ?? []) delete childEnv[key];

    const child = spawn(finalCommand, finalArgs, {
      cwd: options.cwd || process.cwd(),
      env: childEnv,
      shell: useShell,
      windowsHide: isWindows, // Hide console window on Windows
      stdio
    });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;
    let graceId: NodeJS.Timeout | null = null;
    let settled = false;
    let closed = false;

    // Cleanup function to clear timers and prevent memory leaks
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (graceId) {
        clearTimeout(graceId);
        graceId = null;
      }
    };

    // Only capture output if not in interactive mode
    if (!options.interactive) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      closed = true;
      cleanup();
      if (settled) return;
      settled = true;

      if (code === null) {
        reject(new Error(`Command terminated by signal ${signal ?? 'unknown'}`));
        return;
      }

      const result = {
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        signal,
      };

      // In interactive mode, reject on non-zero exit codes
      // In non-interactive mode, always resolve (caller checks exit code)
      if (options.interactive && code !== 0) {
        reject(new Error(`Command exited with code ${code}`));
      } else {
        resolve(result);
      }
    });

    // Handle timeout
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (settled) return;
        settled = true;
        if (isWindows && useShell && child.pid !== undefined) {
          // child.kill() only ends the cmd.exe wrapper on Windows; kill the whole tree
          try {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true
            });
            killer.on?.('error', () => child.kill());
          } catch {
            child.kill();
          }
        } else if (options.killGraceMs) {
          terminate(child, options.killGraceMs, (t) => { graceId = t; }, () => closed);
        } else {
          child.kill();
        }
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}
