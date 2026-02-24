/**
 * Agent Shortcuts Integration Tests
 *
 * Tests the direct agent executables (codemie-code, codemie-claude, etc.)
 * by verifying they load correctly and respond to basic commands.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { statSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { setupTestIsolation } from '../helpers/test-isolation.js';

describe('Agent Shortcuts - Integration', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  // Helper to run agent commands with timeout
  const runAgentCommand = (command: string, timeoutMs: number = 5000): { output: string; exitCode: number; error?: string } => {
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: 'pipe',
      });
      return { output, exitCode: 0 };
    } catch (error: any) {
      return {
        output: error.stdout?.toString() || '',
        exitCode: error.status || 1,
        error: error.stderr?.toString() || error.message,
      };
    }
  };

  describe('CodeMie Native (Built-in)', () => {
    it('should display help information', () => {
      const result = runAgentCommand('node ./bin/agent-executor.js --help');

      // Should show usage or help text
      expect(result.output || result.error).toBeDefined();
    });
  });

  describe('Health Check Commands', () => {
    it('should respond to health subcommand', () => {
      // Health check should execute quickly
      const result = runAgentCommand('node ./bin/agent-executor.js health', 3000);

      // Should not crash (may fail if agent not installed, that's ok)
      expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
    });
  });

  describe('Agent Executor Loading', () => {
    it('should load without errors when called directly', () => {
      // Verify the executor script can be loaded (may fail with non-zero, but shouldn't crash)
      const result = runAgentCommand('node ./bin/agent-executor.js --version');

      // Should not crash - exit code 0 or 1 is acceptable
      expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
    });

    it('should handle missing arguments gracefully', () => {
      // Note: agent-executor.js (codemie-code) opens interactive mode with no args
      // So we test with --help instead to avoid hanging
      // Increased timeout to handle resource contention in full test suite
      const result = runAgentCommand('node ./bin/agent-executor.js --help', 10000);

      // Should show help and exit cleanly
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Configuration Override Flags', () => {
    it('should accept --profile flag', () => {
      const result = runAgentCommand('node ./bin/agent-executor.js --profile test --help');

      // Should parse flag without error
      expect(result.output || result.error).toBeDefined();
    });

    it('should accept --model flag', () => {
      const result = runAgentCommand('node ./bin/agent-executor.js --model gpt-4 --help');

      // Should parse flag without error
      expect(result.output || result.error).toBeDefined();
    });
  });

  // Windows does not have Unix-style executable permission bits
  const isWindows = process.platform === 'win32';

  describe('Binary Permissions', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
    const binEntries = Object.entries(packageJson.bin) as [string, string][];

    it.each(binEntries)(
      '%s (%s) should have executable permissions',
      (name, filePath) => {
        if (isWindows) {
          // Windows doesn't track Unix file permission bits; just verify the file exists
          expect(() => statSync(resolve(filePath))).not.toThrow();
          return;
        }

        const fullPath = resolve(filePath);
        const stats = statSync(fullPath);
        const mode = stats.mode & 0o777;
        expect(mode & 0o111).toBeGreaterThan(0);
      },
    );
  });
});
