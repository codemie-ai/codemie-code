import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getCodemiePath } from '@/utils/paths.js';
import { ConfigLoader } from '@/utils/config.js';
import { CredentialStore } from '@/utils/security.js';

/** stdout is protocol JSON; anything human-readable goes to stderr. */
function note(message: string): void {
  process.stderr.write(`codemie codenotch: ${message}\n`);
}

/**
 * Budget data for the Codenotch plugin bridge, read from the same place as
 * the CodeMie statusline: `{baseUrl}/v1/analytics/budget_usage`, authenticated
 * with the CLI's own SSO credential store. A 60-second on-disk cache spares
 * the backend — Codenotch polls on its own cadence and reuses the cache entry.
 */

export interface BudgetRow {
  projectName: string;
  spent?: number;
  limit?: number;
  percent?: number;
  resetsAt?: string;
}

export interface CodenotchProfile {
  baseUrl: string;
  codeMieUrl: string;
  userEmail: string;
  provider?: string;
}

/** What the bridge can tell its caller went wrong. Maps to protocol exit codes. */
export type BudgetOutcome =
  | { kind: 'ok'; rows: BudgetRow[]; profile: CodenotchProfile }
  | { kind: 'not-configured'; reason: string }
  | { kind: 'not-authenticated'; reason: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'failed'; reason: string };

const CACHE_SCHEMA = 2;
const CACHE_TTL_MS = 60_000;
const CACHE_FILENAME = 'codenotch-budget-cache.json';

interface CacheFile {
  schema: number;
  ts: number;
  rows: unknown[];
}

function cachePath(): string {
  return join(getCodemiePath(), CACHE_FILENAME);
}

async function readCache(freshOnly: boolean): Promise<BudgetRow[] | null> {
  try {
    const raw = await readFile(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.schema !== CACHE_SCHEMA || !Array.isArray(parsed.rows)) return null;
    if (freshOnly && Date.now() - parsed.ts >= CACHE_TTL_MS) return null;
    // Rows are cached raw (as the API sent them) and re-parsed on every read,
    // so a cache written by another implementation of this bridge still reads.
    return parsed.rows.map(parseRow).filter((row): row is BudgetRow => row !== null);
  } catch {
    return null;
  }
}

async function writeCache(rows: unknown[]): Promise<void> {
  try {
    const payload: CacheFile = { schema: CACHE_SCHEMA, ts: Date.now(), rows };
    await writeFile(cachePath(), JSON.stringify(payload), 'utf-8');
  } catch {
    // A cache that cannot be written costs one extra request per minute, nothing else.
    note('budget cache is not writable; fetching on every poll');
  }
}

/** Reads the active profile the same way the statusline does. */
export async function loadCodenotchProfile(): Promise<CodenotchProfile | null> {
  let config;
  try {
    config = await ConfigLoader.loadMultiProviderConfig();
  } catch {
    return null;
  }
  const profile = config.profiles?.[config.activeProfile];
  const codeMieUrl = config.workspace?.codeMieUrl;
  const userEmail = config.userEmail;
  if (!profile?.baseUrl || !codeMieUrl || !userEmail) return null;
  return { baseUrl: profile.baseUrl, codeMieUrl, userEmail, provider: profile.provider };
}

function authHeader(cookies?: Record<string, string>, token?: string): Record<string, string> | null {
  if (cookies && Object.keys(cookies).length > 0) {
    return { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
  }
  if (token) return { authorization: `Bearer ${token}` };
  return null;
}

/** project_name of a row, normalised for comparison. */
function rowName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function parseRow(raw: unknown): BudgetRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const name = rowName(record.project_name);
  if (!name) return null;
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const spent = number(record.current_spending) ?? number(record.spend);
  const limit = number(record.max_budget) ?? number(record.budget_limit) ?? number(record.limit);
  let percent = number(record.total);
  if (percent === undefined && spent !== undefined && limit) {
    percent = (spent / limit) * 100;
  }
  return {
    projectName: name,
    spent,
    limit,
    percent,
    resetsAt: typeof record.budget_reset_at === 'string' ? record.budget_reset_at : undefined,
  };
}

function parseRows(body: string): { raw: unknown[]; parsed: BudgetRow[] } {
  const json = JSON.parse(body) as { data?: { rows?: unknown[] } };
  const rows = json?.data?.rows;
  if (!Array.isArray(rows)) throw new Error('budget_usage response did not contain a rows array');
  return { raw: rows, parsed: rows.map(parseRow).filter((row): row is BudgetRow => row !== null) };
}

/**
 * Budget rows for the current account, fresh cache first. A stale cache is
 * served when the network is unreachable; it is never served on an HTTP error.
 */
export async function getBudgetRows(): Promise<BudgetOutcome> {
  const profile = await loadCodenotchProfile();
  if (!profile) {
    return { kind: 'not-configured', reason: 'no CodeMie profile configured — run `codemie setup`' };
  }

  const fresh = await readCache(true);
  if (fresh) return { kind: 'ok', rows: fresh, profile };

  const store = CredentialStore.getInstance();
  const sso = await store.retrieveSSOCredentials(profile.codeMieUrl).catch(() => null);
  const jwt = sso ? null : await store.retrieveJWTCredentials(profile.codeMieUrl).catch(() => null);
  const auth = authHeader(sso?.cookies, jwt?.token);
  if (!auth) {
    return {
      kind: 'not-authenticated',
      reason: 'CodeMie credentials missing or unreadable — run `codemie profile login`',
    };
  }

  const url = `${profile.baseUrl.replace(/\/$/, '')}/v1/analytics/budget_usage`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', 'X-CodeMie-Client': 'codemie-cli', ...auth },
    });
  } catch {
    const stale = await readCache(false);
    if (stale) {
      note('network unreachable — serving stale budget cache');
      return { kind: 'ok', rows: stale, profile };
    }
    return { kind: 'failed', reason: `cannot reach ${url} and no cached budget data exists` };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: 'not-authenticated', reason: 'CodeMie session expired — run `codemie profile login`' };
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return {
      kind: 'rate-limited',
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
    };
  }
  if (!response.ok) {
    return { kind: 'failed', reason: `budget_usage returned HTTP ${response.status}` };
  }

  try {
    const { raw, parsed } = parseRows(await response.text());
    await mkdir(getCodemiePath(), { recursive: true });
    await writeCache(raw);
    return { kind: 'ok', rows: parsed, profile };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
