import { homedir } from 'node:os';
import { join } from 'node:path';
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

  throw new ConfigurationError(
    `Claude Desktop proxy is not supported on platform "${process.platform}"`,
  );
}

export function getClaudeDesktopLocalSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'local-agent-mode-sessions');
}

export function getClaudeDesktopCodeSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'claude-code-sessions');
}
