import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';

export function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

export function getKimiConfigPath(): string {
  return join(getKimiCodeHome(), 'config.toml');
}

export function getKimiSessionsDir(): string {
  return join(getKimiCodeHome(), 'sessions');
}

export function encodeKimiWorkDirKey(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  let slug = basename(resolvedCwd).toLowerCase();

  slug = slug.replace(/[^a-z0-9._-]/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  slug = slug.slice(0, 40);

  if (slug === '' || slug === '.' || slug === '..') {
    slug = 'workspace';
  }

  const hash = createHash('sha256')
    .update(resolvedCwd)
    .digest('hex')
    .slice(0, 12);

  return `wd_${slug}_${hash}`;
}

export function getKimiSessionDir(cwd: string, sessionId: string): string {
  return join(getKimiSessionsDir(), encodeKimiWorkDirKey(cwd), sessionId);
}

export function getKimiMainWirePath(cwd: string, sessionId: string): string {
  return join(getKimiSessionDir(cwd, sessionId), 'agents', 'main', 'wire.jsonl');
}

export function getKimiUserSkillsDir(): string {
  return join(getKimiCodeHome(), 'skills');
}
