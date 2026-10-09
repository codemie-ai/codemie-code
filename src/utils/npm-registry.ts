import { get as httpGet, type Agent as HttpAgent } from 'node:http';
import { get as httpsGet } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import {
  IMPLICIT_NO_PROXY,
  getEnvNoProxyEntries,
  getProxyAgentForUrl,
  parseNoProxyRules,
  shouldBypassProxy,
  splitRules,
} from './system-proxy.js';
import { logger } from './logger.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type NpmConfig = Record<string, string>;

// An npm proxy the user configured but that cannot be used; the lookup must not then go direct.
class InvalidNpmProxyError extends Error {}

// Minimal .npmrc reader: `key=value` lines, `#`/`;` comments, optional surrounding quotes, and
// `${VAR}` expansion.
function readNpmrc(file: string): NpmConfig {
  if (!existsSync(file)) return {};
  const config: NpmConfig = {};
  try {
    for (const rawLine of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
        value = value.slice(1, -1);
      }
      config[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
    }
  } catch {
    return {};
  }
  return config;
}

// When CodeMie runs under `npm run`/`npx`, npm exports its whole effective config — the current
// project's .npmrc included — as `npm_config_*` env vars, so none of them can be trusted then.
function launchedByNpm(): boolean {
  return Boolean(process.env.npm_command || process.env.npm_execpath || process.env.npm_lifecycle_event);
}

// npm's own precedence for the settings used here: env var > user .npmrc. The env vars are
// skipped under npm (see launchedByNpm).
function npmSetting(config: NpmConfig, key: string): string | undefined {
  if (!launchedByNpm()) {
    const envKey = `npm_config_${key.replace(/-/g, '_')}`;
    const fromEnv = process.env[envKey] || process.env[envKey.toUpperCase()];
    if (fromEnv) return fromEnv;
  }
  return config[key] || undefined;
}

// User-level config only — never the current project's .npmrc. The lookup runs on every agent
// launch and its result is cached globally, so a checked-out repo must not be able to pick the
// registry or proxy it comes from: it could plant an old release as the tracked version for every
// project, or route env secrets (`registry=https://host/${TOKEN}/`) to a host of its choosing.
function loadNpmConfig(): NpmConfig {
  const userConfig = launchedByNpm()
    ? undefined
    : process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG;
  return readNpmrc(userConfig || join(homedir(), '.npmrc'));
}

/**
 * The registry npm would use for this package per the user's npm config (`@scope:registry` from
 * the user .npmrc, then `registry`); a project's .npmrc is deliberately ignored.
 */
export function resolveRegistry(packageName: string): string {
  const config = loadNpmConfig();
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : undefined;
  const registry = (scope && config[`${scope}:registry`]) || npmSetting(config, 'registry') || DEFAULT_REGISTRY;
  return registry.endsWith('/') ? registry : `${registry}/`;
}

// NO_PROXY/no_proxy and npm's `noproxy` decide first, whichever proxy would apply. Then npm's own
// `https-proxy`/`proxy` settings win over HTTPS_PROXY/HTTP_PROXY, as they do for npm itself.
// Without them, the shared resolver applies the env vars and then the Windows system proxy / PAC,
// so a registry behind a PAC-only corporate proxy is reachable too.
async function proxyAgentFor(url: URL, config: NpmConfig): Promise<HttpAgent | undefined> {
  const isHttps = url.protocol === 'https:';
  const port = Number.parseInt(url.port, 10) || (isHttps ? 443 : 80);
  const noProxyRules = parseNoProxyRules([
    ...IMPLICIT_NO_PROXY,
    ...getEnvNoProxyEntries(),
    ...splitRules(npmSetting(config, 'noproxy')),
  ]);
  if (shouldBypassProxy(url.hostname, port, noProxyRules)) return undefined;

  const npmProxy = isHttps
    ? npmSetting(config, 'https-proxy') || npmSetting(config, 'proxy')
    : npmSetting(config, 'proxy');
  if (!npmProxy) return getProxyAgentForUrl(url, { keepAlive: false });
  try {
    return isHttps ? new HttpsProxyAgent(npmProxy) : new HttpProxyAgent(npmProxy);
  } catch (error) {
    // The value is not logged: a proxy URL can carry credentials.
    logger.debug('[npm-registry] configured npm proxy is invalid, skipping the lookup', { error: String(error) });
    throw new InvalidNpmProxyError();
  }
}

// Bounds proxy discovery (a registry read and a PAC fetch on Windows) by the caller's deadline;
// a discovery failure goes direct, as getProxyAgentForUrl itself does. An explicitly configured
// npm proxy that cannot be built fails the lookup instead: going direct would leave the proxy
// the user chose.
async function proxyAgentWithin(
  url: URL,
  config: NpmConfig,
  timeoutMs: number
): Promise<{ agent: HttpAgent | undefined } | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const discovered = proxyAgentFor(url, config).then(
    (agent) => ({ agent }),
    (error: unknown) => (error instanceof InvalidNpmProxyError ? null : { agent: undefined })
  );
  try {
    return await Promise.race([discovered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `latest` dist-tag version of a package, read straight from the npm registry (one small
 * HTTP request instead of spawning `npm view`, which takes 3s+ on Windows). Uses the registry and
 * proxy from the user's npm config, else the system proxy. Returns `null` on any failure —
 * timeout, network error, non-200, or a response without a version; registries that require
 * authentication are not supported.
 *
 * @param packageName - npm package name, e.g. `@openai/codex`
 * @param options.timeoutMs - give up after this long, proxy discovery included
 */
export async function fetchLatestVersionFromRegistry(
  packageName: string,
  options: { timeoutMs: number }
): Promise<string | null> {
  const startedAt = Date.now();
  let url: URL;
  let config: NpmConfig;
  try {
    config = loadNpmConfig();
    // `@scope/name` must be encoded as `@scope%2fname` for registries other than npmjs.
    url = new URL(`${packageName.replace('/', '%2f')}/latest`, resolveRegistry(packageName));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const proxy = await proxyAgentWithin(url, config, options.timeoutMs);
  const remainingMs = options.timeoutMs - (Date.now() - startedAt);
  if (!proxy || remainingMs <= 0) {
    return null;
  }
  return requestLatestVersion(url, proxy.agent, remainingMs);
}

function requestLatestVersion(url: URL, agent: HttpAgent | undefined, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(
      url,
      { agent, headers: { accept: 'application/json' }, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_RESPONSE_BYTES) request.destroy();
        });
        response.on('end', () => {
          try {
            const version = (JSON.parse(body) as { version?: unknown }).version;
            resolve(typeof version === 'string' ? version : null);
          } catch {
            resolve(null);
          }
        });
        response.on('error', () => resolve(null));
      }
    );
    // `timeout` above only covers an idle socket; this bounds the whole request.
    const deadline = setTimeout(() => request.destroy(), timeoutMs);
    request.on('close', () => {
      clearTimeout(deadline);
      resolve(null); // no-op if the response already resolved
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}
