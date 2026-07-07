import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripNodeModulesBin } from './test-env.js';

// Slug used for the test assistant agent file
const CI_ASSISTANT_SLUG = 'ci-assistant';

/**
 * Fetch a fresh JWT token via Keycloak password grant.
 *
 * Shortcut: if CI_CODEMIE_JWT_TOKEN is already set, returns it directly
 * (useful for manual runs or when the token is pre-fetched in CI).
 *
 * Otherwise, performs a Keycloak password grant using CI_CODEMIE_USERNAME
 * and CI_CODEMIE_PASSWORD. Credentials are trimmed to strip whitespace/CRLF
 * that PowerShell env files sometimes introduce.
 */
export async function fetchJwtToken(): Promise<string> {
  const preFetched = process.env.CI_CODEMIE_JWT_TOKEN?.trim();
  if (preFetched) return preFetched;

  const username = process.env.CI_CODEMIE_USERNAME?.trim();
  const password = process.env.CI_CODEMIE_PASSWORD?.trim();
  if (!username || !password)
    throw new Error('CI_CODEMIE_USERNAME and CI_CODEMIE_PASSWORD should be set in .env.test.local or env variables');

  const authUrlRaw = process.env.CI_CODEMIE_AUTH_URL?.trim();
  if (!authUrlRaw) throw new Error('CI_CODEMIE_AUTH_URL must be set in .env.test.local or env variables');
  const authUrl = `${authUrlRaw.replace(/\/$/, '')}/realms/codemie-prod/protocol/openid-connect/token`;

  const resp = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.CI_CODEMIE_AUTH_CLIENT_ID?.trim() ?? 'codemie-sdk',
      username,
      password,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`JWT token fetch failed: HTTP ${resp.status} ${resp.statusText}\n${body}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.access_token) throw new Error(`JWT token fetch failed: no access_token in response: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

/**
 * Minimal allowlist environment for JWT agent spawns.
 * Strips everything except essential PATH and platform OS variables so no
 * credentials or CODEMIE_* session state leak into the subprocess.
 *
 * Strips node_modules/.bin entries from PATH so locally-installed package
 * shims don't shadow the globally npm-linked `codemie` binary.
 */
export function jwtCleanEnv(): NodeJS.ProcessEnv {
  const cleanPath = stripNodeModulesBin(process.env.PATH ?? '');
  const pick = (...keys: string[]): NodeJS.ProcessEnv =>
    Object.fromEntries(keys.flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]]] : [])));
  return {
    PATH: cleanPath,
    NODE_PATH: process.env.NODE_PATH ?? '',
    ...pick('SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'COMSPEC',
            'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'),
    ...pick('HOME', 'USER', 'LANG', 'LC_ALL', 'SHELL'),
  };
}

export interface JwtProfileOverrides {
  profileName?: string;
  model?: string;
  codeMieUrl?: string;
  jwtToken?: string;
  codeMieProject?: string;
  authServerUrl?: string;
  authRealm?: string;
  /** When set, writes the assistant to LOCAL config + creates its agent file. */
  assistantId?: string;
}

/**
 * Write a bearer-auth profile to ${codemieHome}/codemie-cli.config.json.
 * The config location matches getCodemiePath() which uses CODEMIE_HOME as the
 * base directory (not ~/.codemie/.codemie).
 */
/**
 * Returns the path of the agent stub file written to the real home directory
 * when overrides.assistantId is set (caller must clean it up in afterAll).
 */
export function writeJwtProfile(codemieHome: string, overrides: JwtProfileOverrides = {}): string | undefined {
  const profileName = overrides.profileName ?? 'jwt-autotest';
  const authUrlRaw = process.env.CI_CODEMIE_AUTH_URL?.trim();
  if (!authUrlRaw) throw new Error('CI_CODEMIE_AUTH_URL must be set in .env.test.local or env variables');
  const authBase = authUrlRaw.replace(/\/$/, '');
  const codeMieUrl = (overrides.codeMieUrl ?? process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');
  const profile: Record<string, string> = {
    name: profileName,
    provider: 'bearer-auth',
    authMethod: 'jwt',
    codeMieUrl: overrides.codeMieUrl ?? process.env.CI_CODEMIE_URL ?? '',
    baseUrl: `${codeMieUrl}/code-assistant-api`,
    model: overrides.model ?? process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
    authServerUrl: overrides.authServerUrl ?? authBase,
    authRealm: overrides.authRealm ?? 'codemie-prod',
  };
  if (overrides.jwtToken) profile.jwtToken = overrides.jwtToken;
  if (overrides.codeMieProject) profile.codeMieProject = overrides.codeMieProject;

  const config: Record<string, unknown> = { version: 2, activeProfile: profileName, profiles: { [profileName]: profile } };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');

  if (overrides.assistantId) {
    // Register assistant in the GLOBAL config (codemieHome/codemie-cli.config.json).
    // loadAssistantsByScope(GLOBAL) uses os.homedir() as baseDir for the agent
    // file-existence check, so the stub must live at ~/.claude/agents/<slug>.md.
    const assistant = {
      id: overrides.assistantId,
      name: 'CI Assistant',
      slug: CI_ASSISTANT_SLUG,
      registeredAt: new Date().toISOString(),
    };
    config.codemieAssistants = [assistant];
    writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');

    const agentDir = join(homedir(), '.claude', 'agents');
    mkdirSync(agentDir, { recursive: true });
    const agentFilePath = join(agentDir, `${CI_ASSISTANT_SLUG}.md`);
    writeFileSync(agentFilePath, `# CI Assistant\n`, 'utf-8');
    return agentFilePath;
  }
  return undefined;
}
