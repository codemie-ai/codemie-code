/**
 * Claude Desktop's applied inference config, read as the gateway it points at: the one rule of what a CodeMie
 * gateway config is (a gateway config with a loopback URL) for the connector's writer, its disconnect and every
 * reader of whether Desktop is connected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { CLAUDE_DESKTOP, clientOfGatewayKey } from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { getClaudeDesktopBaseDir } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

/**
 * The loopback gateway Desktop's applied config points at: its port and the key Desktop sends, or `sealed` when
 * Desktop has sealed the key (only Desktop opens it, so it neither proves nor refutes whose key it is).
 */
export interface DesktopGateway {
  port: number;
  apiKey?: string;
  sealed?: true;
}

const SEALED_KEY_PREFIX = '__sealed__:';

function isSealedKey(value: string): boolean {
  return value.trimStart().startsWith(SEALED_KEY_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `appliedId` of a parsed `_meta.json`, only when it is safe as a file name; else no applied config. */
export function appliedConfigId(meta: unknown): string | undefined {
  const appliedId = isRecord(meta) ? meta.appliedId : undefined;
  return typeof appliedId === 'string' && isSafeSessionId(appliedId) ? appliedId : undefined;
}

export function isLoopbackGatewayUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/** A gateway config pointing at a loopback address: the shape `connect` writes, as opposed to a user's own gateway. */
export function isCodeMieGatewayConfig(config: Record<string, unknown>): boolean {
  return config.inferenceProvider === 'gateway' && isLoopbackGatewayUrl(config.inferenceGatewayBaseUrl);
}

/**
 * The gateway of a parsed Desktop config entry when it is a CodeMie gateway config whose URL has a port, else null.
 * A sealed key is returned as `sealed`, never as `apiKey`. Reads no `inferenceCredentialKind`; never throws.
 */
export function desktopGatewayOfEntry(config: unknown): DesktopGateway | null {
  if (!isRecord(config) || !isCodeMieGatewayConfig(config)) return null;
  const port = Number.parseInt(new URL(config.inferenceGatewayBaseUrl as string).port, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  const apiKey = config.inferenceGatewayApiKey;
  if (typeof apiKey !== 'string') return { port };
  return isSealedKey(apiKey) ? { port, sealed: true } : { port, apiKey };
}

/** Desktop's applied config as one read tells it: its CodeMie gateway, and whether it names a gateway at all. */
export interface DesktopGatewayState {
  gateway: DesktopGateway | null;
  /**
   * The applied entry's inference provider is a gateway, whatever its URL; false with no `_meta.json`, no usable
   * `appliedId`, no applied entry file or another provider; true when the config could not be read otherwise (what
   * cannot be read is not taken for "no gateway").
   */
  namesGateway: boolean;
}

/**
 * Desktop's applied config (`configLibrary/_meta.json` → `<appliedId>.json`) from one read: its gateway as
 * {@link readDesktopGatewayConfig} gives it, and whether it names a gateway. Never throws.
 */
export async function readDesktopGatewayState(baseDir?: string): Promise<DesktopGatewayState> {
  try {
    const libDir = join(baseDir ?? getClaudeDesktopBaseDir(), 'configLibrary');
    const meta: unknown = JSON.parse(await readFile(join(libDir, '_meta.json'), 'utf-8'));
    const appliedId = appliedConfigId(meta);
    if (!appliedId) return { gateway: null, namesGateway: false };
    const entry: unknown = JSON.parse(await readFile(join(libDir, `${appliedId}.json`), 'utf-8'));
    return { gateway: desktopGatewayOfEntry(entry), namesGateway: isRecord(entry) && entry.inferenceProvider === 'gateway' };
  } catch (error) {
    logger.debug('[claude-desktop] Claude Desktop gateway not readable', ...sanitizeLogArgs(error));
    return { gateway: null, namesGateway: (error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT' };
  }
}

/**
 * The gateway of Desktop's applied config (`configLibrary/_meta.json` → `<appliedId>.json`), as
 * `desktopGatewayOfEntry` reads it, else null: no applied config or an unsafe `appliedId`, another config,
 * anything unreadable, an unsupported platform. Never throws.
 */
export async function readDesktopGatewayConfig(baseDir?: string): Promise<DesktopGateway | null> {
  return (await readDesktopGatewayState(baseDir)).gateway;
}

/**
 * Desktop pointed at a local proxy of gateway key `key`: on any loopback port, with the shared key or
 * `claude-desktop`'s, or with a sealed key (the loopback gateway alone then decides).
 */
export function isDesktopPointedAtLocalProxy(gateway: DesktopGateway | null, key: string): boolean {
  if (!gateway) return false;
  if (gateway.sealed) return true;
  if (gateway.apiKey === undefined) return false;
  const named = clientOfGatewayKey(`Bearer ${gateway.apiKey}`, key);
  return named !== null && (named.client === undefined || named.client === CLAUDE_DESKTOP);
}

/** Desktop connected to the daemon of gateway key `key` on `port`: pointed at a local proxy, on that port. */
export function isDesktopConnectedTo(gateway: DesktopGateway | null, key: string, port: number): boolean {
  return gateway?.port === port && isDesktopPointedAtLocalProxy(gateway, key);
}
