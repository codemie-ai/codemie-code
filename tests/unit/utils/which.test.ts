/**
 * Tests for cross-platform command finder utility
 */

import { describe, it, expect } from 'vitest';
import { commandExists, getCommandPath } from '../../../src/utils/processes.js';

describe('which utility', () => {
  describe('commandExists', () => {
    it('should find node command (always available in test env)', async () => {
      const exists = await commandExists('node');
      expect(exists).toBe(true);
    });

    it('should find npm command (always available in test env)', async () => {
      const exists = await commandExists('npm');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent command', async () => {
      const exists = await commandExists('this-command-definitely-does-not-exist-12345');
      expect(exists).toBe(false);
    });
  });

  describe('getCommandPath', () => {
    it('should get path to node command', async () => {
      const path = await getCommandPath('node');
      expect(path).toBeTruthy();
      expect(typeof path).toBe('string');
    });

    it('should return null for non-existent command', async () => {
      const path = await getCommandPath('this-command-definitely-does-not-exist-12345');
      expect(path).toBeNull();
    });
  });
});
