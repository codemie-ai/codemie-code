/**
 * CLI Help Command Integration Test
 *
 * Tests the 'codemie --help' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Help Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

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
});
