import inquirer from 'inquirer';
import chalk from 'chalk';
import { HTTPClient } from './base/http-client.js';
import { ProviderName } from './types.js';
import { ConfigurationError } from '../../utils/errors.js';
import { isTlsVerificationEnabled } from '../../utils/system-proxy.js';
import type { SSOAuth, SSOLoginResult } from '../plugins/sso/auth/index.js';
import { authMaterial } from '../plugins/sso/auth/material.js';
import { buildCookieHeader } from '../plugins/sso/auth/selection.js';

export const DEFAULT_CODEMIE_BASE_URL = 'https://codemie.lab.epam.com';

export interface CodeMieUserInfo {
  userId: string;
  name: string;
  username: string;
  /** Authenticated email as the backend reports it; `username` is a different value. */
  email?: string;
  isAdmin: boolean;
  applications: string[];
  applications_admin: string[];
  applicationsAdmin?: string[];
  picture: string;
  knowledgeBases: string[];
  userType?: string;
}

export function ensureApiBase(rawUrl: string): string {
  let base = rawUrl.replace(/\/$/, '');
  if (!/\/code-assistant-api(\/|$)/i.test(base)) {
    // Local dev backends (localhost / 127.0.0.1) serve directly at /v1/...
    // without the nginx-stripped /code-assistant-api prefix.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
    if (!isLocal) {
      base = `${base}/code-assistant-api`;
    }
  }
  return base;
}

/** Inverse of ensureApiBase(): the CodeMie URL a `.../code-assistant-api` API base belongs to. */
export function codeMieUrlFromApiBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '').replace(/\/code-assistant-api(\/.*)?$/i, '');
}

export function buildAuthHeaders(auth: Record<string, string> | string): Record<string, string> {
  const cliVersion = process.env.CODEMIE_CLI_VERSION || 'unknown';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `codemie-cli/${cliVersion}`,
    'X-CodeMie-CLI': `codemie-cli/${cliVersion}`,
    'X-CodeMie-Client': 'codemie-cli'
  };

  if (typeof auth === 'string') {
    headers.authorization = `Bearer ${auth}`;
  } else {
    headers.cookie = buildCookieHeader(auth);
  }

  return headers;
}

export async function promptForCodeMieUrl(
  defaultUrl: string = DEFAULT_CODEMIE_BASE_URL,
  message: string = 'CodeMie organization URL:'
): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'codeMieUrl',
      message,
      default: defaultUrl,
      validate: (input: string) => {
        if (!input.trim()) {
          return 'CodeMie URL is required';
        }
        if (!input.startsWith('http://') && !input.startsWith('https://')) {
          return 'Please enter a valid URL starting with http:// or https://';
        }
        return true;
      }
    }
  ]);

  return answers.codeMieUrl.trim();
}

export async function authenticateWithCodeMie(
  codeMieUrl: string,
  timeout: number = 120000
): Promise<SSOLoginResult> {
  const { CodeMieSSO } = await import('../plugins/sso/sso.auth.js');
  const sso = new CodeMieSSO();
  return sso.authenticate({
    codeMieUrl,
    timeout
  });
}

/**
 * Minimal profile shape needed to resolve the CodeMie platform URL.
 * `baseUrl` is the profile URL (P); `codeMieUrl` is the workspace URL (W).
 */
