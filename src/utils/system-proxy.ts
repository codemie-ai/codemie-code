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
import { sanitizeLogArgs } from './security.js';
import { getWindowsSystem32 } from './windows-path.js';

const USER_INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const MACHINE_INTERNET_SETTINGS_KEY =
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const INTERNET_SETTINGS_POLICY_KEY =
  'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Registry read is a subprocess spawn; keep it short so startup never stalls. */
const REGISTRY_TIMEOUT_MS = 5000;
/** PAC discovery must not hold every CLI invocation hostage when the VPN is down. */
const PAC_FETCH_TIMEOUT_MS = 3000;
/** PAC scripts are executable input; bound memory before compiling them. */
const MAX_PAC_BYTES = 1024 * 1024;
/** TCP reachability probe when a PAC offers several proxies. */
const PROXY_PROBE_TIMEOUT_MS = 3000;
const CONFIG_SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 5000;
const PAC_RESOLVER_TTL_MS = 5 * 60 * 1000;
const PAC_RESULT_TTL_MS = 60 * 1000;

/**
 * Never proxied. The CLI's own LLM proxy listens on loopback, so routing these
 * through a corporate proxy would break every agent session.
 */
export const IMPLICIT_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

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

/** Convert Windows trailing-octet wildcards such as `192.168.*` to CIDR. */
function parseIpv4Wildcard(raw: string): { base: number; maskBits: number } | null {
  const parts = raw.split('.');
  if (parts.length < 2 || parts.length > 4) return null;

  const wildcardIndex = parts.indexOf('*');
  if (wildcardIndex < 1 || parts.slice(wildcardIndex).some(part => part !== '*')) return null;

  const numericParts = parts.slice(0, wildcardIndex);
  if (numericParts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return null;

  const octets = [...numericParts, ...Array.from({ length: 4 - numericParts.length }, () => '0')];
  const base = parseIpv4(octets.join('.'));
  return base === null ? null : { base, maskBits: wildcardIndex * 8 };
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

    const cidr = parseCidr(value) ?? parseIpv4Wildcard(value);
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
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

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

const primedProxyEnvValues = new Map<string, string>();

function getEnvProxyUrlForProtocol(
  protocol: 'http:' | 'https:',
  ignorePrimedValues = false
): string | undefined {
  const keys = protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    : ['HTTP_PROXY', 'http_proxy'];

  for (const key of keys) {
    const value = process.env[key];
    if (
      value
      && (!ignorePrimedValues || primedProxyEnvValues.get(key.toLowerCase()) !== value)
    ) {
      return value;
    }
  }

  return undefined;
}

export function getEnvProxyUrl(protocol: 'http:' | 'https:'): string | undefined {
  return getEnvProxyUrlForProtocol(protocol);
}

export function getEnvNoProxyEntries(): string[] {
  return [
    ...splitRules(process.env.NO_PROXY),
    ...splitRules(process.env.no_proxy),
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
  source: 'user' | 'machine';
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

async function queryRegistryKey(key: string): Promise<Record<string, string> | undefined> {
  try {
    // SECURITY: resolve the trusted system binary directly; PATH/PATHEXT are attacker-controlled.
    const regPath = `${getWindowsSystem32()}\\reg.exe`;
    const result = await exec(regPath, ['query', key], {
      timeout: REGISTRY_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      logger.debug(
        '[system-proxy] Registry query failed',
        ...sanitizeLogArgs({ key, code: result.code, stderr: result.stderr })
      );
      return undefined;
    }

    return parseRegistryOutput(result.stdout);
  } catch (error) {
    logger.debug(
      '[system-proxy] Unable to query Windows Internet Settings',
      ...sanitizeLogArgs({ key, error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

async function readWindowsInternetSettings(): Promise<WindowsInternetSettings | undefined> {
  const policyValues = await queryRegistryKey(INTERNET_SETTINGS_POLICY_KEY);
  const useMachineSettings = Number.parseInt(policyValues?.['proxysettingsperuser'] ?? '1', 16) === 0;
  const values = await queryRegistryKey(
    useMachineSettings ? MACHINE_INTERNET_SETTINGS_KEY : USER_INTERNET_SETTINGS_KEY
  );
  if (!values) return undefined;

  return {
    // REG_DWORD arrives as 0x0 / 0x1.
    proxyEnable: Number.parseInt(values['proxyenable'] ?? '0', 16) === 1,
    proxyServer: values['proxyserver'] || undefined,
    proxyOverride: values['proxyoverride'] || undefined,
    autoConfigUrl: values['autoconfigurl'] || undefined,
    source: useMachineSettings ? 'machine' : 'user',
  };
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
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return undefined;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;

    // URL canonicalization removes explicit default ports. Preserve them so
    // diagnostics and child-process environment values match Windows/PAC input.
    const authority = candidate.slice(candidate.indexOf('//') + 2).split(/[/?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const explicitPort = hostPort.startsWith('[')
      ? /^\[[^\]]+\]:(\d+)$/.exec(hostPort)?.[1]
      : /:(\d+)$/.exec(hostPort)?.[1];
    const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
      ? `[${parsed.hostname}]`
      : parsed.hostname;
    const credentials = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    const port = parsed.port || explicitPort;
    return `${parsed.protocol}//${credentials}${host}${port ? `:${port}` : ''}`;
  } catch {
    return undefined;
  }
}

function sanitizedProxyForLog(raw: string): string {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return '[invalid proxy]';
  const parsed = new URL(normalized);
  return `${parsed.protocol}//${parsed.host}`;
}

function sanitizedPacForLog(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '[invalid PAC URL]';
  }
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
        {
          timeout: PAC_FETCH_TIMEOUT_MS,
          agent: false,
          ...(url.protocol === 'https:'
            ? { rejectUnauthorized: isTlsVerificationEnabled() }
            : {}),
        },
        res => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            logger.debug('[system-proxy] PAC fetch returned non-2xx', { status: res.statusCode });
            res.resume();
            done(undefined);
            return;
          }

          let body = '';
          let bytes = 0;
          res.setEncoding('utf-8');
          res.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_PAC_BYTES) {
              logger.debug('[system-proxy] PAC response exceeded size limit', { bytes, limit: MAX_PAC_BYTES });
              res.destroy();
              done(undefined);
              return;
            }
            body += chunk;
          });
          res.on('end', () => done(body));
          res.on('error', () => done(undefined));
        }
      );

      req.on('error', error => {
        logger.debug('[system-proxy] PAC fetch failed', ...sanitizeLogArgs({ error: error.message }));
        done(undefined);
      });
      req.on('timeout', () => {
        req.destroy();
        done(undefined);
      });
    } catch (error) {
      logger.debug(
        '[system-proxy] Invalid PAC URL',
        { errorType: error instanceof Error ? error.name : 'Error' }
      );
      done(undefined);
    }
  });
}

