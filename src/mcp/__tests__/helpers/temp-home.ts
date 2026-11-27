import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MANAGED_ENV_VARS = [
  'CODEMIE_HOME',
  'MCP_PROXY_AUTH_TIMEOUT_SECONDS',
  'MCP_PROXY_PERSIST_TOKENS',
  'MCP_CLIENT_NAME',
] as const;

/**
 * Registers beforeEach/afterEach hooks that give each test a fresh temp
 * CODEMIE_HOME and restore the MCP-related env vars afterwards
 * (previous value is put back, or the variable is deleted if it was unset).
 */
export function useTempCodemieHome(): { dir(): string } {
  let current = '';
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of MANAGED_ENV_VARS) {
      saved.set(name, process.env[name]);
    }
    current = mkdtempSync(join(tmpdir(), 'codemie-mcp-test-'));
    process.env.CODEMIE_HOME = current;
  });

  afterEach(() => {
    for (const name of MANAGED_ENV_VARS) {
      const previous = saved.get(name);
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
    saved.clear();
    if (current) {
      rmSync(current, { recursive: true, force: true });
      current = '';
    }
  });

  return { dir: (): string => current };
}