export interface PlatformUrlSource {
  provider?: string;
  baseUrl?: string;
  codeMieUrl?: string;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function isCodeMiePlatformProvider(provider: string | undefined): boolean {
  return provider === ProviderName.AI_RUN_SSO || provider === ProviderName.BEARER_AUTH;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Ordered platform URL candidates: profile baseUrl (P) first, workspace
 * codeMieUrl (W) as fallback. Only CodeMie providers (ai-run-sso, bearer-auth)
 * treat baseUrl as the platform; every other provider uses W only, since its
 * baseUrl is a vendor endpoint. Deduped by origin because the credential key is
 * host-only, so a same-origin retry would return the identical result.
 */
export function getPlatformUrlCandidates(src: PlatformUrlSource): string[] {
  const isCodeMieProvider = isCodeMiePlatformProvider(src.provider);
  const raw = isCodeMieProvider ? [src.baseUrl, src.codeMieUrl] : [src.codeMieUrl];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const url of raw) {
    if (!url) continue;
    const origin = originOf(url);
    if (seen.has(origin)) continue;
    seen.add(origin);
    candidates.push(url);
  }
  return candidates;
}

export function getPlatformUrl(src: PlatformUrlSource): string | undefined {
  return getPlatformUrlCandidates(src)[0];
}

export function platformSourceFromEnv(env: NodeJS.ProcessEnv): PlatformUrlSource {
  // CODEMIE_BASE_URL is intentionally never read: the proxy rewrites it to a
  // localhost URL before the agent starts. CODEMIE_PROFILE_CONFIG keeps the original.
  let provider: string | undefined;
  let baseUrl: string | undefined;
  if (env.CODEMIE_PROFILE_CONFIG) {
    try {
      const parsed = JSON.parse(env.CODEMIE_PROFILE_CONFIG) as { provider?: unknown; baseUrl?: unknown };
      provider = typeof parsed.provider === 'string' ? parsed.provider : undefined;
      baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined;
    } catch {
      // Malformed profile config: fall back to CODEMIE_URL only
    }
  }
  return { provider, baseUrl, codeMieUrl: env.CODEMIE_URL };
}

export function getPlatformUrlCandidatesFromEnv(env: NodeJS.ProcessEnv): string[] {
  return getPlatformUrlCandidates(platformSourceFromEnv(env));
}

export function getPlatformUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return getPlatformUrlCandidatesFromEnv(env)[0];
}

/**
 * Origin of the profile's own API host, or undefined when it has none to enforce: a non-CodeMie
 * provider, no baseUrl, or a loopback baseUrl (inside an agent session it may be the local proxy).
 */
export function getProfileOrigin(src: PlatformUrlSource): string | undefined {
  return isCodeMiePlatformProvider(src.provider) && src.baseUrl && !isLoopbackUrl(src.baseUrl)
    ? originOf(src.baseUrl)
    : undefined;
}

/**
 * Platform source for analytics/hook flows: the active profile (provider +
 * baseUrl from CODEMIE_PROFILE_CONFIG) with `ssoUrl` (the workspace
 * CODEMIE_URL) as fallback. Explicit `provider`/`baseUrl` win over the env.
 */
export function getAnalyticsPlatformSource(
  ssoUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  overrides: { provider?: string; baseUrl?: string } = {}
): PlatformUrlSource {
  const fromEnv = platformSourceFromEnv(env);
  return {
    provider: overrides.provider ?? fromEnv.provider,
    baseUrl: overrides.baseUrl ?? fromEnv.baseUrl,
    codeMieUrl: ssoUrl ?? fromEnv.codeMieUrl,
  };
}

/* eslint-disable no-redeclare */
export interface UserInfoRequestOptions {
  /** Request limits; the launch-time project list uses short ones. */
  timeout?: number;
  maxRetries?: number;
  /** false: a 3xx answer fails the lookup instead of being followed (the cookies never leave the first origin). */
  followRedirects?: boolean;
  /** Unattended callers only need `email`; skip the interactive login's `applications*` shape check. */
  emailOnly?: boolean;
}

