import { createHash } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { getMCPConfigSummary } from '@/utils/mcp-config.js';
import { resolveEnvFields } from '@/agents/core/event-fields/env-fields.js';
import { ClaudePluginMetadata } from '@/agents/plugins/claude/claude.plugin.js';

export interface SessionEnvFields {
  provider: string;
  api_host: string;
  configured_model: string;
  effort: string;
  permission_mode: string;
  output_style: string;
  plugins: Record<string, string>;
  mcp_servers: string[];
  os: string;
  arch: string;
  node_version: string;
  timezone: string;
  hostname_hash: string;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Claude Code's local base-URL loopback ports (its own SSO proxy) vs. any other custom host. */
function resolveProviderAndHost(): { provider: string; api_host: string } {
  const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';
  if (truthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    return { provider: 'bedrock', api_host: '' };
  }
  if (truthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    return { provider: 'vertex', api_host: '' };
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? '';
  if (!baseUrl) {
    return { provider: 'anthropic', api_host: 'api.anthropic.com' };
  }
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return { provider: 'anthropic', api_host: '' };
  }
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
  return { provider: isLoopback ? 'codemie-proxy' : 'litellm-proxy', api_host: host };
}

/**
 * `outputStyle`, cascaded local -> project -> user (first file that sets it wins, matching Claude
 * Code's own settings override order).
 */
async function resolveOutputStyle(cwd: string): Promise<string> {
  const candidates = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(resolveHomeDir(), '.claude', 'settings.json'),
  ];
  for (const path of candidates) {
    const settings = await readJsonFile(path);
    const style = settings?.outputStyle;
    if (typeof style === 'string' && style) {
      return style;
    }
  }
  return '';
}

/** Union of `enabledPlugins` keys (`"<name>@<marketplace>"`) set `true` across every settings scope. */
async function resolveEnabledPluginKeys(cwd: string): Promise<string[]> {
  const paths = [
    join(resolveHomeDir(), '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  const keys = new Set<string>();
  for (const path of paths) {
    const settings = await readJsonFile(path);
    const enabled = settings?.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') continue;
    for (const [key, value] of Object.entries(enabled as Record<string, unknown>)) {
      if (value === true) keys.add(key);
    }
  }
  return [...keys];
}

interface InstalledPluginEntry {
  scope?: string;
  projectPath?: string;
  version?: string;
}

/**
 * Maps each enabled plugin key to its installed version via `~/.claude/plugins/installed_plugins.json`.
 * Prefers the entry scoped to this project over the user-level one; a plugin with no recorded
 * version/entry is omitted rather than reported as `''`.
 */
async function resolvePluginVersions(cwd: string, enabledKeys: string[]): Promise<Record<string, string>> {
  if (enabledKeys.length === 0) {
    return {};
  }
  const registry = await readJsonFile(join(resolveHomeDir(), '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== 'object') {
    return {};
  }

  const versions: Record<string, string> = {};
  for (const key of enabledKeys) {
    const entries = (plugins as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    const typedEntries = entries as InstalledPluginEntry[];
    const projectEntry = typedEntries.find((e) => e.scope === 'project' && e.projectPath === cwd);
    const userEntry = typedEntries.find((e) => e.scope === 'user');
    const version = (projectEntry ?? userEntry ?? typedEntries[0])?.version;
    if (version) versions[key] = version;
  }
  return versions;
}

function hashHostname(): string {
  try {
    return createHash('sha256').update(os.hostname()).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Builds every field for `agent.session.env`. Never throws: any
 * individual lookup failure degrades that field to its empty default.
 */
export async function resolveSessionEnvFields(
  cwd: string,
  configuredModel: string,
  permissionMode: string
): Promise<SessionEnvFields> {
  try {
    const [{ provider, api_host }, outputStyle, enabledPluginKeys, mcpSummary, envFields] = await Promise.all([
      Promise.resolve(resolveProviderAndHost()),
      resolveOutputStyle(cwd),
      resolveEnabledPluginKeys(cwd),
      getMCPConfigSummary(ClaudePluginMetadata.mcpConfig, cwd),
      // Same resolver `onSessionStart` already calls for `agent.session.start`'s own `os`/
      // `timezone` — reused here rather than reimplemented, so the two records in one
      // `SessionStart` fire never compute these independently.
      resolveEnvFields(),
    ]);
    const plugins = await resolvePluginVersions(cwd, enabledPluginKeys);

    return {
      provider,
      api_host,
      configured_model: configuredModel,
      // Absent on session-lifecycle hooks per the SDK's own BaseHookInput contract (only
      // present on tool-use-context hooks) — left empty here, not fabricated.
      effort: '',
      permission_mode: permissionMode,
      output_style: outputStyle,
      plugins,
      mcp_servers: mcpSummary.serverNames,
      os: envFields.os,
      arch: os.arch(),
      node_version: process.version,
      timezone: envFields.timezone,
      hostname_hash: hashHostname(),
    };
  } catch (error) {
    logger.debug(`[claude-code-otlp] session-env field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      provider: '',
      api_host: '',
      configured_model: configuredModel,
      effort: '',
      permission_mode: permissionMode,
      output_style: '',
      plugins: {},
      mcp_servers: [],
      os: '',
      arch: '',
      node_version: '',
      timezone: '',
      hostname_hash: '',
    };
  }
}
