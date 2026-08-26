import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { logger } from '../logger.js';
import { getCodemieHome } from '../paths.js';

describe('vitest CODEMIE_HOME isolation', () => {
  it('resolves CODEMIE_HOME and the logger file path under the OS temp dir', () => {
    expect(process.env.CODEMIE_HOME).toBeDefined();
    expect(getCodemieHome().startsWith(tmpdir())).toBe(true);

    const logPath = logger.getLogFilePath();
    expect(logPath).not.toBeNull();
    expect(logPath!.startsWith(tmpdir())).toBe(true);
  });
});
