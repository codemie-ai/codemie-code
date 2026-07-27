import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

export interface ConflictInfo {
  settingsUrl?: string;
  profileUrl?: string;
  settingsModel?: string;
  profileModel?: string;
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
  const rawUrl = envBlock?.ANTHROPIC_BASE_URL;
  const rawModel = envBlock?.ANTHROPIC_MODEL;

  const hasUrlConflict =
    typeof rawUrl === 'string' &&
    rawUrl !== '' &&
    (env.ANTHROPIC_BASE_URL === undefined || rawUrl !== env.ANTHROPIC_BASE_URL);

  const hasModelConflict =
    typeof rawModel === 'string' &&
    rawModel !== '' &&
    (env.ANTHROPIC_MODEL === undefined || rawModel !== env.ANTHROPIC_MODEL);

  if (!hasUrlConflict && !hasModelConflict) return null;

  return {
    ...(hasUrlConflict ? { settingsUrl: rawUrl as string, profileUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(hasModelConflict ? { settingsModel: rawModel as string, profileModel: env.ANTHROPIC_MODEL } : {}),
  };
}
