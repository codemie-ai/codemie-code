import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';

export function getClaudeDesktopBaseDir(): string {
  if (process.platform === 'win32') {
    // Claude Desktop reads its enterprise config from %LOCALAPPDATA%\Claude-3p
    // (not %APPDATA%). This matches the app's own CJe() path resolution.
    const localAppData =
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'Claude-3p');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude-3p');
  }

  if (process.platform === 'linux') {
    // Claude Desktop is Electron, whose appData dir resolves to
    // $XDG_CONFIG_HOME || ~/.config; Claude-3p sits directly under it, exactly
    // as ~/Library/Application Support/Claude-3p does on macOS. Anthropic
    // documents the local 3P config library as ~/.config/Claude-3p/configLibrary/.
    //
    // The XDG spec treats an empty value as unset and requires absolute paths,
    // and Electron enforces the same. Honouring a relative value here would
    // resolve the config against the current directory.
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configDir =
      xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), '.config');
    return join(configDir, 'Claude-3p');
  }

  throw new ConfigurationError(
    `Claude Desktop proxy is not supported on platform "${process.platform}"`,
  );
}

/**
 * Path to the managed (MDM) settings source, where the platform exposes one as
 * a plain file. A managed source overrides local configLibrary entries
 * entirely, so its presence makes a local write ineffective.
 *
 * Returns null on macOS and Windows. Windows keeps its managed source in the
 * registry, which is not a file. macOS does use one
 * (/Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist),
 * but a device-scoped profile lands outside that per-user path, so stat-ing it
 * would detect only some managed Macs; doing it properly is out of scope here.
 */
export function getClaudeDesktopManagedSettingsPath(): string | null {
  return process.platform === 'linux' ? '/etc/claude-desktop/managed-settings.json' : null;
}

export function getClaudeDesktopLocalSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'local-agent-mode-sessions');
}

export function getClaudeDesktopCodeSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'claude-code-sessions');
}
