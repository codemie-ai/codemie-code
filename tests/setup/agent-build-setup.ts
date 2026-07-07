import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config as loadEnv } from 'dotenv';
import { setupSsoAutotestProfile, teardownSsoAutotestProfile } from '../helpers/sso-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function getActiveProfileProvider(): string | undefined {
  const configPath = join(homedir(), '.codemie', 'codemie-cli.config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const active = config.activeProfile as string | undefined;
    if (!active) return undefined;
    const profiles = config.profiles as Record<string, Record<string, unknown>> | undefined;
    return profiles?.[active]?.provider as string | undefined;
  } catch {
    return undefined;
  }
}

let originalSsoProfile: string | undefined;

/**
 * Vitest globalSetup — runs once per test session before any test file.
 * Equivalent to pytest scope="session" fixture.
 * Ensures dist/ exists and the claude CLI is installed before agent tests run.
 */
export async function setup(): Promise<void> {
  loadEnv({ path: resolve(root, '.env.test.local'), override: true });

  // Default to the public prod instance when no .env.test.local is present.
  process.env.CI_CODEMIE_URL ??= 'https://codemie.lab.epam.com';

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

  // For SSO (local dev) runs: validate credentials before any test subprocess
  // tries to use them. If credentials are missing or expired, launch the
  // browser SSO flow immediately (no "Re-authenticate now?" prompt).
  // JWT (CI) runs skip this — each test fetches a fresh JWT token itself.
  const isLocalRun = (process.env.CI_IS_LOCAL_RUN ?? 'true') !== 'false';
  if (isLocalRun) {
    const activeProvider = getActiveProfileProvider();
    if (activeProvider !== 'ai-run-sso') {
      console.log(
        `[agent-integration] Active profile provider is "${activeProvider ?? 'none'}" — not CodeMie SSO.`,
      );
      console.log('[agent-integration] Agent SSO tests will be skipped.');
      console.log('[agent-integration] Use npm run test:run for unit + CLI tests without credentials.\n');
      process.env.SSO_AVAILABLE = 'false';
      return;
    }
    console.log('[agent-integration] SSO mode — validating credentials...');
    originalSsoProfile = setupSsoAutotestProfile();
    try {
      const { getCodemieClient } = await import(
        resolve(root, 'dist/utils/sdk-client.js')
      ) as { getCodemieClient: (quiet: boolean) => Promise<unknown> };
      await getCodemieClient(true);
      console.log('[agent-integration] SSO credentials valid.\n');
    } catch {
      // Credentials missing or expired — launch browser SSO login directly.
      // Using stdio: 'inherit' so the user sees and can complete the flow.
      console.log('[agent-integration] SSO credentials missing or expired — launching login...\n');
      const codemieUrl = process.env.CI_CODEMIE_URL ?? '';
      try {
        execSync(
          `node ${resolve(root, 'bin/codemie.js')} profile login --url ${codemieUrl}`,
          { cwd: root, stdio: 'inherit' },
        );
      } catch (loginError) {
        const msg = loginError instanceof Error ? loginError.message : String(loginError);
        console.warn(`[agent-integration] Profile login failed: ${msg}`);
        console.warn('[agent-integration] SSO credentials unavailable — agent SSO tests will be skipped.');
        process.env.SSO_AVAILABLE = 'false';
      }
    }
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

/**
 * Vitest globalTeardown — runs once after all test files complete.
 * Restores the user's original active SSO profile if it was changed during setup().
 */
export async function teardown(): Promise<void> {
  teardownSsoAutotestProfile(originalSsoProfile);
}
