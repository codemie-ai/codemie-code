import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractGeneratedConfig } from '../print-config.js';

describe('extractGeneratedConfig', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    while (tempFiles.length) {
      const f = tempFiles.pop();
      if (f) {
        try { unlinkSync(f); } catch { /* already removed */ }
      }
    }
  });

  it('parses env.OPENCODE_CONFIG_CONTENT when present', () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'gpt-5' }) } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'gpt-5' });
  });

  it('reads and parses the file at env.OPENCODE_CONFIG when CONTENT is absent', () => {
    const path = join(tmpdir(), `print-config-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ model: 'from-file' }), 'utf-8');
    tempFiles.push(path);

    const env = { OPENCODE_CONFIG: path } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'from-file' });
  });

  it('prefers OPENCODE_CONFIG_CONTENT over OPENCODE_CONFIG when both are set', () => {
    const path = join(tmpdir(), `print-config-test-${Date.now()}-b.json`);
    writeFileSync(path, JSON.stringify({ model: 'from-file' }), 'utf-8');
    tempFiles.push(path);

    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'inline' }),
      OPENCODE_CONFIG: path,
    } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'inline' });
  });

  it('throws a descriptive error when neither env var is set', () => {
    expect(() => extractGeneratedConfig({} as NodeJS.ProcessEnv)).toThrow(
      'Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid',
    );
  });
});
