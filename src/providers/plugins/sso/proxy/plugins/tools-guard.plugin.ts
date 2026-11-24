/**
 * Tools Guard Plugin
 * Priority: 14 (alongside the other request normalizers, before RequestSanitizer at 15)
 *
 * Status: compatibility SHIM. The rejecting layer is LiteLLM's Bedrock Converse transformation,
 * which refuses tool history (tool_use/tool_result, tool_calls) when `tools` is absent or empty,
 * as in compaction-style requests. This plugin injects an inert placeholder tool (and
 * optional tool_choice "none", currently disabled) based on body shape only, never on the model or a Bedrock check.
 *
 * Owner: proxy plugin owner. Superseded by an effective `modify_params` in the `codemie` repo.
 * Remove this plugin and `claude-tools-guard.ts` once that server flag is confirmed effective
 * for the Claude aliases.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '@/utils/logger.js';
import { CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE } from '../proxy-clients.js';
import { applyToolsGuard } from './claude-tools-guard.js';

const ALLOWED_AGENTS: readonly string[] = [
  'codemie-code',
  'codemie-claude',
  'codemie-claude-acp',
  'codemie-opencode',
  'codemie-opencode-acp',
  'codemie-copilot',
  CLAUDE_DESKTOP,
  VSCODE_CLAUDE_CODE,
];

/**
 * Generation endpoints only (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses).
 * Token-count and other auxiliary endpoints are left untouched so their results match what was sent.
 */
const GENERATION_PATH_PATTERN = /\/(?:messages|chat\/completions|responses)\/?$/;

function isGenerationEndpoint(url: string): boolean {
  const path = url.split('?', 1)[0];
  return GENERATION_PATH_PATTERN.test(path);
}

export class ToolsGuardPlugin implements ProxyPlugin {
  id = '@codemie/proxy-tools-guard';
  name = 'Tools Guard';
  version = '1.0.0';
  priority = 14; // Alongside the other request normalizers, before RequestSanitizer (15)
  clients = ALLOWED_AGENTS;

  async createInterceptor(_context: PluginContext): Promise<ProxyInterceptor> {
    return new ToolsGuardInterceptor();
  }
}

class ToolsGuardInterceptor implements ProxyInterceptor {
  name = 'tools-guard';

  async onRequest(context: ProxyContext): Promise<void> {
    if (
      !context.requestBody ||
      !context.headers['content-type']?.includes('application/json') ||
      !isGenerationEndpoint(context.url)
    ) {
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(context.requestBody.toString('utf-8'));
    } catch {
      return;
    }

    if (!body || typeof body !== 'object') return;

    const shape = applyToolsGuard(body);
    if (!shape) return;

    context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
    context.headers['content-length'] = String(context.requestBody.length);

    logger.debug(`[${this.name}] Injected placeholder tool (${shape} shape): tool history present without tools`);
  }
}
