import { ConfigLoader } from '@/utils/config.js';
import { findNearestConfigDir } from '@/agents/core/event-fields/identity-fields.js';
import type { CodeMieConfigOptions } from '@/env/types.js';

/**
 * The CODEMIE_* environment `codemie-copilot` resolves its model from: config from the nearest `.codemie`
 * up from `cwd` (as AgentCLI does), `.env` from `cwd` itself.
 */
export async function loadCopilotLaunchEnv(
  cwd: string,
  overrides: Partial<CodeMieConfigOptions>,
  jwtToken?: string
): Promise<Record<string, string>> {
  const config = await ConfigLoader.load(await findNearestConfigDir(cwd), overrides, cwd);
  if (jwtToken !== undefined) {
    process.env.CODEMIE_JWT_TOKEN = jwtToken;
    config.authMethod = 'jwt';
  }

  const env = ConfigLoader.exportProviderEnvVars(config);
  if (jwtToken !== undefined) {
    env.CODEMIE_AUTH_METHOD = 'jwt';
    env.CODEMIE_JWT_TOKEN = jwtToken;
  }
  return env;
}