export function fetchCodeMieUserInfo(
  apiUrl: string,
  cookies: Record<string, string>,
  options?: UserInfoRequestOptions
): Promise<CodeMieUserInfo>;
export function fetchCodeMieUserInfo(
  apiUrl: string,
  jwtToken: string,
  options?: UserInfoRequestOptions
): Promise<CodeMieUserInfo>;
export function fetchCodeMieUserInfo(
  apiUrl: string,
  auth: Record<string, string> | string,
  options?: UserInfoRequestOptions
): Promise<CodeMieUserInfo>;
export async function fetchCodeMieUserInfo(
  apiUrl: string,
  auth: Record<string, string> | string,
  options: UserInfoRequestOptions = {}
): Promise<CodeMieUserInfo> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}/v1/user`;

  const client = new HTTPClient({
    timeout: options.timeout ?? 10000,
    maxRetries: options.maxRetries ?? 3,
    followRedirects: options.followRedirects ?? true,
    // Enterprise on-premises CodeMie deployments commonly use self-signed certificates.
    rejectUnauthorized: isTlsVerificationEnabled()
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new ConfigurationError('Authentication failed - invalid or expired credentials');
    }
    throw new ConfigurationError(`Failed to fetch user info: ${response.statusCode} ${response.statusMessage}`);
  }

  const userInfo = JSON.parse(response.data) as CodeMieUserInfo;

  if (options.emailOnly && userInfo && typeof userInfo === 'object') {
    return { ...userInfo, applications: userInfo.applications ?? [], applications_admin: userInfo.applications_admin ?? [] };
  }

  if (!Array.isArray(userInfo.applications_admin) && Array.isArray(userInfo.applicationsAdmin)) {
    userInfo.applications_admin = userInfo.applicationsAdmin;
  }

  if (!userInfo || !Array.isArray(userInfo.applications) || !Array.isArray(userInfo.applications_admin)) {
    throw new ConfigurationError('Invalid user info response: missing applications arrays');
  }

  return userInfo;
}

/** Accessible projects of the account (member + admin), deduped and sorted case-insensitively. */
export function accountProjects(userInfo: CodeMieUserInfo): string[] {
  const all = [...new Set([...(userInfo.applications || []), ...(userInfo.applications_admin || [])])];
  return all.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function selectCodeMieProject(
  auth: SSOAuth
): Promise<{ project: string; userEmail: string }> {
  if (!auth.apiUrl) {
    throw new ConfigurationError('API URL not provided for project selection');
  }
  const userInfo = await fetchCodeMieUserInfo(auth.apiUrl, authMaterial(auth));

  const allProjects = accountProjects(userInfo);

  if (allProjects.length === 0) {
    throw new ConfigurationError('No projects found for your account. Please contact your administrator.');
  }

  const sortedProjects = allProjects;

  let project: string;
  if (sortedProjects.length === 1) {
    project = sortedProjects[0];
    console.log(chalk.green(`✓ Auto-selected project: ${chalk.bold(project)}`));
  } else {
    console.log(chalk.dim(`Found ${sortedProjects.length} accessible project(s)`));

    const projectAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'project',
        message: 'Select your project:',
        choices: sortedProjects.map(p => ({
          name: p,
          value: p
        })),
        pageSize: 15
      }
    ]);

    project = projectAnswers.project;
    console.log(chalk.green(`✓ Selected project: ${chalk.bold(project)}`));
  }

  return { project, userEmail: userInfo.username };
}

/** Credentials for listing a profile's projects, bound to the host they were issued for. */
export type ProjectListAuth = SSOAuth;

/**
 * Credentials and target for listing a profile's CodeMie projects at launch.
 * The list is fetched only from the host the credentials were issued for:
 * - ai-run-sso: stored credentials for the profile's own `baseUrl` (no shared-URL
 *   fallback), sent to `ensureApiBase(baseUrl)`;
 * - bearer-auth (JWT): the profile's token, sent to `ensureApiBase(baseUrl)`;
 * - subscription providers: stored credentials for the resolved CodeMie URL
 *   (never the vendor `baseUrl`), sent to the host they were issued for.
 * Returns undefined when no usable credential exists for that host.
 */
export async function resolveProjectListAuth(config: {
  provider?: string;
  baseUrl?: string;
  codeMieUrl?: string;
  jwtToken?: string;
}): Promise<ProjectListAuth | undefined> {
  // Loaded lazily: the resolver imports this module statically.
  const { resolveSSOAuth, resolveSSOAuthForUrl, explicitJwtAuth } = await import('../plugins/sso/auth/index.js');

  if (isCodeMiePlatformProvider(config.provider)) {
    if (!config.baseUrl || isLoopbackUrl(config.baseUrl)) return undefined;
    const apiUrl = ensureApiBase(config.baseUrl);
    if (config.provider === ProviderName.BEARER_AUTH) {
      return config.jwtToken ? explicitJwtAuth(config.jwtToken, apiUrl) : undefined;
    }
    const auth = await resolveSSOAuth({ provider: config.provider, baseUrl: config.baseUrl });
    return auth ? { ...auth, apiUrl } : undefined;
  }

  if (!config.codeMieUrl) return undefined;
  const auth = await resolveSSOAuthForUrl(config.codeMieUrl);
  if (!auth) return undefined;
  // The credentials are looked up by this profile's own resolved CodeMie URL, and are sent to the
  // API they were issued with (their apiUrl, else that URL). HTTPClient drops them on a
  // cross-origin redirect.
  return { ...auth, apiUrl: ensureApiBase(auth.apiUrl || config.codeMieUrl) };
}
