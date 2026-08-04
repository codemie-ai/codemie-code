import { readFileSync } from 'fs';

/**
 * Reads the opencode config beforeRun() generated back out of env — either the
 * inline OPENCODE_CONFIG_CONTENT channel or the OPENCODE_CONFIG temp-file
 * fallback. Throws if beforeRun's early-return path (missing/invalid
 * CODEMIE_BASE_URL) left neither populated.
 */
export function extractGeneratedConfig(env: NodeJS.ProcessEnv): unknown {
  if (env.OPENCODE_CONFIG_CONTENT) {
    return JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  }

  if (env.OPENCODE_CONFIG) {
    return JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf-8'));
  }

  throw new Error('Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid');
}
