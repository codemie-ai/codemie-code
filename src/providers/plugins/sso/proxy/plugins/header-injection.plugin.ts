/**
 * Header Injection Plugin
 * Priority: 20 (runs after auth)
 *
 * SOLID: Single responsibility = inject CodeMie headers
 * KISS: Straightforward header injection
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProviderRegistry } from '../../../../core/registry.js';
import { logger } from '../../../../../utils/logger.js';
import {
  getClaudeDesktopLocalSessionsRoot,
  getClaudeDesktopCodeSessionsRoot,
} from '../../../../../telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { walk } from '../../../../../telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import { extractRepository } from '../../../../../utils/paths.js';

export class HeaderInjectionPlugin implements ProxyPlugin {
  id = '@codemie/proxy-headers';
  name = 'Header Injection';
  version = '1.0.0';
  priority = 20;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    return new HeaderInjectionInterceptor(context);
  }
}

class HeaderInjectionInterceptor implements ProxyInterceptor {
  name = 'header-injection';

  constructor(private context: PluginContext) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Request and session ID headers
    context.headers['X-CodeMie-Request-ID'] = context.requestId;
    context.headers['X-CodeMie-Session-ID'] = context.sessionId;

    // LiteLLM can use these headers for Responses API session affinity when
    // its router is configured with session-aware pre-call checks.
    if (this.context.config.clientType === 'codemie-codex') {
      context.headers['x-litellm-session-id'] = context.sessionId;
    }

    // Add CLI version header
    const cliVersion = this.context.config.version || '0.0.0';
    context.headers['X-CodeMie-CLI'] = `codemie-cli/${cliVersion}`;

    const config = this.context.config;

    // Check if provider requires integration header
    const provider = ProviderRegistry.getProvider(config.provider || '');
    const requiresIntegration = provider?.customProperties?.requiresIntegration === true;

    // Add integration header for providers that require it
    if (requiresIntegration && config.integrationId) {
      context.headers['X-CodeMie-Integration'] = config.integrationId;
    }

    // Add model header if configured (for all providers)
    if (config.model) {
      context.headers['X-CodeMie-CLI-Model'] = config.model;
    }

    // Add timeout header if configured (for all providers)
    if (config.timeout) {
      context.headers['X-CodeMie-CLI-Timeout'] = String(config.timeout);
    }

    // Add client type header
    if (config.clientType) {
      context.headers['X-CodeMie-Client'] = config.clientType;
    }

    // Per-request repository resolution for Desktop mode.
    // Claude Desktop sends x-claude-code-session-id = cliSessionId (plain UUID, no local_ prefix).
    // The shared map is keyed by agentSessionId = cliSessionId, so look up directly.
    // On unknown session: targeted scan of Desktop session files → .git/config read → cache result.
    // If session file not on disk yet (first message race condition) → Default, not cached.
    if (config.sessionRepositoryMap) {
      const cliSessionId = context.headers['x-claude-code-session-id'];

      if (cliSessionId && !config.sessionRepositoryMap.has(cliSessionId)) {
        const workingDir = await findWorkingDirForSession(cliSessionId).catch(() => null);
        if (workingDir) {
          const repository = (await readGitRemoteLocal(workingDir)) ?? extractRepository(workingDir);
          config.sessionRepositoryMap.set(cliSessionId, repository);
          logger.debug('[header-injection] Resolved repository via targeted lookup', {
            cliSessionId, workingDir, repository,
          });
        }
      }

      const resolvedRepository = cliSessionId
        ? (config.sessionRepositoryMap.get(cliSessionId) ?? config.repository ?? 'Default')
        : (config.repository ?? 'Default');

      context.headers['X-CodeMie-Repository'] = resolvedRepository;
    } else {
      // Non-Desktop mode: use static config values
      if (config.repository) {
        context.headers['X-CodeMie-Repository'] = config.repository;
      }
    }

    if (config.branch) {
      context.headers['X-CodeMie-Branch'] = config.branch;
    }
    if (config.project) {
      context.headers['X-CodeMie-Project'] = config.project;
    }

    logger.debug(`[${this.name}] Injected CodeMie headers`);
  }
}

async function findWorkingDirForSession(cliSessionId: string): Promise<string | null> {
  const roots = [
    getClaudeDesktopLocalSessionsRoot(),
    getClaudeDesktopCodeSessionsRoot(),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = await walk(root);
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
        if (json['cliSessionId'] !== cliSessionId) continue;
        const folders = json['userSelectedFolders'] as string[] | undefined;
        const workingDir =
          (json['originCwd'] as string | undefined)
          ?? (json['worktreePath'] as string | undefined)
          ?? folders?.[0]
          ?? (json['cwd'] as string | undefined);
        return workingDir ?? null;
      } catch { /* skip unreadable files */ }
    }
  }

  return null;
}

async function readGitRemoteLocal(dir: string): Promise<string | null> {
  try {
    const gitConfig = await readFile(join(dir, '.git', 'config'), 'utf-8');
    const match = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
    if (!match) return null;
    const repo = extractRepository(match[1].trim());
    return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  } catch {
    return null;
  }
}

