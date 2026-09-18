/**
 * System Proxy Resolution
 *
 * Resolves the effective proxy for an outbound request, in precedence order:
 *   1. `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` environment variables
 *   2. Windows Internet Settings — static `ProxyServer`, or `AutoConfigURL` (PAC)
 *
 * Node's `http`/`https` modules never consult any system proxy configuration, so
 * without this module Windows users behind a PAC-based corporate proxy (Zscaler
 * and similar) have to discover and hand-set `HTTPS_PROXY` themselves.
 *
 * Set `CODEMIE_NO_SYSTEM_PROXY=1` to skip system detection and use env vars only.
 */

import http from 'http';
import https from 'https';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { isIP } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { exec } from './exec.js';
import { logger } from './logger.js';

const WINDOWS_INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Registry read is a subprocess spawn; keep it short so startup never stalls. */
const REGISTRY_TIMEOUT_MS = 5000;
/** PAC files are small and served from the corporate network. */
const PAC_FETCH_TIMEOUT_MS = 10000;
/** TCP reachability probe when a PAC offers several proxies. */
const PROXY_PROBE_TIMEOUT_MS = 3000;

/**
 * Never proxied. The CLI's own LLM proxy listens on loopback, so routing these
 * through a corporate proxy would break every agent session.
 */
const IMPLICIT_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

// ---------------------------------------------------------------------------
// NO_PROXY rules
// ---------------------------------------------------------------------------

export type NoProxyRule =
  | { kind: 'all' }
  | { kind: 'host'; value: string; port?: number }
  | { kind: 'domain'; value: string; port?: number }
  | { kind: 'cidr'; base: number; maskBits: number }
  | { kind: 'plain-hostname' };

export function splitRules(raw: string | undefined, separator = ','): string[] {
  if (!raw) return [];
  return raw
    .split(separator)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(p => Number.parseInt(p, 10));
  if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return (((nums[0] << 24) >>> 0) | ((nums[1] << 16) >>> 0) | ((nums[2] << 8) >>> 0) | nums[3]) >>> 0;
}

function parseCidr(raw: string): { base: number; maskBits: number } | null {
  const [ip, maskRaw] = raw.split('/');
  if (!ip || !maskRaw) return null;
  const maskBits = Number.parseInt(maskRaw, 10);
  if (!Number.isFinite(maskBits) || maskBits < 0 || maskBits > 32) return null;
  const base = parseIpv4(ip);
  if (base === null) return null;
  return { base, maskBits };
}

function ipInCidr(ip: string, base: number, maskBits: number): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
  return (value & mask) === (base & mask);
}

function parseHostPort(raw: string): { host: string; port?: number } {
  if (raw.startsWith('[')) {
    const closingBracket = raw.indexOf(']');
    if (closingBracket > 0 && raw[closingBracket + 1] === ':') {
      const portRaw = raw.slice(closingBracket + 2);
      const port = Number.parseInt(portRaw, 10);
      if (/^\d+$/.test(portRaw) && port >= 1 && port <= 65535) {
        return { host: raw.slice(1, closingBracket), port };
      }
    }
    return { host: raw };
  }

  const separator = raw.lastIndexOf(':');
  if (separator > 0 && raw.indexOf(':') === separator) {
    const host = raw.slice(0, separator);
    const portRaw = raw.slice(separator + 1);
    const port = Number.parseInt(portRaw, 10);
    if (/^\d+$/.test(portRaw) && port >= 1 && port <= 65535) {
      return { host, port };
    }
  }

  return { host: raw };
}

