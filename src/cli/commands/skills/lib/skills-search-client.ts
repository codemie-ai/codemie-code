/**
 * HTTP search clients for `codemie skills find`.
 *
 * Two sources, both behind the same shape (`SearchSection`):
 *
 * - Internal (EPAM catalog): URL resolved from
 *   `CODEMIE_SKILLS_SEARCH_URL` env var, then `skillsSearchUrl` profile
 *   field. SSO cookies are attached so the future internal API can
 *   gate on identity. When the URL is unresolved we return
 *   `{ available: false, results: [] }` immediately (no HTTP call) so
 *   the friendly placeholder renders.
 * - Public (skills.sh): fixed `https://skills.sh/api/search`. No auth.
 *
 * Both functions are designed to never throw. Any error path returns
 * `{ available: false, results: [] }` and logs at debug level so that
 * one source going down never breaks the other.
 *
 * `resolveInternalContext` is exposed so the orchestrator can decide
 * once whether the internal section is configured (used both as a
 * "render placeholder vs no-results" hint and to short-circuit the
 * HTTP call) without paying the cost of a second `ConfigLoader.load`.
 */
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { stripControlChars } from './sanitize.js';

const PUBLIC_API_URL = 'https://skills.sh/api/search';
const INTERNAL_ENV_VAR = 'CODEMIE_SKILLS_SEARCH_URL';
const REQUEST_TIMEOUT_MS = 5_000;

export interface SkillSearchResult {
  name: string;
  slug: string;
  source: string;
  installs?: number;
}

export interface SearchSection {
  available: boolean;
  results: SkillSearchResult[];
}

/**
 * Pre-resolved internal endpoint plus the SSO/identification headers
 * that the internal HTTP call needs. `null` when no internal URL is
 * configured (env var unset and `skillsSearchUrl` empty).
 */
export interface InternalSearchContext {
  url: string;
  headers: Record<string, string>;
}

interface UpstreamSkill {
  name?: string;
  id?: string;
  source?: string;
  installs?: number;
}

interface UpstreamResponse {
  skills?: UpstreamSkill[];
}

export async function searchPublic(query: string, limit: number): Promise<SearchSection> {
  const url = `${PUBLIC_API_URL}?q=${encodeURIComponent(query)}&limit=${limit}`;
  return fetchSearchResults(url, {});
}

/**
 * Search the internal CodeMie catalog.
 *
 * If `context` is supplied, no `ConfigLoader.load` happens here — the
 * orchestrator already resolved the URL and headers. Falling back to
 * `null` keeps the function callable in isolation (e.g. ad-hoc scripts
 * or future call sites) at the cost of one config read.
 */
export async function searchInternal(
  query: string,
  limit: number,
  context?: InternalSearchContext | null
): Promise<SearchSection> {
  const ctx = context === undefined ? await resolveInternalContext() : context;
  if (!ctx) {
    logger.debug('[skills] No internal search URL configured; rendering placeholder');
    return { available: false, results: [] };
  }

  const url = appendQuery(ctx.url, query, limit);
  return fetchSearchResults(url, ctx.headers);
}

/**
 * Resolve the internal endpoint URL and SSO/identification headers in a
 * single config load. Returns `null` when no URL is configured (env var
 * unset and `skillsSearchUrl` profile field empty).
 */
export async function resolveInternalContext(): Promise<InternalSearchContext | null> {
  const envOverride = process.env[INTERNAL_ENV_VAR];
  if (envOverride && envOverride.trim().length > 0) {
    return {
      url: envOverride.trim(),
      headers: await buildInternalHeaders(),
    };
  }

  try {
    const config = await ConfigLoader.load();
    const fromConfig = config.skillsSearchUrl;
    if (!fromConfig || fromConfig.trim().length === 0) {
      return null;
    }
    return {
      url: fromConfig.trim(),
      headers: await buildInternalHeaders(config.codeMieUrl || config.baseUrl),
    };
  } catch (error) {
    logger.debug('[skills] Failed to resolve internal search context', error);
    return null;
  }
}

async function buildInternalHeaders(ssoUrl?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-CodeMie-Client': 'codemie-cli',
  };

  let resolvedSsoUrl = ssoUrl;
  if (!resolvedSsoUrl) {
    try {
      const config = await ConfigLoader.load();
      resolvedSsoUrl = config.codeMieUrl || config.baseUrl;
    } catch {
      // fall through; we just won't have cookies
    }
  }
  if (!resolvedSsoUrl) return headers;

  try {
    const { CodeMieSSO } = await import('@/providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(resolvedSsoUrl);
    if (credentials?.cookies) {
      const cookieHeader = Object.entries(credentials.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
    }
  } catch (error) {
    logger.debug('[skills] Failed to attach SSO cookies for internal search', error);
  }
  return headers;
}

function appendQuery(baseUrl: string, query: string, limit: number): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}q=${encodeURIComponent(query)}&limit=${limit}`;
}

async function fetchSearchResults(
  url: string,
  headers: Record<string, string>
): Promise<SearchSection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      logger.debug(
        `[skills] Search request returned HTTP ${response.status} ${response.statusText}: ${url}`
      );
      return { available: false, results: [] };
    }
    const data = (await response.json().catch(() => ({}))) as UpstreamResponse;
    const skills = Array.isArray(data.skills) ? data.skills : [];
    const results: SkillSearchResult[] = skills
      .map((raw) => ({
        name: stripControlChars(raw.name ?? ''),
        slug: stripControlChars(raw.id ?? ''),
        source: stripControlChars(raw.source ?? ''),
        installs: typeof raw.installs === 'number' ? raw.installs : undefined,
      }))
      .filter((entry) => entry.slug.length > 0);

    return { available: true, results };
  } catch (error) {
    logger.debug(`[skills] Search request failed for ${url}`, error);
    return { available: false, results: [] };
  } finally {
    clearTimeout(timer);
  }
}
