/**
 * Python version health check
 */

import { exec } from '../../../../utils/processes.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';
import os from 'os';

export class PythonCheck implements HealthCheck {
  name = 'Python';

  /**
   * Try to execute Python version command with multiple fallback options
   * @param commands - Array of command configurations to try: [{ command, args, options }]
   * @returns ExecResult if successful, null if all commands fail
   */
  private async tryPythonCommands(
    commands: Array<{ command: string; args: string[]; options?: { shell?: boolean } }>
  ): Promise<{ code: number; stdout: string; stderr: string } | null> {
    for (const { command, args, options } of commands) {
      try {
        const result = await exec(command, args, options);
        if (result.code === 0) {
          return result;
        }
      } catch {
        // Command doesn't exist or can't be executed, try next one
        continue;
      }
    }
    return null;
  }

  /**
   * Process Python version string and add appropriate detail to the details array
   * @param version - Version string from Python --version command
   * @param details - Array to add the version detail to
   * @param suffix - Optional suffix to add to the version message (e.g., "(virtual environment)")
   */
  private processVersion(version: string, details: HealthCheckDetail[], suffix: string = ''): void {
    const versionMatch = version.match(/Python (\d+\.\d+\.\d+)/);
    const suffixText = suffix ? ` ${suffix}` : '';

    if (versionMatch) {
      const [major, minor] = versionMatch[1].split('.').map(Number);

      if (major >= 3 && minor >= 8) {
        details.push({
          status: 'ok',
          message: `Version ${versionMatch[1]}${suffixText}`
        });
      } else {
        details.push({
          status: 'warn',
          message: `Version ${versionMatch[1]}${suffixText}`,
          hint: 'Recommended: Python >= 3.8'
        });
      }
    } else {
      details.push({
        status: 'ok',
        message: `${version}${suffixText}`
      });
    }
  }

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      const isWindows = os.platform() === 'win32';
      const virtualEnv = process.env.VIRTUAL_ENV;
      let result: { code: number; stdout: string; stderr: string } | null = null;
      
      // Check if we're in a virtual environment and use its Python directly
      if (virtualEnv) {
        const pythonPath = isWindows 
          ? `${virtualEnv}\\Scripts\\python.exe`
          : `${virtualEnv}/bin/python`;
        
        result = await this.tryPythonCommands([
          { command: pythonPath, args: ['--version'], options: { shell: isWindows } }
        ]);
        
        if (result) {
          // Successfully found Python in venv
          const version = result.stdout.trim() || result.stderr.trim();
          this.processVersion(version, details, '(virtual environment)');
          return { name: this.name, success, details };
        }
      }
      
      // Try system Python (use shell mode on Windows to properly resolve PATH, including venv paths)
      if (isWindows) {
        // On Windows, use shell mode to ensure PATH (including venv) is properly resolved
        // Prefer 'python' over 'python3' since python3 often redirects to Windows Store
        result = await this.tryPythonCommands([
          { command: 'python', args: ['--version'], options: { shell: true } },
          { command: 'python3', args: ['--version'], options: { shell: true } }
        ]);
      } else {
        // On Unix-like systems, try python3 first (preferred)
        result = await this.tryPythonCommands([
          { command: 'python3', args: ['--version'] },
          { command: 'python', args: ['--version'] }
        ]);
      }

      if (!result) {
        throw new Error('Python not found');
      }

      const version = result.stdout.trim() || result.stderr.trim();

      // Check for Windows Store redirect message (shouldn't happen with exit code 0, but double-check)
      if (version.includes('Microsoft Store') || version.includes('app execution aliases')) {
        details.push({
          status: 'warn',
          message: 'Python redirects to Microsoft Store (not properly installed)',
          hint: 'Install Python from https://python.org and disable Windows Store app alias in Settings > Apps > Advanced app settings > App execution aliases'
        });
        // Not critical, so don't mark as failure
        return { name: this.name, success, details };
      }

      this.processVersion(version, details);
    } catch {
      details.push({
        status: 'warn',
        message: 'Python not found',
        hint: 'Install Python from https://python.org (required for some agents)'
      });
      // Not critical, so don't mark as failure
    }

    return { name: this.name, success, details };
  }
}