export function parseNoProxyRules(values: string[]): NoProxyRule[] {
  const rules: NoProxyRule[] = [];

  for (const raw of values) {
    const value = raw.toLowerCase();
    if (!value) continue;

    if (value === '*') {
      rules.push({ kind: 'all' });
      continue;
    }

    // Windows ProxyOverride tokens: <local> means "hostnames without a dot".
    if (value === '<local>') {
      rules.push({ kind: 'plain-hostname' });
      continue;
    }

    // <-loopback> is a Windows directive, not a bypass entry; loopback is
    // already covered by the implicit localhost rules below.
    if (value === '<-loopback>') continue;

    const cidr = parseCidr(value);
    if (cidr) {
      rules.push({ kind: 'cidr', ...cidr });
      continue;
    }

    // Windows writes wildcard entries as *.example.com; treat them as domains.
    const normalized = value.startsWith('*.') ? value.slice(1) : value;

    const { host, port } = parseHostPort(normalized);
    if (host.startsWith('.')) {
      rules.push({ kind: 'domain', value: host.slice(1), port });
      continue;
    }

    rules.push({ kind: 'host', value: host, port });
  }

  return rules;
}

function readNpmNoProxyEntries(): string[] {
  try {
    const npmrcPath = join(homedir(), '.npmrc');
    const raw = readFileSync(npmrcPath, 'utf-8');

    for (const lineRaw of raw.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      if (key === 'noproxy' || key === 'no-proxy') {
        return splitRules(line.slice(eq + 1).trim());
      }
    }
  } catch {
    // No user npmrc or unreadable file — ignore.
  }

  return [];
}

function matchesPort(rule: { port?: number }, port: number): boolean {
  return rule.port === undefined || rule.port === port;
}

