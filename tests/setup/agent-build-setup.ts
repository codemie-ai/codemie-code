import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest globalSetup — runs once per test session before any test file.
 * Equivalent to pytest scope="session" fixture.
 * Ensures dist/ exists and the claude CLI is installed before agent tests run.
 */
export async function setup(): Promise<void> {
  const root = resolve(__dirname, '../..');

  console.log('\n[agent-integration] Building dist/ (runs once per session)...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
  console.log('[agent-integration] Build complete.');

  try {
    execSync('claude --version', { stdio: 'pipe' });
    console.log('[agent-integration] claude CLI found.\n');
  } catch {
    console.log('[agent-integration] claude CLI not found — installing via codemie...');
    execSync(`node ${resolve(root, 'bin/codemie.js')} install claude`, { cwd: root, stdio: 'inherit' });
    console.log('[agent-integration] claude CLI installed.\n');
  }

  // Pre-install the Claude CodeMie extension once before parallel tests start.
  // Without this, each parallel test triggers installer.install() simultaneously.
  // When the source version differs from the installed version, every installer
  // does rm -rf ~/.codemie/claude-plugin then cp — racing each other.  A test's
  // Claude Code process that starts mid-race gets a missing/partial plugin dir,
  // the hooks never fire, and sessions/ is never created (ENOENT).
  // Pre-installing here ensures all concurrent callers see action=already_exists
  // and skip the destructive rm/cp entirely.
  console.log('[agent-integration] Pre-installing Claude CodeMie extension...');
  try {
    const { ClaudePluginInstaller } = await import(
      resolve(root, 'dist/agents/plugins/claude/claude.plugin-installer.js')
    ) as { ClaudePluginInstaller: new (m: { name: string }) => { install(): Promise<{ action: string; targetPath: string }> } };
    const installer = new ClaudePluginInstaller({ name: 'claude' });
    const result = await installer.install();
    console.log(`[agent-integration] Claude extension ${result.action} at ${result.targetPath}.\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[agent-integration] Claude extension pre-install warning (non-fatal): ${msg}\n`);
  }
}
