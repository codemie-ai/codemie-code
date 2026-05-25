#!/usr/bin/env node
/**
 * CodeMie Analytics CLI
 * Generic, flexible Node.js script for querying CodeMie and LiteLLM APIs.
 *
 * Auth mirrors the `codemie assistants chat` flow exactly:
 *   1. Load config from ~/.codemie/codemie-cli.config.json (active profile)
 *   2. Extract codeMieUrl (or baseUrl) from profile
 *   3. Normalize URL to protocol://host
 *   4. Look up per-URL SSO credentials from encrypted file
 *   5. Fall back to global SSO credentials (verify apiUrl matches)
 *   6. Check credential expiry
 *   7. Send cookies as Cookie header on every API request
 *
 * Usage:
 *   node analytics-cli.js <command> [options]
 *
 * Commands:
 *   summaries                      Overall token/cost/user summary
 *   leaderboard                    AI champions leaderboard (entries, with filters)
 *   leaderboard-summary            Leaderboard KPI summary (totals, tier counts)
 *   leaderboard-user <id|email>    Single user leaderboard profile with dimension breakdown
 *   leaderboard-tiers              Tier distribution (name, count, %)
 *   leaderboard-dimensions         Average scores per dimension (D1–D6)
 *   leaderboard-top <limit>        Top N performers by total score (default 10)
 *   leaderboard-scores             Score histogram in 10-point bins
 *   leaderboard-framework          Static metadata: dimensions, tiers, intents, scoring
 *   leaderboard-snapshots          List computation snapshots
 *   leaderboard-seasons            Available seasonal periods (monthly/quarterly)
 *   cli-insights                   CLI usage: agents, repos, tools, errors, top-performers
 *   cli-insights-users             CLI user classification & top spenders
 *   cli-insights-user <name>       Detailed CLI profile for a single user
 *   cli-insights-projects          CLI project classification & top projects by cost
 *   cli-insights-patterns          Weekday + hourly + session-depth usage patterns
 *   users                          List users + activity
 *   projects-spending              Per-project spending
 *   projects-activity              Per-project activity time-series
 *   llms-usage                     LLM model usage breakdown
 *   tools-usage                    Tool usage analytics
 *   workflows                      Workflow execution analytics
 *   agents-usage                   Agent execution analytics
 *   embeddings-usage               Embedding model usage
 *   assistants-chats               Chat assistant conversations
 *   webhooks-usage                 Webhook invocation analytics
 *   mcp-servers                    MCP server usage
 *   mcp-servers-by-users           MCP server usage broken down by user
 *   power-users                    Power user analytics
 *   knowledge-sharing              Knowledge sharing metrics
 *   top-agents                     Top agents by usage
 *   top-workflows                  Top workflows by usage
 *   marketplace                    Assets published to marketplace
 *   budget                         Budget limits (soft + hard)
 *   spending                       Current user spending & budget (personal)
 *   spending-by-users              Per-user spending breakdown (platform + cli)
 *   engagement                     Weekly engagement histogram
 *   litellm-customer [user_id]     LiteLLM customer/info (needs LITELLM_URL + LITELLM_KEY)
 *   litellm-spend                  LiteLLM /spend/logs (needs LITELLM_URL + LITELLM_KEY)
 *   litellm-keys                   LiteLLM /key/info for all virtual keys
 *   custom <path>                  Fallback for unlisted endpoints — prefer a named command if one exists
 *   enrich-csv <file>              Read CSV/Excel, lookup each user in LiteLLM, output enriched data
 *
 * Filters (most commands):
 *   --time-period  last_hour | last_6_hours | last_24_hours | last_7_days | last_30_days | last_60_days | last_year
 *   --start-date   ISO8601 e.g. 2024-01-01T00:00:00
 *   --end-date     ISO8601
 *   --users        comma-separated usernames
 *   --projects     comma-separated project names
 *   --page         page number (default 1)
 *   --per-page     results per page (default 50)
 *   --output       json | table | csv (default json)
 *   --pretty       pretty-print JSON (flag)
 *
 * Leaderboard-specific filters:
 *   --view         current | monthly | quarterly (default current)
 *   --season-key   e.g. 2026-03 or 2026-Q1
 *   --snapshot-id  explicit snapshot ID
 *   --tier         pioneer | expert | advanced | practitioner | newcomer
 *   --intent       cli_focused | platform_focused | hybrid | sdlc_unicorn
 *   --search       partial name/email search
 *   --sort-by      rank | total_score | user_name | tier_level (default rank)
 *   --sort-order   asc | desc (default asc)
 *   --limit        max entries for top-performers (default 10, max 50)
 */