export function shouldBypassProxy(hostname: string, port: number, rules: NoProxyRule[]): boolean {
  const host = hostname.toLowerCase();

  for (const rule of rules) {
    if (rule.kind === 'all') return true;

    if (rule.kind === 'plain-hostname') {
      if (!host.includes('.')) return true;
      continue;
    }

    if (rule.kind === 'host') {
      if (host === rule.value && matchesPort(rule, port)) return true;
      continue;
    }

    if (rule.kind === 'domain') {
      const matchesDomain = host === rule.value || host.endsWith(`.${rule.value}`);
      if (matchesDomain && matchesPort(rule, port)) return true;
      continue;
    }

    if (rule.kind === 'cidr' && isIP(host) === 4) {
      if (ipInCidr(host, rule.base, rule.maskBits)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export function getEnvProxyUrl(protocol: 'http:' | 'https:'): string | undefined {
  if (protocol === 'https:') {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
           process.env.HTTP_PROXY || process.env.http_proxy;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy;
}

export function getEnvNoProxyEntries(): string[] {
  return [
    ...splitRules(process.env.NO_PROXY || process.env.no_proxy),
    ...readNpmNoProxyEntries(),
  ];
}

// ---------------------------------------------------------------------------
// Windows Internet Settings
// ---------------------------------------------------------------------------

interface WindowsInternetSettings {
  proxyEnable: boolean;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigUrl?: string;
}

/**
 * Parse `reg query` output lines of the form:
 *   `    ProxyEnable    REG_DWORD    0x1`
 */
function parseRegistryOutput(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!match) continue;
    values[match[1].toLowerCase()] = match[2].trim();
  }

  return values;
}

async function readWindowsInternetSettings(): Promise<WindowsInternetSettings | undefined> {
  try {
    const result = await exec('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY], {
      timeout: REGISTRY_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      logger.debug('[system-proxy] reg query failed', { code: result.code, stderr: result.stderr });
      return undefined;
    }

    const values = parseRegistryOutput(result.stdout);

    return {
      // REG_DWORD arrives as 0x0 / 0x1.
      proxyEnable: Number.parseInt(values['proxyenable'] ?? '0', 16) === 1,
      proxyServer: values['proxyserver'] || undefined,
      proxyOverride: values['proxyoverride'] || undefined,
      autoConfigUrl: values['autoconfigurl'] || undefined,
    };
  } catch (error) {
    logger.debug('[system-proxy] Unable to read Windows Internet Settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * `ProxyServer` is either a bare `host:port` applying to every protocol, or a
 * per-protocol list such as `http=host:80;https=host:443;socks=host:1080`.
 */
function selectStaticProxy(proxyServer: string, protocol: 'http:' | 'https:'): string | undefined {
  if (!proxyServer.includes('=')) {
    return normalizeProxyUrl(proxyServer);
  }

  const wanted = protocol === 'https:' ? 'https' : 'http';
  const entries = new Map<string, string>();

  for (const entry of splitRules(proxyServer, ';')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    entries.set(entry.slice(0, eq).trim().toLowerCase(), entry.slice(eq + 1).trim());
  }

  const target = entries.get(wanted) ?? entries.get('http');
  return target ? normalizeProxyUrl(target) : undefined;
}

function normalizeProxyUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

// ---------------------------------------------------------------------------
// PAC (Proxy Auto-Configuration)
// ---------------------------------------------------------------------------

/**
 * Fetch the PAC script. Always goes direct — routing the PAC fetch through a
 * proxy would be circular, and the PAC host is reachable on the corporate LAN.
 */
async function fetchPacScript(pacUrl: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const url = new URL(pacUrl);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.get(
        pacUrl,
        { timeout: PAC_FETCH_TIMEOUT_MS, agent: false },
        res => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            logger.debug('[system-proxy] PAC fetch returned non-2xx', { status: res.statusCode });
            res.resume();
            done(undefined);
            return;
          }

          let body = '';
          res.setEncoding('utf-8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => done(body));
          res.on('error', () => done(undefined));
        }
      );

      req.on('error', error => {
        logger.debug('[system-proxy] PAC fetch failed', { error: error.message });
        done(undefined);
      });
      req.on('timeout', () => {
        req.destroy();
        done(undefined);
      });
    } catch (error) {
      logger.debug('[system-proxy] Invalid PAC URL', {
        error: error instanceof Error ? error.message : String(error),
      });
      done(undefined);
    }
  });
}

type PacFindProxy = (url: string, host?: string) => Promise<string>;

let pacResolverPromise: Promise<PacFindProxy | undefined> | null = null;

async function getPacResolver(pacUrl: string): Promise<PacFindProxy | undefined> {
  pacResolverPromise ??= (async () => {
    const source = await fetchPacScript(pacUrl);
    if (!source) return undefined;

    try {
      // Imported lazily: most users have no PAC, and this pulls in a WASM runtime.
      const [{ createPacResolver }, { QuickJS }] = await Promise.all([
        import('pac-resolver'),
        import('quickjs-wasi'),
      ]);

      // PAC scripts are fetched over plain HTTP from whatever AutoConfigURL
      // points at, so they run inside the QuickJS WASM sandbox rather than
      // Node's `vm` — a hostile PAC cannot reach the host process.
      const qjs = await QuickJS.create();
      logger.debug('[system-proxy] PAC script loaded', { pacUrl, bytes: source.length });
      return createPacResolver(qjs, source) as PacFindProxy;
    } catch (error) {
      logger.debug('[system-proxy] Failed to compile PAC script', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  })();

  return pacResolverPromise;
}

/**
 * Convert a `FindProxyForURL` result into ordered proxy candidates.
 * `DIRECT` terminates the list — entries after it are only reached when every
 * preceding proxy is unreachable, which we model by stopping here.
 */
function parsePacResult(result: string): { candidates: string[]; directFirst: boolean } {
  const candidates: string[] = [];

  for (const entry of splitRules(result, ';')) {
    const [keywordRaw, ...rest] = entry.split(/\s+/);
    const keyword = keywordRaw.toUpperCase();

    if (keyword === 'DIRECT') {
      return { candidates, directFirst: candidates.length === 0 };
    }

    // PROXY / HTTP / HTTPS / SOCKS / SOCKS5 host:port
    const target = rest.join(' ').trim();
    if (!target) continue;

    if (keyword === 'SOCKS' || keyword === 'SOCKS4' || keyword === 'SOCKS5') {
      logger.debug('[system-proxy] Ignoring SOCKS entry from PAC (unsupported)', { entry });
      continue;
    }

    const scheme = keyword === 'HTTPS' ? 'https' : 'http';
    candidates.push(`${scheme}://${target}`);
  }

  return { candidates, directFirst: false };
}

/** TCP-connect probe so a dead first PAC entry does not stall every request. */
async function isReachable(proxyUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const url = new URL(proxyUrl);
      const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
      const socket = createConnection({ host: url.hostname, port });

      socket.setTimeout(PROXY_PROBE_TIMEOUT_MS);
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('timeout', () => { socket.destroy(); done(false); });
      socket.once('error', () => { socket.destroy(); done(false); });
    } catch {
      done(false);
    }
  });
}

async function pickReachableProxy(candidates: string[]): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  for (const candidate of candidates) {
    if (await isReachable(candidate)) {
      logger.debug('[system-proxy] Selected reachable proxy', { proxy: candidate });
      return candidate;
    }
    logger.debug('[system-proxy] Proxy candidate unreachable, trying next', { proxy: candidate });
  }

  // Nothing answered — return the first so the caller surfaces a real
  // connection error instead of silently falling back to a direct request.
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SystemProxyConfig {
  /** Windows static proxy or undefined when PAC-based / unset. */
  settings?: WindowsInternetSettings;
  /** Bypass rules from NO_PROXY, npm config, and Windows ProxyOverride. */
  noProxyRules: NoProxyRule[];
}

let configPromise: Promise<SystemProxyConfig> | null = null;

function systemDetectionDisabled(): boolean {
  const flag = process.env.CODEMIE_NO_SYSTEM_PROXY;
  return flag === '1' || flag === 'true';
}

async function loadConfig(): Promise<SystemProxyConfig> {
  const noProxyEntries = [...IMPLICIT_NO_PROXY, ...getEnvNoProxyEntries()];

  if (platform() !== 'win32' || systemDetectionDisabled()) {
    return { noProxyRules: parseNoProxyRules(noProxyEntries) };
  }

  const settings = await readWindowsInternetSettings();

  if (settings?.proxyOverride) {
    noProxyEntries.push(...splitRules(settings.proxyOverride, ';'));
  }

  logger.debug('[system-proxy] Windows Internet Settings', {
    proxyEnable: settings?.proxyEnable,
    hasProxyServer: !!settings?.proxyServer,
    hasAutoConfigUrl: !!settings?.autoConfigUrl,
  });

  return { settings, noProxyRules: parseNoProxyRules(noProxyEntries) };
}

export function getSystemProxyConfig(): Promise<SystemProxyConfig> {
  configPromise ??= loadConfig();
  return configPromise;
}

/**
 * Resolve the proxy URL to use for `url`, or `undefined` for a direct connection.
 *
 * Environment variables win so existing setups and explicit overrides keep
 * working; Windows Internet Settings are only consulted when they are unset.
 */
export async function resolveProxyForUrl(url: URL): Promise<string | undefined> {
  const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  const port = Number.parseInt(url.port, 10) || (protocol === 'https:' ? 443 : 80);

  const config = await getSystemProxyConfig();

  if (shouldBypassProxy(url.hostname, port, config.noProxyRules)) {
    return undefined;
  }

  const envProxy = getEnvProxyUrl(protocol);
  if (envProxy) return normalizeProxyUrl(envProxy);

  const settings = config.settings;
  if (!settings) return undefined;

  if (settings.autoConfigUrl) {
    const proxy = await resolveViaPac(settings.autoConfigUrl, url);
    if (proxy) return proxy;
  }

  if (settings.proxyEnable && settings.proxyServer) {
    return selectStaticProxy(settings.proxyServer, protocol);
  }

  return undefined;
}

const pacResultCache = new Map<string, string | undefined>();

async function resolveViaPac(pacUrl: string, url: URL): Promise<string | undefined> {
  const cacheKey = `${url.protocol}//${url.host}`;
  if (pacResultCache.has(cacheKey)) {
    return pacResultCache.get(cacheKey);
  }

  let proxy: string | undefined;

  try {
    const findProxy = await getPacResolver(pacUrl);
    if (findProxy) {
      const result = await findProxy(url.href, url.hostname);
      const { candidates, directFirst } = parsePacResult(String(result ?? ''));
      proxy = directFirst ? undefined : await pickReachableProxy(candidates);
      logger.debug('[system-proxy] PAC resolution', { host: url.hostname, result, proxy });
    }
  } catch (error) {
    logger.debug('[system-proxy] PAC evaluation failed', {
      host: url.hostname,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  pacResultCache.set(cacheKey, proxy);
  return proxy;
}

export interface ProxyAgentOptions {
  rejectUnauthorized?: boolean;
  keepAlive?: boolean;
  maxSockets?: number;
}

const agentCache = new Map<string, http.Agent>();

/**
 * Agent that routes `url` through the resolved proxy, or `undefined` when the
 * request should go direct (letting Node use its default agent).
 */
export async function getProxyAgentForUrl(
  url: URL,
  options: ProxyAgentOptions = {}
): Promise<http.Agent | undefined> {
  const proxyUrl = await resolveProxyForUrl(url);
  if (!proxyUrl) return undefined;

  const isHttps = url.protocol === 'https:';
  const cacheKey = `${isHttps ? 'https' : 'http'}|${proxyUrl}|${options.rejectUnauthorized ?? ''}|${options.keepAlive ?? ''}|${options.maxSockets ?? ''}`;

  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const agent = isHttps
    ? new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: options.rejectUnauthorized,
        keepAlive: options.keepAlive,
        maxSockets: options.maxSockets,
      })
    : new HttpProxyAgent(proxyUrl, {
        keepAlive: options.keepAlive,
        maxSockets: options.maxSockets,
      });

  agentCache.set(cacheKey, agent);
  return agent;
}

/**
 * Publish the resolved proxy into `process.env` when the user has not set it.
 *
 * Two reasons this matters beyond our own HTTP clients:
 *  - spawned agent CLIs (claude, codex, gemini, ...) inherit the environment and
 *    get working proxy support without each needing its own detection,
 *  - `ProxyHTTPClient` reads these variables at construction time.
 *
 * PAC configs are collapsed to a single proxy here, which is unavoidable for an
 * environment variable. Per-request PAC accuracy is preserved for callers that
 * use {@link resolveProxyForUrl} directly.
 */
export async function primeProxyEnv(probeUrl: string): Promise<void> {
  if (getEnvProxyUrl('https:') || systemDetectionDisabled()) return;
  if (platform() !== 'win32') return;

  try {
    const proxy = await resolveProxyForUrl(new URL(probeUrl));
    if (!proxy) return;

    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;

    if (!process.env.NO_PROXY) {
      process.env.NO_PROXY = await buildNoProxyValue();
    }

    logger.debug('[system-proxy] Seeded proxy environment from Windows settings', {
      proxy,
      noProxy: process.env.NO_PROXY,
    });
  } catch (error) {
    logger.debug('[system-proxy] Failed to seed proxy environment', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Render the Windows ProxyOverride list back into NO_PROXY syntax. */
async function buildNoProxyValue(): Promise<string> {
  const { settings } = await getSystemProxyConfig();

  // `<local>` (any dotless hostname) has no NO_PROXY equivalent, so it is
  // dropped; the implicit loopback entries cover what actually matters here.
  const overrides = splitRules(settings?.proxyOverride, ';')
    .filter(entry => !entry.startsWith('<'))
    .map(entry => (entry.startsWith('*.') ? entry.slice(1) : entry));

  return [...IMPLICIT_NO_PROXY, ...overrides].join(',');
}

/** Test seam: drop cached registry/PAC/agent state. */
export function resetSystemProxyCache(): void {
  configPromise = null;
  pacResolverPromise = null;
  pacResultCache.clear();
  agentCache.clear();
}
