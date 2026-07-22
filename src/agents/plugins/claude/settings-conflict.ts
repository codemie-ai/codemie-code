import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

export interface ConflictInfo {
  settingsUrl: string;
  profileUrl: string | undefined;
}

export async function detectSettingsConflict(
  env: NodeJS.ProcessEnv
): Promise<ConflictInfo | null> {
  const settingsPath = join(resolveHomeDir('.claude'), 'settings.json');

  if (!existsSync(settingsPath)) return null;

  let settings: Record<string, unknown>;
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  } catch {
    return null;
  }

  const envBlock = settings.env as Record<string, unknown> | undefined;
  const settingsUrl = envBlock?.ANTHROPIC_BASE_URL;
  if (typeof settingsUrl !== 'string' || !settingsUrl) return null;

  const profileUrl = env.ANTHROPIC_BASE_URL;
  if (profileUrl !== undefined && settingsUrl === profileUrl) return null;

  return { settingsUrl, profileUrl };
}
