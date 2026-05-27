import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest globalSetup — runs once per test session before any test file.
 * Equivalent to pytest scope="session" fixture.
 * Ensures dist/ exists so agent session tests can spawn bin/codemie-claude.js.
 */
export async function setup(): Promise<void> {
  const root = resolve(__dirname, '../..');
  console.log('\n[agent-integration] Building dist/ (runs once per session)...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
  console.log('[agent-integration] Build complete.\n');
}
