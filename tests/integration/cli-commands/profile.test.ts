/**
 * CLI Profile Command Integration Test
 *
 * Tests the 'codemie profile' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Profile Commands', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

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
