/**
 * CLI Commands Integration Tests
 *
 * Tests the main codemie CLI commands by executing them directly
 * and verifying their output and behavior.
 */

import { describe, it, expect } from 'vitest';
import { createCLIRunner } from '../helpers/index.js';

const cli = createCLIRunner();

describe('CLI Commands - Integration', () => {
  describe('List Command', () => {
    it('should list all available agents', () => {
      const output = cli.run('list');

      // Should show all registered agents
      expect(output).toContain('claude');
      expect(output).toContain('codex');
      expect(output).toContain('gemini');
      expect(output).toContain('codemie-code');
    });

    it('should complete successfully', () => {
      expect(cli.succeeds('list')).toBe(true);
    });
  });

  describe('Doctor Command', () => {
    it('should run system diagnostics', () => {
      const result = cli.runSilent('doctor');

      // Should include system check header (even if some checks fail)
      expect(result.output).toMatch(/System Check|Health Check|Diagnostics/i);
    });

    it('should check Node.js version', () => {
      const result = cli.runSilent('doctor');

      // Should verify Node.js installation (even if profile checks fail)
      expect(result.output).toMatch(/Node\.?js|node version/i);
    });

    it('should check npm', () => {
      const result = cli.runSilent('doctor');

      // Should verify npm installation
      expect(result.output).toMatch(/npm/i);
    });

    it('should check Python', () => {
      const result = cli.runSilent('doctor');

      // Should check Python installation (may be present or not)
      expect(result.output).toMatch(/Python/i);
    });

    it('should check uv', () => {
      const result = cli.runSilent('doctor');

      // Should check uv installation (optional)
      expect(result.output).toMatch(/uv/i);
    });

    it('should execute without crashing', () => {
      // Doctor may return non-zero exit code if no profile configured
      // but it should still run and not crash
      expect(() => cli.runSilent('doctor')).not.toThrow();
    });
  });

  describe('Version Command', () => {
    it('should display version number', () => {
      const output = cli.run('version');

      // Should show semantic version format
      expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should complete successfully', () => {
      expect(cli.succeeds('version')).toBe(true);
    });
  });

  describe('Profile Commands', () => {
    it('should list profiles', () => {
      const result = cli.runSilent('profile list');

      // Should not error (even with no profiles)
      expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
      expect(result.output).toBeDefined();
    });

    it('should handle list command', () => {
      // Should execute without crashing
      expect(() => cli.runSilent('profile list')).not.toThrow();
    });
  });

  describe('Workflow Commands', () => {
    it('should list available workflows', () => {
      const output = cli.run('workflow list');

      // Should show available workflow templates
      expect(output).toMatch(/pr-review|inline-fix|code-ci/i);
    });

    it('should show workflow details', () => {
      const output = cli.run('workflow list');

      // Should include workflow descriptions or names
      expect(output.length).toBeGreaterThan(0);
    });

    it('should complete successfully', () => {
      expect(cli.succeeds('workflow list')).toBe(true);
    });
  });

  describe('Help Command', () => {
    it('should display help information', () => {
      const output = cli.run('--help');

      // Should show usage information
      expect(output).toMatch(/Usage|Commands|Options/i);
    });

    it('should show available commands', () => {
      const output = cli.run('--help');

      // Should list main commands
      expect(output).toMatch(/setup|install|list|doctor/i);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid commands gracefully', () => {
      const result = cli.runSilent('invalid-command-xyz');

      // Should fail with non-zero exit code
      expect(result.exitCode).not.toBe(0);
    });

    it('should provide helpful error messages', () => {
      const result = cli.runSilent('invalid-command-xyz');

      // Should include error information or help text
      expect(result.error || result.output).toBeDefined();
    });
  });
});
