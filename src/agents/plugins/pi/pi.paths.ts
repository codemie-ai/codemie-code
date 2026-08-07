import { join } from 'path';
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
