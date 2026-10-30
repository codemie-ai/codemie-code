import { join } from 'node:path';
import { resolveHomeDir } from '@/utils/paths.js';
import { readJsonFile } from './session-env-fields.js';

const MAX_ORG_LENGTH = 256;

/**
 * Reads `oauthAccount.organizationName` from Claude's `.claude.json`
 * (`$CLAUDE_CONFIG_DIR/.claude.json` when set, else `~/.claude.json`).
 * Returns a trimmed non-empty string <= 256 chars, else undefined. Never logs the value.
 */
export async function readClaudeOrganization(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const dir = env.CLAUDE_CONFIG_DIR;
  const file = dir ? join(dir, '.claude.json') : resolveHomeDir('.claude.json');
  const account = (await readJsonFile(file))?.oauthAccount;
  const name = typeof account === 'object' && account !== null ? (account as Record<string, unknown>).organizationName : undefined;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed && trimmed.length <= MAX_ORG_LENGTH ? trimmed : undefined;
}