type PacFindProxy = (url: string, host?: string) => Promise<string>;

interface TimedValue<T> {
  value: T;
  expiresAt: number;
}

const pacResolverCache = new Map<string, TimedValue<PacFindProxy | undefined>>();
const pacResolverPromises = new Map<string, Promise<PacFindProxy | undefined>>();

async function getPacResolver(pacUrl: string): Promise<PacFindProxy | undefined> {
  const cached = pacResolverCache.get(pacUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const inFlight = pacResolverPromises.get(pacUrl);
  if (inFlight) return inFlight;

  const resolverPromise = (async () => {
    const source = await fetchPacScript(pacUrl);
    if (!source) {
      pacResolverCache.set(pacUrl, { value: undefined, expiresAt: Date.now() + FAILURE_TTL_MS });
      return undefined;
    }

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
      logger.debug('[system-proxy] PAC script loaded', {
        pacOrigin: sanitizedPacForLog(pacUrl),
        bytes: Buffer.byteLength(source),
      });
      const resolver = createPacResolver(qjs, source) as PacFindProxy;
      pacResolverCache.set(pacUrl, {
        value: resolver,
        expiresAt: Date.now() + PAC_RESOLVER_TTL_MS,
      });
      return resolver;
    } catch (error) {
      logger.debug(
        '[system-proxy] Failed to compile PAC script',
        { errorType: error instanceof Error ? error.name : 'Error' }
      );
      pacResolverCache.set(pacUrl, { value: undefined, expiresAt: Date.now() + FAILURE_TTL_MS });
      return undefined;
    }
  })();

  pacResolverPromises.set(pacUrl, resolverPromise);
  try {
    return await resolverPromise;
  } finally {
    pacResolverPromises.delete(pacUrl);
  }
}

interface ParsedPacResult {
  candidates: string[];
  directFallback: boolean;
}

