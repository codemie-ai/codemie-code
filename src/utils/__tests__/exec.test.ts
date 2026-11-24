import { describe, expect, it } from 'vitest';
import { exec } from '../exec.js';

describe('exec unsetEnv', () => {
  it('removes the listed keys from the inherited environment', async () => {
    process.env.CODEMIE_EXEC_TEST_STRIP = 'inherited';
    try {
      const result = await exec(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.CODEMIE_EXEC_TEST_STRIP))'],
        { unsetEnv: ['CODEMIE_EXEC_TEST_STRIP'] }
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env.CODEMIE_EXEC_TEST_STRIP;
    }
  });

  it('keeps inherited keys that are not listed', async () => {
    process.env.CODEMIE_EXEC_TEST_KEEP = 'kept';
    try {
      const result = await exec(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.CODEMIE_EXEC_TEST_KEEP))'],
        { unsetEnv: ['CODEMIE_EXEC_TEST_OTHER'] }
      );
      expect(result.stdout).toBe('kept');
    } finally {
      delete process.env.CODEMIE_EXEC_TEST_KEEP;
    }
  });
});
