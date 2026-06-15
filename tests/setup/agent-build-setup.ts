import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

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

  // The native Claude installer places the binary at ~/.local/bin/claude(.exe).
  // On Windows CI runners this directory is not in PATH by default, so we add it
  // to process.env.PATH before checking and after installing.
  const localBin = join(homedir(), '.local', 'bin');
  const pathSep = process.platform === 'win32' ? ';' : ':';
  if (!(process.env.PATH ?? '').includes(localBin)) {
    process.env.PATH = `${localBin}${pathSep}${process.env.PATH ?? ''}`;
  }

  try {
    execSync('claude --version', { stdio: 'pipe' });
    console.log('[agent-integration] claude CLI found.\n');
  } catch {
    console.log('[agent-integration] claude CLI not found — installing via codemie...');
    try {
      // Installer may exit non-zero on Windows when it warns that ~/.local/bin
      // is not yet in the system PATH — installation itself succeeds.
      execSync(`node ${resolve(root, 'bin/codemie.js')} install claude`, { cwd: root, stdio: 'inherit' });
    } catch {
      // Ignore exit code — verify the binary is actually present below.
    }
    // Re-add localBin in case the installer modified PATH during its run.
    if (!(process.env.PATH ?? '').includes(localBin)) {
      process.env.PATH = `${localBin}${pathSep}${process.env.PATH ?? ''}`;
    }
    execSync('claude --version', { stdio: 'pipe' }); // throws if install genuinely failed
    console.log('[agent-integration] claude CLI installed.\n');
  }

  // Link the local build to global PATH so `codemie hook` resolves when
  // Claude fires it via hooks.json during a test session.
  console.log('[agent-integration] Linking local build to global PATH...');
  execSync('npm link', { cwd: root, stdio: 'pipe' });
  console.log('[agent-integration] Linked.');

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
