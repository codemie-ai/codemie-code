import { spawn } from 'child_process';
import os from 'os';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  shell?: boolean; // Allow override for specific cases
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute command with cross-platform support
 *
 * On Windows, uses shell: true to properly resolve .cmd/.bat/.exe executables
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
    // On Windows, we need shell: true to resolve .cmd/.bat/.exe
    // On Unix, shell: false is safer and sufficient
    const isWindows = os.platform() === 'win32';
    const useShell = options.shell !== undefined ? options.shell : isWindows;

    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      shell: useShell,
      windowsHide: true // Hide console window on Windows
    });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    // Cleanup function to clear timeout and prevent memory leaks
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      resolve({
        code: code || 0,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    // Handle timeout
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}
