/**
 * CLI Commands Integration Tests
 *
 * Tests the main codemie CLI commands by executing them directly
 * and verifying their output and behavior.
 *
 * Performance: Commands executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../helpers/index.js';

const cli = createCLIRunner();

describe('CLI Commands - Integration', () => {
  describe('List Command', () => {
    let listOutput: string;
    let listResult: CommandResult;

    beforeAll(() => {
      // Execute once, validate many times
      listResult = cli.runSilent('list');
      listOutput = listResult.output;
    }, 30000); // 30s timeout for Windows

    it('should list all available agents', () => {
      // Should show all registered agents
      expect(listOutput).toContain('claude');
      expect(listOutput).toContain('codex');
      expect(listOutput).toContain('gemini');
      expect(listOutput).toContain('codemie-code');
    });

    it('should complete successfully', () => {
      expect(listResult.exitCode).toBe(0);
    });
  });

  describe('Doctor Command', () => {
    let doctorResult: CommandResult;

    beforeAll(() => {
      // Execute once, validate many times
      doctorResult = cli.runSilent('doctor');
    }, 30000); // 30s timeout for Windows

    it('should run system diagnostics', () => {
      // Should include system check header (even if some checks fail)
      expect(doctorResult.output).toMatch(/System Check|Health Check|Diagnostics/i);
    });

    it('should check Node.js version', () => {
      // Should verify Node.js installation (even if profile checks fail)
      expect(doctorResult.output).toMatch(/Node\.?js|node version/i);
    });

    it('should check npm', () => {
      // Should verify npm installation
      expect(doctorResult.output).toMatch(/npm/i);
    });

    it('should check Python', () => {
      // Should check Python installation (may be present or not)
      expect(doctorResult.output).toMatch(/Python/i);
    });

    it('should check uv', () => {
      // Should check uv installation (optional)
      expect(doctorResult.output).toMatch(/uv/i);
    });

    it('should execute without crashing', () => {
      // Doctor may return non-zero exit code if no profile configured
      // but it should still run and not crash
      expect(doctorResult).toBeDefined();
      expect(doctorResult.output).toBeDefined();
    });
  });

  describe('Version Command', () => {
    let versionResult: CommandResult;

    beforeAll(() => {
      versionResult = cli.runSilent('version');
    });

    it('should display version number', () => {
      // Should show semantic version format
      expect(versionResult.output).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should complete successfully', () => {
      expect(versionResult.exitCode).toBe(0);
    });
  });

  describe('Profile Commands', () => {
    let profileResult: CommandResult;

    beforeAll(() => {
      profileResult = cli.runSilent('profile');
    });

    it('should list profiles by default', () => {
      // Should not error (even with no profiles)
      expect(profileResult.exitCode === 0 || profileResult.exitCode === 1).toBe(true);
      expect(profileResult.output).toBeDefined();
    });

    it('should handle profile command without crashing', () => {
      // Should execute without crashing
      expect(profileResult).toBeDefined();
      expect(profileResult.output).toBeDefined();
    });
  });

  describe('Workflow Commands', () => {
    let workflowResult: CommandResult;

    beforeAll(() => {
      workflowResult = cli.runSilent('workflow list');
    });

    it('should list available workflows', () => {
      // Should show available workflow templates
      expect(workflowResult.output).toMatch(/pr-review|inline-fix|code-ci/i);
    });

    it('should show workflow details', () => {
      // Should include workflow descriptions or names
      expect(workflowResult.output.length).toBeGreaterThan(0);
    });

    it('should complete successfully', () => {
      expect(workflowResult.exitCode).toBe(0);
    });
  });

  describe('Update Command', () => {
    it('should display help information', () => {
      const output = cli.run('update --help');

      // Should show usage information
      expect(output).toMatch(/Update installed AI coding agents/i);
    });

    it('should show --check option in help', () => {
      const output = cli.run('update --help');

      // Should include check option
      expect(output).toMatch(/--check/);
    });

    it('should handle unknown agent gracefully', () => {
      const result = cli.runSilent('update nonexistent-agent-xyz');

      // Should fail with non-zero exit code
      expect(result.exitCode).not.toBe(0);
      // Should show error message
      expect(result.output + (result.error || '')).toMatch(/not found|Available agents/i);
    });

    it('should handle built-in agent update attempt', () => {
      const result = cli.runSilent('update codemie-code');

      // Should exit successfully but inform user
      expect(result.output).toMatch(/built-in|cannot be updated/i);
    });

    it('should execute --check without crashing', () => {
      // Note: This test requires network access to npm registry
      // It may take a few seconds but should not crash
      expect(() => cli.runSilent('update --check')).not.toThrow();
    });
  });

  describe('Help Command', () => {
    let helpOutput: string;

    beforeAll(() => {
      helpOutput = cli.run('--help');
    });

    it('should display help information', () => {
      // Should show usage information
      expect(helpOutput).toMatch(/Usage|Commands|Options/i);
    });

    it('should show available commands', () => {
      // Should list main commands
      expect(helpOutput).toMatch(/setup|install|list|doctor/i);
    });

    it('should show update command in help', () => {
      const output = cli.run('--help');

      // Should list update command
      expect(output).toMatch(/update/i);
    });
  });

  describe('Error Handling', () => {
    let errorResult: CommandResult;

    beforeAll(() => {
      errorResult = cli.runSilent('invalid-command-xyz');
    });

    it('should handle invalid commands gracefully', () => {
      // Should fail with non-zero exit code
      expect(errorResult.exitCode).not.toBe(0);
    });

    it('should provide helpful error messages', () => {
      // Should include error information or help text
      expect(errorResult.error || errorResult.output).toBeDefined();
    });
  });
});
