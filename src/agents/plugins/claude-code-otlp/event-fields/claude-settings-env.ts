import { settingsLayerPaths, readSettingsLayer } from '@/agents/core/claude-settings.js';

export interface ClaudeSettingsEnv {
  /** Merged `env` blocks, lowest to highest precedence; values are raw (validated by the routing rules). */
  env: Record<string, unknown>;
  /** False when any layer exists but could not be read/parsed/shaped: the merged env is then not trustworthy. */
  complete: boolean;
  /** True when any layer configures an `apiKeyHelper`: the session then authenticates with an API key, not OAuth. */
  apiKeyHelper?: boolean;
}

/** A missing file is no override; an unreadable/malformed one (or a non-object `env`) is unknown, never "absent". */
export async function readClaudeSettingsEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<ClaudeSettingsEnv> {
  const layers = await Promise.all(settingsLayerPaths(cwd, env, platform).map(readSettingsLayer));
  const merged: Record<string, unknown> = {};
  let complete = true;
  let apiKeyHelper = false;
  for (const result of layers) {
    if (result.state === 'absent') continue;
    const layer = result.parsed;
    if (result.state !== 'ok' || !layer) {
      complete = false;
      continue;
    }
    // forceLoginMethod 'console' bills the API, not the saved subscription login: same effect as a key helper.
    if ((typeof layer.apiKeyHelper === 'string' && layer.apiKeyHelper.trim()) || layer.forceLoginMethod === 'console') apiKeyHelper = true;
    const block = layer.env;
    if (block === undefined) continue;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      complete = false;
      continue;
    }
    Object.assign(merged, block);
  }
  return { env: merged, complete, ...(apiKeyHelper ? { apiKeyHelper } : {}) };
}
