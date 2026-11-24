import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { resolveEnvFields } from '../env-fields.js';

describe('resolveEnvFields', () => {
  it('reports the current platform and the resolved IANA timezone', async () => {
    const fields = await resolveEnvFields();

    expect(fields).toEqual({
      os: os.platform(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    });
  });
});