import { createDecipheriv, createHash } from 'crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, hostname, platform, arch } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opts[key] = val;
    } else {
      opts._.push(argv[i]);
    }
  }
  return opts;
}

const opts = parseArgs(args.slice(1));

// ─── Constants ───────────────────────────────────────────────────────────────

const CODEMIE_HOME = process.env.CODEMIE_HOME || join(homedir(), '.codemie');
const CREDENTIALS_DIR = join(CODEMIE_HOME, 'credentials');
const GLOBAL_SSO_FILE = join(CODEMIE_HOME, 'sso-credentials.enc');
const CONFIG_FILE = join(CODEMIE_HOME, 'codemie-cli.config.json');

// ─── Encryption (matches CredentialStore in codemie-code exactly) ────────────

function getAESKey() {
  const machineId = hostname() + platform() + arch();
  const encryptionKeyHex = createHash('sha256').update(machineId).digest('hex');
  return createHash('sha256').update(encryptionKeyHex).digest();
}

function decrypt(text) {
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return null;
  const ivHex = text.slice(0, colonIndex);
  const encryptedHex = text.slice(colonIndex + 1);
  const iv = Buffer.from(ivHex, 'hex');
  const key = getAESKey();
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function readEncryptedFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf8');
    const json = decrypt(text);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

// ─── URL Normalization ──────────────────────────────────────────────────────

function normalizeToBase(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function getUrlStorageKey(baseUrl) {
  const normalized = baseUrl.replace(/\/$/, '').toLowerCase();
  return `sso-${createHash('sha256').update(normalized).digest('hex')}`;
}

// ─── Security helpers ───────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = /\b(Bearer\s+\S+|sk-[a-zA-Z0-9_-]{20,}|token[=:]\S+|cookie[=:]\S+|password[=:]\S+|api[_-]?key[=:]\S+)\b/gi;

function sanitizeErrorText(text) {
  if (!text) return '';
  return text.replace(SENSITIVE_PATTERNS, '[REDACTED]');
}

const REDACT_KEYS = new Set(['token', 'key', 'api_key', 'secret', 'master_key', 'hashed_token']);

function redactSensitiveFields(data) {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(redactSensitiveFields);
  if (typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (REDACT_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
        out[k] = v.slice(0, 4) + '...' + v.slice(-4);
      } else {
        out[k] = redactSensitiveFields(v);
      }
    }
    return out;
  }
  return data;
}

// ─── Config Loading ──────────────────────────────────────────────────────────

function loadConfig() {
  const localConfig = join(process.cwd(), '.codemie', 'codemie-cli.config.json');
  const configs = [];
  if (existsSync(CONFIG_FILE)) {
    try { configs.push(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
  }
  if (existsSync(localConfig)) {
    try { configs.push(JSON.parse(readFileSync(localConfig, 'utf8'))); } catch {}
  }
  if (configs.length === 0) return null;
  return configs[configs.length - 1] || configs[0];
}

function getActiveProfile(config) {
  if (!config) return null;
  if (config.version === 2 && config.profiles) {
    const name = config.activeProfile || Object.keys(config.profiles)[0];
    return config.profiles[name] || null;
  }
  return config;
}

// ─── Credential Resolution ──────────────────────────────────────────────────

function resolveAuth() {
  const SENTINEL_KEYS = new Set(['sso-provided', 'proxy-handled']);
  if (process.env.CODEMIE_API_KEY && !SENTINEL_KEYS.has(process.env.CODEMIE_API_KEY) && process.env.CODEMIE_URL) {
    const baseUrl = process.env.CODEMIE_URL.replace(/\/$/, '');
    const apiUrl = baseUrl.includes('/code-assistant-api') ? baseUrl : `${baseUrl}/code-assistant-api`;
    return { type: 'bearer', token: process.env.CODEMIE_API_KEY, baseUrl: apiUrl };
  }

  const config = loadConfig();
  const profile = getActiveProfile(config);
  const codeMieUrl = process.env.CODEMIE_URL || profile?.codeMieUrl || profile?.baseUrl;
  if (!codeMieUrl) return null;

  const normalizedBase = normalizeToBase(codeMieUrl);
  const storageKey = getUrlStorageKey(normalizedBase);
  const perUrlFile = join(CREDENTIALS_DIR, `${storageKey}.enc`);
  let credentials = readEncryptedFile(perUrlFile);

  if (!credentials) {
    credentials = readEncryptedFile(GLOBAL_SSO_FILE);
    if (credentials && credentials.apiUrl) {
      const credentialBase = normalizeToBase(credentials.apiUrl);
      if (credentialBase !== normalizedBase) credentials = null;
    }
  }

  if (!credentials || !credentials.cookies || !credentials.apiUrl) {
    if (profile?.apiKey) {
      const apiUrl = codeMieUrl.includes('/code-assistant-api')
        ? codeMieUrl
        : `${codeMieUrl}/code-assistant-api`;
      return { type: 'bearer', token: profile.apiKey, baseUrl: apiUrl };
    }
    return null;
  }

  if (credentials.expiresAt && Date.now() > credentials.expiresAt) {
    process.stderr.write('[analytics-cli] SSO credentials expired. Run `codemie setup` to re-authenticate.\n');
    return null;
  }

  const cookieStr = Object.entries(credentials.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return { type: 'cookie', cookie: cookieStr, baseUrl: credentials.apiUrl };
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

async function apiFetch(url, { method = 'GET', body, auth, extraHeaders = {} } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-CodeMie-Client': 'codemie-cli',
    ...extraHeaders,
  };

  if (auth?.type === 'cookie') {
    headers['Cookie'] = auth.cookie;
  } else if (auth?.type === 'bearer') {
    headers['Authorization'] = `Bearer ${auth.token}`;
  }

  const fetchOpts = { method, headers };
  if (body) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Strip the URL to avoid leaking query params that may contain tokens
    const safeUrl = url.split('?')[0];
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${safeUrl}\n${sanitizeErrorText(text)}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ─── CodeMie API helpers ─────────────────────────────────────────────────────

function buildQuery(opts) {
  const params = new URLSearchParams();
  if (opts.timePeriod) params.set('time_period', opts.timePeriod);
  if (opts.startDate) params.set('start_date', opts.startDate);
  if (opts.endDate) params.set('end_date', opts.endDate);
  if (opts.users) params.set('users', opts.users);
  if (opts.projects) params.set('projects', opts.projects);
  if (opts.page) params.set('page', opts.page);
  if (opts.perPage) params.set('per_page', opts.perPage);
  return params.toString() ? `?${params}` : '';
}

function buildLeaderboardQuery(opts) {
  const params = new URLSearchParams();
  if (opts.snapshotId) params.set('snapshot_id', opts.snapshotId);
  if (opts.view) params.set('view', opts.view);
  if (opts.seasonKey) params.set('season_key', opts.seasonKey);
  if (opts.tier) params.set('tier', opts.tier);
  if (opts.intent) params.set('intent', opts.intent);
  if (opts.search) params.set('search', opts.search);
  if (opts.sortBy) params.set('sort_by', opts.sortBy);
  if (opts.sortOrder) params.set('sort_order', opts.sortOrder);
  if (opts.page) params.set('page', opts.page);
  if (opts.perPage) params.set('per_page', opts.perPage);
  if (opts.limit) params.set('limit', opts.limit);
  return params.toString() ? `?${params}` : '';
}

async function analyticsGet(auth, path, opts) {
  const qs = buildQuery(opts);
  const url = `${auth.baseUrl}${path}${qs}`;
  return apiFetch(url, { auth });
}

async function analyticsLeaderboardGet(auth, path, opts) {
  const qs = buildLeaderboardQuery(opts);
  const url = `${auth.baseUrl}${path}${qs}`;
  return apiFetch(url, { auth });
}

async function analyticsPost(auth, path, bodyExtra = {}, opts) {
  const body = {};
  if (opts.timePeriod) body.time_period = opts.timePeriod;
  if (opts.startDate) body.start_date = opts.startDate;
  if (opts.endDate) body.end_date = opts.endDate;
  if (opts.users) body.users = opts.users.split(',');
  if (opts.projects) body.projects = opts.projects.split(',');
  if (opts.page) body.page = parseInt(opts.page);
  if (opts.perPage) body.per_page = parseInt(opts.perPage);
  Object.assign(body, bodyExtra);
  const url = `${auth.baseUrl}${path}`;
  return apiFetch(url, { method: 'POST', body, auth });
}

// ─── LiteLLM helpers ─────────────────────────────────────────────────────────

function getLiteLLMAuth() {
  const url = process.env.LITELLM_URL;
  const key = process.env.LITELLM_KEY;
  if (!url || !key) {
    throw new Error('LITELLM_URL and LITELLM_KEY env vars are required for LiteLLM commands');
  }
  return { url: url.replace(/\/$/, ''), key };
}

async function litellmFetch(llm, path, { method = 'GET', body, params } = {}) {
  let url = `${llm.url}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  }
  return apiFetch(url, {
    method,
    body,
    auth: { type: 'bearer', token: llm.key },
  });
}

// ─── CSV/Excel parsing ───────────────────────────────────────────────────────

async function parseInputFile(filePath) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const ext = resolvedPath.split('.').pop().toLowerCase();

  if (ext === 'csv') {
    const text = readFileSync(resolvedPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
    });
  }

  if (ext === 'xlsx' || ext === 'xls') {
    try {
      const XLSX = await import('xlsx').catch(() => null);
      if (!XLSX) throw new Error('xlsx package not installed. Run: npm install -g xlsx');
      const workbook = XLSX.default.readFile(resolvedPath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      return XLSX.default.utils.sheet_to_json(sheet);
    } catch (e) {
      throw new Error(`Cannot parse Excel file: ${e.message}`);
    }
  }

  throw new Error(`Unsupported file type: .${ext}. Use .csv, .xlsx, or .xls`);
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function output(data) {
  if (opts.save) {
    const filePath = resolve(opts.save);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`✓ Saved → ${filePath}`);
    return;
  }

  const fmt = opts.output || 'json';
  if (fmt === 'json' || !fmt) {
    if (opts.pretty) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify(data));
    }
  } else if (fmt === 'table') {
    printTable(data);
  } else if (fmt === 'csv') {
    printCSV(data);
  }
}

function printTable(data) {
  const rows = Array.isArray(data) ? data : (data?.data || data?.items || [data]);
  if (!rows.length) { console.log('(no data)'); return; }
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => String(r[k] ?? '').slice(0, 40).length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
  rows.forEach(row => {
    console.log(keys.map((k, i) => String(row[k] ?? '').slice(0, 40).padEnd(widths[i])).join(' | '));
  });
}

function printCSV(data) {
  const rows = Array.isArray(data) ? data : (data?.data || data?.items || [data]);
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  console.log(keys.join(','));
  rows.forEach(row => console.log(keys.map(k => JSON.stringify(row[k] ?? '')).join(',')));
}

// ─── Commands ────────────────────────────────────────────────────────────────

// --- Summaries ---

async function cmdSummaries(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/summaries', opts);
  output(data);
}

// --- Leaderboard family (uses /v1/analytics/leaderboard/*) ---

async function cmdLeaderboard(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/entries', opts);
  output(data);
}

async function cmdLeaderboardSummary(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/summary', opts);
  output(data);
}

async function cmdLeaderboardUser(auth) {
  const userId = opts._[0];
  if (!userId) throw new Error('Usage: leaderboard-user <user_id_or_email>');
  const qs = buildLeaderboardQuery(opts);
  const url = `${auth.baseUrl}/v1/analytics/leaderboard/user/${encodeURIComponent(userId)}${qs}`;
  const data = await apiFetch(url, { auth });
  output(data);
}

async function cmdLeaderboardTiers(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/tiers', opts);
  output(data);
}

async function cmdLeaderboardDimensions(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/dimensions', opts);
  output(data);
}

async function cmdLeaderboardTop(auth) {
  if (!opts.limit) opts.limit = opts._[0] || '10';
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/top-performers', opts);
  output(data);
}

async function cmdLeaderboardScores(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/scores', opts);
  output(data);
}

async function cmdLeaderboardFramework(auth) {
  const url = `${auth.baseUrl}/v1/analytics/leaderboard/framework`;
  const data = await apiFetch(url, { auth });
  output(data);
}

async function cmdLeaderboardSnapshots(auth) {
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/snapshots', opts);
  output(data);
}

async function cmdLeaderboardSeasons(auth) {
  if (!opts.view) throw new Error('Usage: leaderboard-seasons --view monthly|quarterly');
  const data = await analyticsLeaderboardGet(auth, '/v1/analytics/leaderboard/seasons', opts);
  output(data);
}

// --- CLI Insights family ---

async function cmdCliInsights(auth) {
  const [summary, agents, llms, users, errors, repos, tools, topVersions, topEndpoints] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/cli-summary', opts),
    analyticsGet(auth, '/v1/analytics/cli-agents', opts),
    analyticsGet(auth, '/v1/analytics/cli-llms', opts),
    analyticsGet(auth, '/v1/analytics/cli-users', opts),
    analyticsGet(auth, '/v1/analytics/cli-errors', opts),
    analyticsGet(auth, '/v1/analytics/cli-repositories', opts),
    analyticsGet(auth, '/v1/analytics/cli-tools', opts),
    analyticsGet(auth, '/v1/analytics/cli-top-versions', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-top-proxy-endpoints', opts).catch(() => null),
  ]);
  output({ summary, agents, llms, users, errors, repos, tools, topVersions, topEndpoints });
}

async function cmdCliInsightsUsers(auth) {
  const [classification, topBySpend, topSpenders, userList] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/cli-insights-user-classification', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-top-users-by-cost', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-top-spenders', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-users', opts).catch(() => null),
  ]);
  output({ classification, topBySpend, topSpenders, userList });
}

async function cmdCliInsightsUser(auth) {
  const userName = opts._[0] || opts.userName;
  if (!userName) throw new Error('Usage: cli-insights-user <user_name> [--user-id <id>]');
  const userQs = new URLSearchParams();
  userQs.set('user_name', userName);
  if (opts.userId) userQs.set('user_id', opts.userId);
  // Add time filters
  if (opts.timePeriod) userQs.set('time_period', opts.timePeriod);
  if (opts.startDate) userQs.set('start_date', opts.startDate);
  if (opts.endDate) userQs.set('end_date', opts.endDate);
  const qs = userQs.toString() ? `?${userQs}` : '';

  const base = auth.baseUrl;
  const [detail, keyMetrics, tools, models, workflowIntent, classDetail, categoryBreakdown, repos] = await Promise.all([
    apiFetch(`${base}/v1/analytics/cli-insights-user-detail${qs}`, { auth }),
    apiFetch(`${base}/v1/analytics/cli-insights-user-key-metrics${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-tools${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-models${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-workflow-intent${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-classification-detail${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-category-breakdown${qs}`, { auth }).catch(() => null),
    apiFetch(`${base}/v1/analytics/cli-insights-user-repositories${qs}`, { auth }).catch(() => null),
  ]);
  output({ detail, keyMetrics, tools, models, workflowIntent, classDetail, categoryBreakdown, repos });
}

async function cmdCliInsightsProjects(auth) {
  const [classification, topBySpend] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/cli-insights-project-classification', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-top-projects-by-cost', opts).catch(() => null),
  ]);
  output({ classification, topBySpend });
}

async function cmdCliInsightsPatterns(auth) {
  const [weekday, hourly, sessionDepth] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/cli-insights-weekday-pattern', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-hourly-usage', opts).catch(() => null),
    analyticsGet(auth, '/v1/analytics/cli-insights-session-depth', opts).catch(() => null),
  ]);
  output({ weekday, hourly, sessionDepth });
}

// --- Standard analytics ---

async function cmdUsers(auth) {
  const [users, activity, uniqueDaily] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/users', opts),
    analyticsGet(auth, '/v1/analytics/users-activity', opts),
    analyticsGet(auth, '/v1/analytics/users-unique-daily', opts),
  ]);
  output({ users, activity, uniqueDaily });
}

async function cmdProjectsSpending(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/projects-spending', opts);
  output(data);
}

async function cmdLlmsUsage(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/llms-usage', opts);
  output(data);
}

async function cmdToolsUsage(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/tools-usage', opts);
  output(data);
}

async function cmdWorkflows(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/workflows', opts);
  output(data);
}

async function cmdBudget(auth) {
  const [soft, hard] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/budget-soft-limit', opts),
    analyticsGet(auth, '/v1/analytics/budget-hard-limit', opts),
  ]);
  output({ soft, hard });
}

async function cmdSpending(auth) {
  const [spending, budgetUsage] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/spending', opts),
    analyticsGet(auth, '/v1/analytics/budget_usage', opts).catch(() => null),
  ]);
  output({ spending, budgetUsage });
}

async function cmdSpendingByUsers(auth) {
  const [platform, cli] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/spending/by-users/platform', opts),
    analyticsGet(auth, '/v1/analytics/spending/by-users/cli', opts),
  ]);
  output({ platform, cli });
}

async function cmdEngagement(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/engagement/weekly-histogram', opts);
  output(data);
}

async function cmdProjectsActivity(auth) {
  const [activity, uniqueDaily] = await Promise.all([
    analyticsGet(auth, '/v1/analytics/projects-activity', opts),
    analyticsGet(auth, '/v1/analytics/projects-unique-daily', opts).catch(() => null),
  ]);
  output({ activity, uniqueDaily });
}

async function cmdAgentsUsage(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/agents-usage', opts);
  output(data);
}

async function cmdEmbeddingsUsage(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/embeddings-usage', opts);
  output(data);
}

async function cmdAssistantsChats(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/assistants-chats', opts);
  output(data);
}

async function cmdWebhooksUsage(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/webhooks-invocation', opts);
  output(data);
}

async function cmdMcpServers(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/mcp-servers', opts);
  output(data);
}

async function cmdMcpServersByUsers(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/mcp-servers-by-users', opts);
  output(data);
}

async function cmdPowerUsers(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/power-users', opts);
  output(data);
}

async function cmdKnowledgeSharing(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/knowledge-sharing', opts);
  output(data);
}

async function cmdTopAgents(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/top-agents-usage', opts);
  output(data);
}

async function cmdTopWorkflows(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/top-workflow-usage', opts);
  output(data);
}

async function cmdMarketplace(auth) {
  const data = await analyticsGet(auth, '/v1/analytics/published-to-marketplace', opts);
  output(data);
}

// --- Custom ---

async function cmdCustom(auth) {
  const path = opts._[0];
  if (!path) throw new Error(
    'Usage: custom <endpoint-path>\n' +
    'NOTE: prefer a named command over custom when one exists (run with "help" to list them).\n' +
    'Example: custom /v1/analytics/some-new-endpoint'
  );
  const method = (opts.method || 'GET').toUpperCase();
  let data;
  if (method === 'POST') {
    data = await analyticsPost(auth, path, {}, opts);
  } else {
    data = await analyticsGet(auth, path, opts);
  }
  output(data);
}

// --- LiteLLM ---

async function cmdLitellmCustomer() {
  const llm = getLiteLLMAuth();
  const userId = opts._[0] || opts.user;
  const params = userId ? { user_id: userId } : undefined;
  const data = await litellmFetch(llm, '/customer/info', { params });
  output(data);
}

async function cmdLitellmSpend() {
  const llm = getLiteLLMAuth();
  const params = {};
  if (opts.startDate) params.start_date = opts.startDate;
  if (opts.endDate) params.end_date = opts.endDate;
  if (opts.users) params.user_id = opts.users;
  const data = await litellmFetch(llm, '/spend/logs', { params });
  output(data);
}

async function cmdLitellmKeys() {
  const llm = getLiteLLMAuth();
  const data = await litellmFetch(llm, '/key/info');
  output(redactSensitiveFields(data));
}

async function cmdEnrichCSV() {
  const filePath = opts._[0];
  if (!filePath) throw new Error('Usage: enrich-csv <path-to-file.csv|xlsx>');

  const llm = getLiteLLMAuth();
  const rows = await parseInputFile(filePath);

  const userCol = ['user', 'user_id', 'email', 'username', 'User', 'Email'].find(c => rows[0]?.[c] !== undefined);
  if (!userCol) {
    throw new Error(`Cannot find user column. Available columns: ${Object.keys(rows[0] || {}).join(', ')}`);
  }

  const enriched = [];
  for (const row of rows) {
    const userId = row[userCol];
    let litellmInfo = null;
    try {
      litellmInfo = await litellmFetch(llm, '/customer/info', { params: { user_id: userId } });
    } catch {
      litellmInfo = { error: 'not_found' };
    }
    enriched.push({
      ...row,
      litellm_spend: litellmInfo?.spend ?? litellmInfo?.total_spend ?? null,
      litellm_max_budget: litellmInfo?.max_budget ?? null,
      litellm_models: Array.isArray(litellmInfo?.allowed_model_region)
        ? litellmInfo.allowed_model_region.join(';')
        : null,
      litellm_raw: JSON.stringify(litellmInfo),
    });
  }

  output(enriched);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const LITELLM_COMMANDS = ['litellm-customer', 'litellm-spend', 'litellm-keys'];

async function main() {
  if (!command || command === 'help') {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const docBlock = src.match(/\/\*\*([\s\S]*?)\*\//)?.[0] ?? '';
    console.log(docBlock);
    process.exit(0);
  }

  // LiteLLM-only commands
  if (command === 'enrich-csv') return cmdEnrichCSV();

  if (LITELLM_COMMANDS.includes(command)) {
    switch (command) {
      case 'litellm-customer': return cmdLitellmCustomer();
      case 'litellm-spend': return cmdLitellmSpend();
      case 'litellm-keys': return cmdLitellmKeys();
    }
  }

  // CodeMie API commands
  const auth = resolveAuth();
  if (!auth) {
    throw new Error(
      'No CodeMie credentials found. Either:\n' +
      '  1. Run `codemie setup` with SSO provider to store credentials\n' +
      '  2. Set CODEMIE_API_KEY + CODEMIE_URL env vars'
    );
  }

  switch (command) {
    // Summaries
    case 'summaries':              return cmdSummaries(auth);

    // Leaderboard
    case 'leaderboard':            return cmdLeaderboard(auth);
    case 'leaderboard-summary':    return cmdLeaderboardSummary(auth);
    case 'leaderboard-user':       return cmdLeaderboardUser(auth);
    case 'leaderboard-tiers':      return cmdLeaderboardTiers(auth);
    case 'leaderboard-dimensions': return cmdLeaderboardDimensions(auth);
    case 'leaderboard-top':        return cmdLeaderboardTop(auth);
    case 'leaderboard-scores':     return cmdLeaderboardScores(auth);
    case 'leaderboard-framework':  return cmdLeaderboardFramework(auth);
    case 'leaderboard-snapshots':  return cmdLeaderboardSnapshots(auth);
    case 'leaderboard-seasons':    return cmdLeaderboardSeasons(auth);

    // CLI Insights
    case 'cli-insights':           return cmdCliInsights(auth);
    case 'cli-insights-users':     return cmdCliInsightsUsers(auth);
    case 'cli-insights-user':      return cmdCliInsightsUser(auth);
    case 'cli-insights-projects':  return cmdCliInsightsProjects(auth);
    case 'cli-insights-patterns':  return cmdCliInsightsPatterns(auth);

    // Standard analytics
    case 'users':                  return cmdUsers(auth);
    case 'projects-spending':      return cmdProjectsSpending(auth);
    case 'projects-activity':      return cmdProjectsActivity(auth);
    case 'llms-usage':             return cmdLlmsUsage(auth);
    case 'tools-usage':            return cmdToolsUsage(auth);
    case 'workflows':              return cmdWorkflows(auth);
    case 'agents-usage':           return cmdAgentsUsage(auth);
    case 'embeddings-usage':       return cmdEmbeddingsUsage(auth);
    case 'assistants-chats':       return cmdAssistantsChats(auth);
    case 'webhooks-usage':         return cmdWebhooksUsage(auth);
    case 'mcp-servers':            return cmdMcpServers(auth);
    case 'mcp-servers-by-users':   return cmdMcpServersByUsers(auth);
    case 'power-users':            return cmdPowerUsers(auth);
    case 'knowledge-sharing':      return cmdKnowledgeSharing(auth);
    case 'top-agents':             return cmdTopAgents(auth);
    case 'top-workflows':          return cmdTopWorkflows(auth);
    case 'marketplace':            return cmdMarketplace(auth);
    case 'budget':                 return cmdBudget(auth);
    case 'spending':               return cmdSpending(auth);
    case 'spending-by-users':      return cmdSpendingByUsers(auth);
    case 'engagement':             return cmdEngagement(auth);

    // Custom — use only for endpoints without a dedicated command
    case 'custom':                 return cmdCustom(auth);

    default:
      throw new Error(`Unknown command: ${command}\nRun with 'help' for usage.`);
  }
}

main().catch(err => {
  console.error('[analytics-cli] Error:', err.message);
  process.exit(1);
});