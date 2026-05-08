import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';

export function getClaudeDesktopBaseDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude-3p');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude-3p');
  }

  throw new ConfigurationError(
    `Claude Desktop proxy is not supported on platform "${process.platform}"`
  );
}

export function getClaudeDesktopLocalSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'local-agent-mode-sessions');
}

export function getClaudeDesktopCodeSessionsRoot(): string {
  return join(getClaudeDesktopBaseDir(), 'claude-code-sessions');
}
