import { join, resolve } from 'path';
import { homedir } from 'os';

export function getUserPiAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

export function getPiAgentDir(cwd: string = process.cwd()): string {
  return join(cwd, '.pi', 'codemie', 'agent');
}

export function getPiModelsPath(cwd: string = process.cwd()): string {
  return join(getPiAgentDir(cwd), 'models.json');
}

/**
 * Compute the Pi session storage directory for a given cwd.
 *
 * Pi encodes the cwd as `--<cwd with leading slash removed and path
 * separators/colons replaced by dashes>--` under the agent dir's `sessions/`.
 */
export function getPiSessionDir(cwd: string = process.cwd()): string {
  const resolved = resolve(cwd);
  const safeName = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getPiAgentDir(cwd), 'sessions', safeName);
}
