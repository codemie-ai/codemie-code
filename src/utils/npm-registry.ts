import { get as httpGet, type Agent as HttpAgent } from 'node:http';
import { get as httpsGet } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type NpmConfig = Record<string, string>;

// Minimal .npmrc reader: `key=value` lines, `#`/`;` comments, optional surrounding quotes, and
// `${VAR}` expansion when `expandEnv` is set. Expansion is off for a project .npmrc (a value that
// needs it is skipped): the lookup runs on every agent launch, so a checked-out repo must not be
// able to route env secrets (e.g. `registry=https://host/${TOKEN}/`) to a host of its choosing.
function readNpmrc(file: string, expandEnv: boolean): NpmConfig {
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
      if (expandEnv) {
        value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
      } else if (/\$\{[^}]+\}/.test(value)) {
        continue;
      }
      config[key] = value;
    }
  } catch {
    return {};
  }
  return config;
}

// npm's own precedence for the settings used here: env var > project .npmrc > user .npmrc.
function npmSetting(config: NpmConfig, key: string): string | undefined {
  const envKey = `npm_config_${key.replace(/-/g, '_')}`;
  return process.env[envKey] || process.env[envKey.toUpperCase()] || config[key] || undefined;
}

function loadNpmConfig(cwd: string): NpmConfig {
  const userConfig = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || join(homedir(), '.npmrc');
  return { ...readNpmrc(userConfig, true), ...readNpmrc(join(cwd, '.npmrc'), false) };
}

/** The registry npm would use for this package, honoring `@scope:registry` and `registry`. */
export function resolveRegistry(packageName: string, cwd: string = process.cwd()): string {
  const config = loadNpmConfig(cwd);
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : undefined;
  const registry = (scope && config[`${scope}:registry`]) || npmSetting(config, 'registry') || DEFAULT_REGISTRY;
  return registry.endsWith('/') ? registry : `${registry}/`;
}

function isNoProxyHost(hostname: string): boolean {
  const rules = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  const host = hostname.toLowerCase();
  return rules.some(
    (rule) => rule === '*' || host === rule.replace(/^\./, '') || host.endsWith(rule.startsWith('.') ? rule : `.${rule}`)
  );
}

function proxyAgentFor(url: URL, config: NpmConfig): HttpAgent | undefined {
  if (isNoProxyHost(url.hostname)) return undefined;
  if (url.protocol === 'https:') {
    const proxy =
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy ||
      npmSetting(config, 'https-proxy') || npmSetting(config, 'proxy');
    return proxy ? new HttpsProxyAgent(proxy) : undefined;
  }
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy || npmSetting(config, 'proxy');
  return proxy ? new HttpProxyAgent(proxy) : undefined;
}

/**
 * The `latest` dist-tag version of a package, read straight from the npm registry (one small
 * HTTP request instead of spawning `npm view`, which takes 3s+ on Windows). Uses npm's configured
 * registry and proxy. Returns `null` on any failure — timeout, network error, non-200, or a
 * response without a version; registries that require authentication are not supported.
 *
 * @param packageName - npm package name, e.g. `@openai/codex`
 * @param options.timeoutMs - abort the request after this long
 */
export function fetchLatestVersionFromRegistry(
  packageName: string,
  options: { timeoutMs: number; cwd?: string }
): Promise<string | null> {
  return new Promise((resolve) => {
    let url: URL;
    let config: NpmConfig;
    try {
      const cwd = options.cwd ?? process.cwd();
      config = loadNpmConfig(cwd);
      // `@scope/name` must be encoded as `@scope%2fname` for registries other than npmjs.
      url = new URL(`${packageName.replace('/', '%2f')}/latest`, resolveRegistry(packageName, cwd));
    } catch {
      resolve(null);
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      resolve(null);
      return;
    }

    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(
      url,
      { agent: proxyAgentFor(url, config), headers: { accept: 'application/json' }, timeout: options.timeoutMs },
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
    const deadline = setTimeout(() => request.destroy(), options.timeoutMs);
    request.on('close', () => {
      clearTimeout(deadline);
      resolve(null); // no-op if the response already resolved
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}
