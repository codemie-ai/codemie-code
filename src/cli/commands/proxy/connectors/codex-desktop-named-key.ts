import { lstat, readFile } from 'node:fs/promises';
import TOML from '@iarna/toml';

import { CODEX_DESKTOP } from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

import { CODEMIE_PROVIDER_ID, findManagedRegions, replaceManagedAuthorization } from './codex-config-toml.js';
import { getCodexDesktopConfigPath } from './codex-desktop.js';
import { gatewayKeyReading, loopbackPortOf, writeAtomically, type ConnectorGateway } from './vscode.js';

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What `connect` wrote into the Codex config, read for the daemon of gateway key `key`: the port of the managed
 * provider's `base_url` and how the daemon reads its `Authorization`; null when the file is missing or not valid
 * TOML, holds no managed provider block, or its `base_url` is not a loopback URL with a port. Never throws, writes
 * nothing.
 */
export async function readCodexDesktopGateway(
  key: string,
  configPath: string = getCodexDesktopConfigPath()
): Promise<ConnectorGateway | null> {
  try {
    const text = await readFile(configPath, 'utf-8');
    if (!findManagedRegions(text).table) return null;
    const parsed = TOML.parse(text) as Record<string, unknown>;
    const providers = parsed.model_providers;
    const provider = isTable(providers) ? providers[CODEMIE_PROVIDER_ID] : undefined;
    if (!isTable(provider)) return null;
    const port = loopbackPortOf(provider.base_url);
    if (port === null) return null;
    const authorization = isTable(provider.http_headers) ? provider.http_headers.Authorization : undefined;
    return { port, key: gatewayKeyReading(typeof authorization === 'string' ? authorization : undefined, key) };
  } catch (error) {
    logger.debug('[proxy] Codex config not readable', ...sanitizeLogArgs({ configPath, error: String(error) }));
    return null;
  }
}

/**
 * Moves the Codex config from the shared key of the daemon of gateway key `gatewayKey`, listening on `port`, to
 * Codex's named key: only the `Authorization` value of the managed provider table becomes
 * `Bearer <gatewayKey>.codex-desktop`; no backup and no state file is written. `moved` when written; `left` for a
 * config file that is a symbolic link, not written; `unchanged` when the reader gives another port than `port` or
 * anything but the shared key (a named or refused key, no CodeMie block, a missing or unreadable file). A failed
 * write, or a result that would not read back as the named key, throws.
 */
export async function moveCodexDesktopToNamedKey(
  gatewayKey: string,
  port: number,
  configPath: string = getCodexDesktopConfigPath()
): Promise<'moved' | 'left' | 'unchanged'> {
  const gateway = await readCodexDesktopGateway(gatewayKey, configPath);
  if (gateway?.port !== port || gateway.key !== 'shared') return 'unchanged';
  if ((await lstat(configPath)).isSymbolicLink()) return 'left';

  const namedKey = `${gatewayKey}.${CODEX_DESKTOP}`;
  const next = replaceManagedAuthorization(await readFile(configPath, 'utf-8'), namedKey);
  const providers = next === null ? undefined : (TOML.parse(next) as Record<string, unknown>).model_providers;
  const provider = isTable(providers) ? providers[CODEMIE_PROVIDER_ID] : undefined;
  const headers = isTable(provider) ? provider.http_headers : undefined;
  if (next === null || !isTable(headers) || headers.Authorization !== `Bearer ${namedKey}`) {
    throw new ConfigurationError(
      `Refusing to write ${configPath}: the managed Authorization could not be replaced. The file is unchanged.`
    );
  }

  await writeAtomically(configPath, next);
  logger.info('[proxy] Moved Codex desktop to its named key', ...sanitizeLogArgs({ configPath }));
  return 'moved';
}
