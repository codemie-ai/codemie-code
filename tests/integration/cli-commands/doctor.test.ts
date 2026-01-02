/**
 * CLI Doctor Command Integration Test
 *
 * Tests the 'codemie doctor' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Doctor Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

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
