import { spawn } from 'child_process';
import os from 'os';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  shell?: boolean; // Allow override for specific cases
  interactive?: boolean; // Allow interactive mode (stdio: 'inherit')
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

    // Interactive mode: inherit stdio for user prompts
    const stdio = options.interactive ? 'inherit' : 'pipe';

    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      shell: useShell,
      windowsHide: true, // Hide console window on Windows
      stdio
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
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      cleanup();

      const result = {
        code: code || 0,
        stdout: stdout.trim(),
        stderr: stderr.trim()
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
        child.kill();
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}
