import { commandExists } from '../../../utils/processes.js';
import { exec } from '../../../utils/exec.js';
import { AgentInstallationError, ConfigurationError } from '../../../utils/errors.js';

interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

export async function ensureClaudeCliAvailable(): Promise<void> {
  const hasClaude = await commandExists('claude');
  if (!hasClaude) {
    throw new AgentInstallationError('claude', 'Claude Code CLI is not installed. Run: codemie install claude');
  }
}

export async function runClaudeBrowserLogin(): Promise<void> {
  await exec('claude', ['auth', 'login'], {
    timeout: 300000,
    interactive: true
  });
}

export function parseClaudeAuthStatus(raw: string): ClaudeAuthStatus {
  try {
    return JSON.parse(raw) as ClaudeAuthStatus;
  } catch {
    throw new ConfigurationError('Failed to parse Claude auth status output');
  }
}

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const result = await exec('claude', ['auth', 'status', '--json'], {
    timeout: 10000
  });

  return parseClaudeAuthStatus(result.stdout);
}
