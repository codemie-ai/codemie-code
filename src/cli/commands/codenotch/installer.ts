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
  'AI usage in the Mac notch — plus CodeMie budget and Claude session spending providers';

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
  { id: 'codemie-budget', displayName: 'CodeMie Budget' },
  {
    id: 'codemie-claude',
    displayName: 'CodeMie Claude',
    activity: { type: 'claudeSessions', configDir: '~/.claude' },
  },
];

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
 * Write both plugin manifests and glyph assets into Codenotch's plugins
 * directory. Idempotent — re-running rewrites identical files. Codenotch
 * watches the directory and picks the providers up without a restart.
 */
export async function registerCodenotchPlugins(): Promise<string[]> {
  const written: string[] = [];
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

/**
 * Remove the plugin directories — but only ones whose manifest carries the
 * expected id, so a directory the user repurposed is never deleted.
 */
export async function unregisterCodenotchPlugins(): Promise<string[]> {
  const removed: string[] = [];
  for (const spec of PROVIDERS) {
    const dir = join(pluginsRoot(), spec.id);
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { id?: string };
      if (manifest.id !== spec.id) continue;
    } catch {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
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
