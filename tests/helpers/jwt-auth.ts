import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fetch a fresh JWT token via Keycloak password grant.
 * Requires CI_CODEMIE_USERNAME and CI_CODEMIE_PASSWORD env vars.
 */
export async function fetchJwtToken(): Promise<string> {
  const resp = await fetch(
    'https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'codemie-sdk',
        username: process.env.CI_CODEMIE_USERNAME!,
        password: process.env.CI_CODEMIE_PASSWORD!,
      }),
    }
  );
  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.access_token) throw new Error(`JWT token fetch failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

export interface JwtProfileOverrides {
  profileName?: string;
  model?: string;
  codeMieUrl?: string;
  baseUrl?: string;
  jwtToken?: string;
  codeMieProject?: string;
}

/**
 * Write a bearer-auth profile to ${codemieHome}/codemie-cli.config.json.
 * The config location matches getCodemiePath() which uses CODEMIE_HOME as the
 * base directory (not ~/.codemie/.codemie).
 */
export function writeJwtProfile(codemieHome: string, overrides: JwtProfileOverrides = {}): void {
  const profileName = overrides.profileName ?? 'jwt-autotest';
  const profile: Record<string, string> = {
    name: profileName,
    provider: 'bearer-auth',
    authMethod: 'jwt',
    codeMieUrl: overrides.codeMieUrl ?? process.env.CI_CODEMIE_URL ?? '',
    baseUrl: overrides.baseUrl ?? process.env.CI_CODEMIE_API_DOMAIN ?? '',
    model: overrides.model ?? process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
  };
  if (overrides.jwtToken) profile.jwtToken = overrides.jwtToken;
  if (overrides.codeMieProject) profile.codeMieProject = overrides.codeMieProject;

  const config = { version: 2, activeProfile: profileName, profiles: { [profileName]: profile } };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}
