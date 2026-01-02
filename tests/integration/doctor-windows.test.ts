/**
 * Integration tests for doctor command - Windows compatibility
 *
 * These tests verify that the doctor command properly detects installed tools
 * on Windows using the correct 'where' command instead of Unix 'which'
 */

import { describe, it, expect } from 'vitest';
import { NpmCheck } from '../../src/cli/commands/doctor/checks/NpmCheck.js';
import { PythonCheck } from '../../src/cli/commands/doctor/checks/PythonCheck.js';
import { setupTestIsolation } from '../helpers/test-isolation.js';

describe('Doctor Command - Windows Compatibility', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  describe('NpmCheck', () => {
    it('should detect npm when installed (cross-platform)', async () => {
      const check = new NpmCheck();
      const result = await check.run();

      // npm should be installed in test environment
      expect(result.success).toBe(true);
      expect(result.details).toHaveLength(1);
      expect(result.details[0].status).toBe('ok');
      expect(result.details[0].message).toMatch(/Version/);
    });
  });

  describe('PythonCheck', () => {
    it('should check for Python installation (cross-platform)', async () => {
      const check = new PythonCheck();
      const result = await check.run();

      // Python may or may not be installed
      expect(result.name).toBe('Python');
      expect(result.details).toHaveLength(1);

      // Should have one of these statuses
      const status = result.details[0].status;
      expect(['ok', 'warn']).toContain(status);
    });

    it('should detect Windows Store redirect and provide helpful hint', async () => {
      const check = new PythonCheck();
      const result = await check.run();

      // If Python shows Microsoft Store message, should provide helpful hint
      if (result.details[0].message.includes('Microsoft Store')) {
        expect(result.details[0].status).toBe('warn');
        expect(result.details[0].hint).toContain('app execution aliases');
      }
    });
  });
});
