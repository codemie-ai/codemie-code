/**
 * Haiku Thinking Disabler Plugin
 * Priority: 6 (after EndpointBlocker at 5, before auth plugins)
 *
 * Problem: Haiku 4-5 and similar models do not support thinking (extended output).
 * When thinking is present in the request, the API returns an error or unexpected
 * thinking blocks that break downstream processing.
 *
 * Fix:
 *   - First request per session with thinking enabled: short-circuit with an alert
 *     message instructing the user to disable thinking. Does NOT forward upstream.
 *   - Subsequent requests: strip the thinking field silently and forward normally.
 *
 * Scope: Only enabled for codemie-claude agent (Claude Code via SSO proxy).
 *
 * To add support for a new model: append a pattern to NO_THINKING_MODEL_PATTERNS.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Model name patterns that do NOT support thinking.
 * Matches claude-haiku-4-5 and any date-tagged variants (e.g. claude-haiku-4-5-20251001).
 */
const NO_THINKING_MODEL_PATTERNS: RegExp[] = [
  /claude-haiku-4-5(?:[^0-9]|$)/i,
];

function modelDisablesThinking(modelName: string): boolean {
  return NO_THINKING_MODEL_PATTERNS.some(p => p.test(modelName));
}

function isThinkingEnabled(body: Record<string, unknown>): boolean {
  if (!body.thinking || typeof body.thinking !== 'object') return false;
  const thinking = body.thinking as Record<string, unknown>;
  return thinking.type === 'enabled' || thinking.enabled === true;
}

function buildAlertText(model: string): string {
  return (
    `\u26a0\ufe0f Thinking is not supported for model '${model}' and has been automatically disabled.\n` +
    `To avoid this message in future sessions, disable thinking in Claude Code: ` +
    `Settings \u2192 Claude Code \u2192 Extended Thinking \u2192 Disabled.`
  );
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendAlertJson(res: ServerResponse, model: string, text: string): void {
  const body = JSON.stringify({
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: text.length }
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendAlertSse(res: ServerResponse, model: string, text: string): void {
  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const events: string[] = [
    sseEvent('message_start', {
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('ping', { type: 'ping' }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: text.length } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ];
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.end(events.join(''));
}

const ALLOWED_AGENT = 'codemie-claude';

export class HaikuThinkingDisablerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-haiku-thinking-disabler';
  name = 'Haiku Thinking Disabler';
  version = '2.0.0';
  priority = 6; // After EndpointBlocker (5), before auth plugins

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || clientType !== ALLOWED_AGENT) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new HaikuThinkingDisablerInterceptor(context.config.model);
  }
}

class HaikuThinkingDisablerInterceptor implements ProxyInterceptor {
  name = 'haiku-thinking-disabler';
  private hasAlerted = false;

  constructor(private readonly configModel?: string) {}

  /**
   * First request with thinking enabled for a no-thinking model: send one-time alert,
   * block forwarding. Returns true to short-circuit the pipeline.
   */
  async handleRequest(
    context: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    if (this.hasAlerted) return false;
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return false;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(context.requestBody.toString('utf-8'));
    } catch {
      return false;
    }

    if (!isThinkingEnabled(body)) return false;

    const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
    if (!model || !modelDisablesThinking(model)) return false;

    this.hasAlerted = true;
    const text = buildAlertText(model);
    logger.debug(`[${this.name}] Sending one-time alert: thinking unsupported for model: ${model}`);

    if (body.stream === true) {
      sendAlertSse(res, model, text);
    } else {
      sendAlertJson(res, model, text);
    }

    return true;
  }

  /**
   * All subsequent requests: strip thinking field and forward normally.
   */
  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr);

      if (!body.thinking) return;

      const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
      if (!model || !modelDisablesThinking(model)) return;

      delete body.thinking;
      logger.debug(`[${this.name}] Stripped thinking field for unsupported model: ${model}`);

      const newBodyStr = JSON.stringify(body);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged
    }
  }
}
