import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDirname } from '@/utils/paths.js';
import { ConfigurationError } from '@/utils/errors.js';
import type { CodenotchProviderId } from './snapshot.js';

const run = promisify(execFile);

export const CODENOTCH_NAME = 'codenotch';
export const CODENOTCH_DISPLAY_NAME = 'Codenotch';
export const CODENOTCH_DESCRIPTION =
  'AI usage in the Mac notch — plus your CodeMie budget and Claude session spending as a provider';

/** Where Codenotch releases live. */
const RELEASE_REPO = 'vinzdg/codenotch';
const APP_NAME = 'Codenotch.app';
const SYSTEM_APPLICATIONS = '/Applications';

/**
 * Codenotch's plugin root. Codenotch itself lets developers point elsewhere
 * with CODENOTCH_PLUGINS_DIR; honour it so a dev loop does not touch the
 * user's real registration.
 */
function pluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODENOTCH_PLUGINS_DIR;
  if (override) return override.replace(/^~/, process.env.HOME ?? '');
  return join(process.env.HOME ?? '', 'Library', 'Application Support', 'Codenotch', 'Plugins');
}

/** The codemie binary the user just ran us through — stable across upgrades. */
function codemieBin(): string {
  return process.argv[1] ?? 'codemie';
}

interface ProviderSpec {
  id: CodenotchProviderId;
  displayName: string;
  activity?: { type: 'claudeSessions'; configDir: string };
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: 'codemie-claude',
    displayName: 'CodeMie Usage',
    activity: { type: 'claudeSessions', configDir: '~/.claude' },
  },
];

/**
 * Provider ids earlier builds registered and this one no longer does. Cleaned
 * up on both register and unregister: a leftover directory keeps Codenotch
 * polling `--provider codemie-budget`, which now exits 1 as an unknown id.
 */
const RETIRED_PROVIDER_IDS = ['codemie-budget'];

function manifestFor(spec: ProviderSpec, bin: string): Record<string, unknown> {
  return {
    schema: 1,
    id: spec.id,
    displayName: spec.displayName,
    version: '1',
    exec: {
      path: bin,
      args: ['codenotch', 'snapshot', '--provider', spec.id],
      timeoutSeconds: 20,
    },
    glyph: { image: 'glyph.png', opticalScale: 1 },
    signIn: {
      guidance: 'Run `codemie profile login` in Terminal.',
      run: [bin, 'profile', 'login'],
    },
    ...(spec.activity ? { activity: spec.activity } : {}),
  };
}

/**
 * Remove a plugin directory, but only when its manifest carries the expected
 * id — a directory the user repurposed is never deleted.
 */
async function removeProviderDir(id: string): Promise<string | null> {
  const dir = join(pluginsRoot(), id);
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { id?: string };
    if (manifest.id !== id) return null;
  } catch {
    return null;
  }
  await rm(dir, { recursive: true, force: true });
  return dir;
}

/**
 * Write the plugin manifest and glyph asset into Codenotch's plugins
 * directory. Idempotent — re-running rewrites identical files. Codenotch
 * watches the directory and picks the provider up without a restart.
 */
export async function registerCodenotchPlugins(): Promise<string[]> {
  const written: string[] = [];
  for (const id of RETIRED_PROVIDER_IDS) await removeProviderDir(id);
  const assetsDir = join(getDirname(import.meta.url), 'assets');
  for (const spec of PROVIDERS) {
    const dir = join(pluginsRoot(), spec.id);
    await mkdir(dir, { recursive: true });
    const manifestPath = join(dir, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifestFor(spec, codemieBin()), null, 2) + '\n');
    written.push(manifestPath);
    const glyphSource = join(assetsDir, `glyph-${spec.id}.png`);
    const glyphDest = join(dir, 'glyph.png');
    await cp(glyphSource, glyphDest, { force: true });
    written.push(glyphDest);
  }
  return written;
}

/** Remove the plugin directories this build owns, plus any retired ones. */
export async function unregisterCodenotchPlugins(): Promise<string[]> {
  const removed: string[] = [];
  const ids = [...PROVIDERS.map((spec) => spec.id), ...RETIRED_PROVIDER_IDS];
  for (const id of ids) {
    const dir = await removeProviderDir(id);
    if (dir) removed.push(dir);
  }
  return removed;
}

export function isCodenotchPluginRegistered(): boolean {
  return PROVIDERS.every((spec) => existsSync(join(pluginsRoot(), spec.id, 'plugin.json')));
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

async function latestDmg(): Promise<{ url: string; version: string }> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new ConfigurationError(`could not read ${RELEASE_REPO} releases (HTTP ${response.status})`);
  }
  const release = (await response.json()) as ReleaseInfo;
  const asset = release.assets?.find((a) => a.name === 'Codenotch.dmg');
  if (!asset) {
    throw new ConfigurationError(`no Codenotch.dmg on ${RELEASE_REPO} release ${release.tag_name}`);
  }
  return { url: asset.browser_download_url, version: release.tag_name };
}

/**
 * Download the latest Codenotch release and install it into /Applications.
 * macOS only — Codenotch is a macOS app.
 */
export async function installCodenotchApp(): Promise<{ appPath: string; version: string }> {
  if (process.platform !== 'darwin') {
    throw new ConfigurationError('Codenotch is a macOS app — nothing to install on this platform.');
  }
  const { url, version } = await latestDmg();
  const workDir = await mkdtemp(join(tmpdir(), 'codenotch-install-'));
  const dmgPath = join(workDir, 'Codenotch.dmg');
  const mountPoint = join(workDir, 'mnt');
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new ConfigurationError(`download failed (HTTP ${response.status})`);
    }
    await writeFile(dmgPath, Buffer.from(await response.arrayBuffer()));

    await mkdir(mountPoint, { recursive: true });
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);

    // A running instance cannot have its bundle replaced underneath it.
    await run('osascript', ['-e', 'tell application "Codenotch" to quit']).catch(() => {});
    await run('pkill', ['-x', 'Codenotch']).catch(() => {});

    const appPath = join(SYSTEM_APPLICATIONS, APP_NAME);
    await rm(appPath, { recursive: true, force: true });
    await run('ditto', [join(mountPoint, APP_NAME), appPath]);
    return { appPath, version };
  } finally {
    await run('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Remove the installed app, after stopping a running instance. */
export async function uninstallCodenotchApp(): Promise<boolean> {
  const appPath = join(SYSTEM_APPLICATIONS, APP_NAME);
  if (!existsSync(appPath)) return false;
  await run('osascript', ['-e', 'tell application "Codenotch" to quit']).catch(() => {});
  await run('pkill', ['-x', 'Codenotch']).catch(() => {});
  await rm(appPath, { recursive: true, force: true });
  return true;
}
