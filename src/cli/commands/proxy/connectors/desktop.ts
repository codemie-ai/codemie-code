import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getClaudeDesktopBaseDir } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import managedMcpServers from './desktop-managed-mcp-servers.json' with { type: 'json' };

const INFERENCE_KEYS = [
  'inferenceProvider',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme',
] as const;

interface InferenceModelEntry {
  name: string;
}

interface ManagedMcpServerEntry {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  oauth?: boolean;
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Curated list of Claude models we expose by default.
 *
 * Each entry is matched against the gateway's `/v1/models` response either as
 * an exact ID or as `<entry>-<YYYYMMDD>` (the dated variant). The actual
 * resolved ID is what gets written to the Desktop config so the gateway
 * receives a model name it has registered.
 */
export const PREFERRED_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-haiku-4-5',
] as const;

export const DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS = ['*'] as const;

export const DEFAULT_MANAGED_MCP_SERVERS =
  managedMcpServers as readonly ManagedMcpServerEntry[];

/**
 * Fetch the model list from the gateway's `/v1/models` endpoint and return
 * the IDs of usable Claude-family models (excludes `-vertex` aliases since
 * the gateway already picks the right backend for the canonical names).
 *
 * Returns [] if the gateway is unreachable or returns a non-OK response.
 */
export async function fetchClaudeModels(proxyUrl: string, gatewayKey: string): Promise<string[]> {
  try {
    const response = await fetch(new URL('/v1/models', proxyUrl), {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    if (!response.ok) return [];
    const json = await response.json() as ModelsListResponse;
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return ids
      .filter((id) => /^claude-/i.test(id))
      .filter((id) => !/-vertex$/i.test(id));
  } catch {
    return [];
  }
}

/**
 * Resolve each entry in {@link PREFERRED_CLAUDE_MODELS} against the gateway's
 * `/v1/models` response. For each preferred name, prefer the exact ID; fall
 * back to the dated variant `<preferred>-YYYYMMDD` (latest if multiple).
 * Entries with no available match are dropped silently.
 *
 * Preserves the order of {@link PREFERRED_CLAUDE_MODELS}.
 */
export function selectPreferredClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const availableSet = new Set(available);
  const resolved: string[] = [];
  for (const name of preferred) {
    if (availableSet.has(name)) {
      resolved.push(name);
      continue;
    }
    const datePrefix = `${name}-`;
    const dated = available
      .filter((id) => id.startsWith(datePrefix))
      .filter((id) => /^\d{6,10}$/.test(id.slice(datePrefix.length)))
      .sort()
      .pop();
    if (dated) resolved.push(dated);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getManagedMcpServerName(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  return typeof server.name === 'string' ? server.name : undefined;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function mergeManagedMcpServers(existingServers: unknown): unknown[] {
  const merged = [...parseJsonArray(existingServers)];
  const existingNames = new Set(
    merged
      .map((server) => getManagedMcpServerName(server)?.toLowerCase())
      .filter((name): name is string => Boolean(name))
  );

  for (const server of DEFAULT_MANAGED_MCP_SERVERS) {
    if (!existingNames.has(server.name.toLowerCase())) {
      merged.push({ ...server });
    }
  }

  return merged;
}

export interface DesktopGatewayConfig {
  inferenceProvider: 'gateway';
  inferenceGatewayBaseUrl: string;
  inferenceGatewayApiKey: string;
  inferenceGatewayAuthScheme: 'bearer';
}

interface ConfigMetaEntry {
  id: string;
  name: string;
}

interface ConfigMeta {
  appliedId?: string;
  entries?: ConfigMetaEntry[];
}

export function buildGatewayConfig(proxyUrl: string, gatewayKey: string): DesktopGatewayConfig {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: proxyUrl,
    inferenceGatewayApiKey: gatewayKey,
    inferenceGatewayAuthScheme: 'bearer',
  };
}

/**
 * Returns the base directory where Claude Desktop (3P) stores its config.
 * macOS: ~/Library/Application Support/Claude-3p
 * Windows: %APPDATA%\Claude-3p
 */
export function getDesktopBaseDir(): string {
  return getClaudeDesktopBaseDir();
}

/**
 * Returns the path to the active inference config JSON file under configLibrary/.
 * If `_meta.json` doesn't exist or has no `appliedId`, returns the path that
 * a freshly-generated UUID would use; the caller is responsible for creating
 * `_meta.json` to register it.
 */
export async function getDesktopConfigPath(baseDir: string = getDesktopBaseDir()): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  const metaPath = join(libDir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
      if (meta.appliedId) return join(libDir, `${meta.appliedId}.json`);
    } catch {
      // Corrupt meta — fall through to fresh UUID
    }
  }
  return join(libDir, `${randomUUID()}.json`);
}

/**
 * Write/merge the CodeMie gateway settings into Claude Desktop's
 * `configLibrary/<UUID>.json` and update `_meta.json` so the app picks them up.
 *
 * Preserves unrelated keys in the existing config file.
 * Returns the absolute path of the config file written.
 */
export async function writeDesktopConfig(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string = getDesktopBaseDir()
): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  if (!existsSync(libDir)) {
    await mkdir(libDir, { recursive: true });
  }

  const metaPath = join(libDir, '_meta.json');
  let meta: ConfigMeta = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
    } catch {
      meta = {};
    }
  }

  const configId = meta.appliedId ?? randomUUID();
  const configPath = join(libDir, `${configId}.json`);

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  // Discover available Claude models from the gateway and curate down to the
  // preferred set so the user doesn't have to type them manually in the GUI.
  const discoveredModels = await fetchClaudeModels(proxyUrl, gatewayKey);
  const resolvedModels = selectPreferredClaudeModels(discoveredModels);
  const inferenceModels: InferenceModelEntry[] = resolvedModels.map((name) => ({ name }));
  const managedMcpServers = mergeManagedMcpServers(existing.managedMcpServers);

  for (const key of INFERENCE_KEYS) {
    delete existing[key];
  }
  delete existing.inferenceModels;
  delete existing.coworkEgressAllowedHosts;
  delete existing.managedMcpServers;

  const merged = {
    ...existing,
    ...buildGatewayConfig(proxyUrl, gatewayKey),
    ...(inferenceModels.length > 0 ? { inferenceModels: JSON.stringify(inferenceModels) } : {}),
    coworkEgressAllowedHosts: JSON.stringify([...DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS]),
    managedMcpServers: JSON.stringify(managedMcpServers),
  };
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');

  const entries = meta.entries ?? [];
  if (!entries.find((e) => e.id === configId)) {
    entries.push({ id: configId, name: 'CodeMie Proxy' });
  }
  const updatedMeta: ConfigMeta = {
    appliedId: configId,
    entries,
  };
  await writeFile(metaPath, JSON.stringify(updatedMeta, null, 2), 'utf-8');

  return configPath;
}