/** Convert a `FindProxyForURL` result into supported directives in order. */
function parsePacResult(result: string): ParsedPacResult {
  const candidates: string[] = [];

  for (const entry of splitRules(result, ';')) {
    const [keywordRaw, ...rest] = entry.split(/\s+/);
    const keyword = keywordRaw.toUpperCase();

    if (keyword === 'DIRECT') {
      return { candidates, directFallback: true };
    }

    // PROXY / HTTP / HTTPS / SOCKS / SOCKS5 host:port
    const target = rest.join(' ').trim();
    if (!target) continue;

    if (keyword === 'SOCKS' || keyword === 'SOCKS4' || keyword === 'SOCKS5') {
      logger.debug('[system-proxy] Ignoring SOCKS entry from PAC (unsupported)');
      continue;
    }

    if (keyword !== 'PROXY' && keyword !== 'HTTP' && keyword !== 'HTTPS') {
      logger.debug('[system-proxy] Ignoring unsupported PAC directive', { keyword });
      continue;
    }

    const scheme = keyword === 'HTTPS' ? 'https' : 'http';
    const normalized = normalizeProxyUrl(`${scheme}://${target}`);
    if (normalized) candidates.push(normalized);
  }

  return { candidates, directFallback: false };
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

  for (const candidate of candidates) {
    if (await isReachable(candidate)) {
      logger.debug(
        '[system-proxy] Selected reachable proxy',
        { proxy: sanitizedProxyForLog(candidate) }
      );
      return candidate;
    }
    logger.debug(
      '[system-proxy] Proxy candidate unreachable, trying next',
      { proxy: sanitizedProxyForLog(candidate) }
    );
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SystemProxyConfig {
  /** Windows static proxy or undefined when PAC-based / unset. */
  settings?: WindowsInternetSettings;
  /** Loopback plus NO_PROXY/no_proxy and npm noproxy. */
  environmentNoProxyRules: NoProxyRule[];
  /** Windows ProxyOverride rules, applied only when no explicit env proxy exists. */
  windowsNoProxyRules: NoProxyRule[];
  /** Combined rules retained for diagnostics and compatibility. */
  noProxyRules: NoProxyRule[];
}

export type ProxyResolution =
  | { kind: 'proxy'; url: string; source: 'environment' | 'pac' | 'windows-static' }
  | { kind: 'direct'; source: 'bypass' | 'pac' | 'none' | 'invalid-proxy' }
  | { kind: 'unavailable'; source: 'pac'; reason: string };

interface LoadedConfig {
  config: SystemProxyConfig;
  cacheTtlMs: number;
}

let configCache: TimedValue<SystemProxyConfig> | null = null;
let configPromise: Promise<SystemProxyConfig> | null = null;

function systemDetectionDisabled(): boolean {
  const flag = process.env.CODEMIE_NO_SYSTEM_PROXY;
  return flag === '1' || flag === 'true';
}

async function loadConfig(): Promise<LoadedConfig> {
  const environmentNoProxyRules = parseNoProxyRules([
    ...IMPLICIT_NO_PROXY,
    ...getEnvNoProxyEntries(),
  ]);

  if (platform() !== 'win32' || systemDetectionDisabled()) {
    return {
      config: {
        environmentNoProxyRules,
        windowsNoProxyRules: [],
        noProxyRules: environmentNoProxyRules,
      },
      cacheTtlMs: CONFIG_SUCCESS_TTL_MS,
    };
  }

  const settings = await readWindowsInternetSettings();
  const windowsNoProxyRules = parseNoProxyRules(splitRules(settings?.proxyOverride, ';'));

  logger.debug(
    '[system-proxy] Windows Internet Settings',
    ...sanitizeLogArgs({
      source: settings?.source,
      proxyEnable: settings?.proxyEnable,
      hasProxyServer: !!settings?.proxyServer,
      hasAutoConfigUrl: !!settings?.autoConfigUrl,
    })
  );

  return {
    config: {
      settings,
      environmentNoProxyRules,
      windowsNoProxyRules,
      noProxyRules: [...environmentNoProxyRules, ...windowsNoProxyRules],
    },
    cacheTtlMs: settings ? CONFIG_SUCCESS_TTL_MS : FAILURE_TTL_MS,
  };
}

/** Load the effective proxy configuration with bounded success/failure caching. */
export async function getSystemProxyConfig(): Promise<SystemProxyConfig> {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.value;
  if (configPromise) return configPromise;

  configPromise = (async () => {
    const loaded = await loadConfig();
    configCache = {
      value: loaded.config,
      expiresAt: Date.now() + loaded.cacheTtlMs,
    };
    return loaded.config;
  })();

  try {
    return await configPromise;
  } finally {
    configPromise = null;
  }
}

/**
 * Resolve a request to an explicit proxy, direct connection, or unavailable PAC.
 *
 * Explicit NO_PROXY applies first, then user proxy variables. Windows bypass,
 * PAC and static settings are considered only when the user did not override
 * routing through the environment.
 */
export async function resolveProxyForUrlDetailed(url: URL): Promise<ProxyResolution> {
  const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  const port = Number.parseInt(url.port, 10) || (protocol === 'https:' ? 443 : 80);

  const config = await getSystemProxyConfig();
  const environmentNoProxyRules = parseNoProxyRules([
    ...IMPLICIT_NO_PROXY,
    ...getEnvNoProxyEntries(),
  ]);

  if (shouldBypassProxy(url.hostname, port, environmentNoProxyRules)) {
    return { kind: 'direct', source: 'bypass' };
  }

  const envProxy = getEnvProxyUrlForProtocol(protocol, true);
  if (envProxy) {
    const normalized = normalizeProxyUrl(envProxy);
    if (normalized) return { kind: 'proxy', url: normalized, source: 'environment' };
    logger.debug('[system-proxy] Ignoring invalid environment proxy URL');
    return { kind: 'direct', source: 'invalid-proxy' };
  }

  if (shouldBypassProxy(url.hostname, port, config.windowsNoProxyRules)) {
    return { kind: 'direct', source: 'bypass' };
  }

  const settings = config.settings;
  if (!settings) return { kind: 'direct', source: 'none' };

  if (settings.autoConfigUrl) {
    const pacResolution = await resolveViaPac(settings.autoConfigUrl, url);
    if (pacResolution.kind !== 'unavailable') return pacResolution;
  }

  if (settings.proxyEnable && settings.proxyServer) {
    const proxyUrl = selectStaticProxy(settings.proxyServer, protocol);
    if (proxyUrl) return { kind: 'proxy', url: proxyUrl, source: 'windows-static' };
    logger.debug('[system-proxy] Ignoring invalid static proxy configuration');
    return { kind: 'direct', source: 'invalid-proxy' };
  }

  return { kind: 'direct', source: 'none' };
}

/** Resolve the proxy URL for Node HTTP clients, or `undefined` for direct. */
export async function resolveProxyForUrl(url: URL): Promise<string | undefined> {
  const resolution = await resolveProxyForUrlDetailed(url);
  return resolution.kind === 'proxy' ? resolution.url : undefined;
}

const pacResultCache = new Map<string, TimedValue<ProxyResolution>>();

async function resolveViaPac(pacUrl: string, url: URL): Promise<ProxyResolution> {
  const cacheKey = `${pacUrl}|${url.protocol}//${url.host}`;
  const cached = pacResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const findProxy = await getPacResolver(pacUrl);
    if (!findProxy) {
      const unavailable: ProxyResolution = {
        kind: 'unavailable',
        source: 'pac',
        reason: 'PAC script unavailable',
      };
      pacResultCache.set(cacheKey, { value: unavailable, expiresAt: Date.now() + FAILURE_TTL_MS });
      return unavailable;
    }

    const result = await findProxy(url.href, url.hostname);
    const { candidates, directFallback } = parsePacResult(String(result ?? ''));

    if (candidates.length === 0 && directFallback) {
      const direct: ProxyResolution = { kind: 'direct', source: 'pac' };
      pacResultCache.set(cacheKey, { value: direct, expiresAt: Date.now() + PAC_RESULT_TTL_MS });
      return direct;
    }

    const reachable = candidates.length === 1 && !directFallback
      ? candidates[0]
      : await pickReachableProxy(candidates);
    const resolution: ProxyResolution = reachable
      ? { kind: 'proxy', url: reachable, source: 'pac' }
      : directFallback
        ? { kind: 'direct', source: 'pac' }
        : candidates.length > 0
          ? { kind: 'proxy', url: candidates[0], source: 'pac' }
          : { kind: 'unavailable', source: 'pac', reason: 'PAC returned no supported directives' };

    logger.debug(
      '[system-proxy] PAC resolution',
      ...sanitizeLogArgs({
        host: url.hostname,
        directiveCount: splitRules(String(result ?? ''), ';').length,
        route: resolution.kind,
        source: resolution.source,
        proxy: resolution.kind === 'proxy' ? sanitizedProxyForLog(resolution.url) : undefined,
      })
    );
    pacResultCache.set(cacheKey, {
      value: resolution,
      expiresAt: Date.now() + (resolution.kind === 'unavailable' ? FAILURE_TTL_MS : PAC_RESULT_TTL_MS),
    });
    return resolution;
  } catch (error) {
    logger.debug(
      '[system-proxy] PAC evaluation failed',
      ...sanitizeLogArgs({
        host: url.hostname,
        errorType: error instanceof Error ? error.name : 'Error',
      })
    );
    const unavailable: ProxyResolution = {
      kind: 'unavailable',
      source: 'pac',
      reason: 'PAC evaluation failed',
    };
    pacResultCache.set(cacheKey, { value: unavailable, expiresAt: Date.now() + FAILURE_TTL_MS });
    return unavailable;
  }
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
  const rejectUnauthorized = options.rejectUnauthorized ?? isTlsVerificationEnabled();
  const keepAlive = options.keepAlive ?? true;
  const maxSockets = options.maxSockets ?? 50;
  const cacheKey = `${isHttps ? 'https' : 'http'}|${proxyUrl}|${rejectUnauthorized}|${keepAlive}|${maxSockets}`;

  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  try {
    const agent = isHttps
      ? new HttpsProxyAgent(proxyUrl, {
          rejectUnauthorized,
          keepAlive,
          maxSockets,
        })
      : new HttpProxyAgent(proxyUrl, { rejectUnauthorized, keepAlive, maxSockets });

    agentCache.set(cacheKey, agent);
    return agent;
  } catch (error) {
    logger.debug(
      '[system-proxy] Failed to construct proxy agent; continuing direct',
      ...sanitizeLogArgs({
        proxy: sanitizedProxyForLog(proxyUrl),
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return undefined;
  }
}

/** Return whether outbound TLS certificates must be verified. */
export function isTlsVerificationEnabled(): boolean {
  return process.env.CODEMIE_INSECURE !== '1';
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.');
}

function normalizeWindowsOverrideForEnv(entry: string): string | undefined {
  if (entry.startsWith('<')) return undefined;
  if (entry.startsWith('*.')) return entry.slice(1);
  const wildcard = parseIpv4Wildcard(entry.toLowerCase());
  return wildcard ? `${formatIpv4(wildcard.base)}/${wildcard.maskBits}` : entry;
}

/** Merge NO_PROXY spellings and implicit loopback entries without duplicates. */
export function mergeNoProxyValues(...values: Array<string | undefined>): string {
  const entries = [...values.flatMap(value => splitRules(value)), ...IMPLICIT_NO_PROXY];
  const seen = new Set<string>();
  return entries
    .filter(entry => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(',');
}

/** Render representable Windows ProxyOverride entries into NO_PROXY syntax. */
async function getWindowsNoProxyValue(): Promise<string> {
  const { settings } = await getSystemProxyConfig();
  const overrides = splitRules(settings?.proxyOverride, ';')
    .map(normalizeWindowsOverrideForEnv)
    .filter((entry): entry is string => Boolean(entry));

  return overrides.join(',');
}

function setProxyEnvPair(
  env: NodeJS.ProcessEnv,
  upperKey: 'HTTP_PROXY' | 'HTTPS_PROXY',
  value: string,
  systemDerived: boolean
): void {
  const lowerKey = upperKey.toLowerCase();
  if (!env[upperKey]) env[upperKey] = value;
  if (!env[lowerKey]) env[lowerKey] = value;
  if (systemDerived && env === process.env) {
    primedProxyEnvValues.set(lowerKey, value);
  }
}

function existingProxyValue(
  env: NodeJS.ProcessEnv,
  upperKey: 'HTTP_PROXY' | 'HTTPS_PROXY'
): string | undefined {
  const lowerKey = upperKey.toLowerCase();
  for (const key of [upperKey, lowerKey]) {
    const value = env[key];
    if (!value) continue;
    if (env !== process.env || primedProxyEnvValues.get(lowerKey) !== value) return value;
  }
  return undefined;
}

function targetForProtocol(target: URL, protocol: 'http:' | 'https:'): URL {
  const result = new URL(target);
  result.protocol = protocol;
  if ((protocol === 'http:' && result.port === '443') || (protocol === 'https:' && result.port === '80')) {
    result.port = '';
  }
  return result;
}

/**
 * Build the best-effort proxy environment for SDKs and spawned tools.
 * PAC routing is necessarily collapsed to the target host; in-process clients
 * retain per-request accuracy through {@link resolveProxyForUrlDetailed}.
 */
export async function buildSystemProxyEnvironment(
  targetUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  const target = new URL(targetUrl);

  for (const [upperKey, protocol] of [
    ['HTTP_PROXY', 'http:'],
    ['HTTPS_PROXY', 'https:'],
  ] as const) {
    const lowerKey = upperKey.toLowerCase();
    const primedValue = primedProxyEnvValues.get(lowerKey);
    if (baseEnv === process.env && primedValue) {
      if (nextEnv[upperKey] === primedValue) delete nextEnv[upperKey];
      if (nextEnv[lowerKey] === primedValue) delete nextEnv[lowerKey];
    }
    const existing = existingProxyValue(baseEnv, upperKey);
    if (existing) {
      setProxyEnvPair(nextEnv, upperKey, existing, false);
      continue;
    }

    const resolution = await resolveProxyForUrlDetailed(targetForProtocol(target, protocol));
    if (resolution.kind === 'proxy') {
      setProxyEnvPair(nextEnv, upperKey, resolution.url, true);
    }
  }

  const windowsNoProxy = await getWindowsNoProxyValue();
  const noProxy = mergeNoProxyValues(baseEnv.NO_PROXY, baseEnv.no_proxy, windowsNoProxy);
  nextEnv.NO_PROXY = noProxy;
  nextEnv.no_proxy = noProxy;
  return nextEnv;
}

/** Apply the shared proxy environment to a mutable process or child environment. */
export async function applySystemProxyEnvironment(
  targetUrl: string,
  targetEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  try {
    const hadExplicitHttpProxy = Boolean(existingProxyValue(targetEnv, 'HTTP_PROXY'));
    const hadExplicitHttpsProxy = Boolean(existingProxyValue(targetEnv, 'HTTPS_PROXY'));
    const resolvedEnv = await buildSystemProxyEnvironment(targetUrl, targetEnv);
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      if (resolvedEnv[key] !== undefined) {
        targetEnv[key] = resolvedEnv[key];
      } else if (
        targetEnv === process.env
        && primedProxyEnvValues.get(key.toLowerCase()) === targetEnv[key]
      ) {
        delete targetEnv[key];
      }
    }
    if (targetEnv === process.env) {
      if (hadExplicitHttpProxy) {
        primedProxyEnvValues.delete('http_proxy');
      } else if (targetEnv.HTTP_PROXY) {
        primedProxyEnvValues.set('http_proxy', targetEnv.HTTP_PROXY);
      } else if (!targetEnv.HTTP_PROXY && !targetEnv.http_proxy) {
        primedProxyEnvValues.delete('http_proxy');
      }
      if (hadExplicitHttpsProxy) {
        primedProxyEnvValues.delete('https_proxy');
      } else if (targetEnv.HTTPS_PROXY) {
        primedProxyEnvValues.set('https_proxy', targetEnv.HTTPS_PROXY);
      } else if (!targetEnv.HTTPS_PROXY && !targetEnv.https_proxy) {
        primedProxyEnvValues.delete('https_proxy');
      }
    }

    logger.debug(
      '[system-proxy] Applied proxy environment',
      ...sanitizeLogArgs({
        hasHttpProxy: Boolean(targetEnv.HTTP_PROXY || targetEnv.http_proxy),
        hasHttpsProxy: Boolean(targetEnv.HTTPS_PROXY || targetEnv.https_proxy),
        noProxyEntries: splitRules(targetEnv.NO_PROXY).length,
      })
    );
  } catch (error) {
    logger.debug(
      '[system-proxy] Failed to build proxy environment',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) })
    );
  }
}

/** Test seam: drop cached registry/PAC/agent state. */
export function resetSystemProxyCache(): void {
  configCache = null;
  configPromise = null;
  pacResolverCache.clear();
  pacResolverPromises.clear();
  pacResultCache.clear();
  for (const agent of agentCache.values()) agent.destroy();
  agentCache.clear();
  primedProxyEnvValues.clear();
}
