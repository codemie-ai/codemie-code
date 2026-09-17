import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { getCodemiePath } from '../../../../../utils/paths.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../core/types.js';
import { buildAuthHeaders } from '../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../sso.http-client.js';

interface OtlpEventPayload {
  agentName: string;
  timestamp: string;
  raw: string;
}

type OtlpAttr = { key: string; value: { stringValue: string } };

const EVENT_TYPE_MAP: Record<string, string> = {
  sessionStart: 'agent.session.start',
  sessionEnd: 'agent.session.end',
  stop: 'agent.session.stop',
  preToolUse: 'agent.tool.start',
  postToolUse: 'agent.tool.end',
  postToolUseFailure: 'agent.tool.error',
  beforeSubmitPrompt: 'agent.prompt.submit',
  subagentStart: 'agent.subagent.start',
  subagentStop: 'agent.subagent.stop',
  preCompact: 'agent.session.compact',
};

export class OtlpIngestPlugin implements ProxyPlugin {
  id = '@codemie/proxy-otlp-ingest';
  name = 'OTLP Ingestion';
  version = '1.0.0';
  priority = 10; // After gateway-key (priority 7)

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new OtlpIngestInterceptor(
      context.syncCredentials || context.credentials,
      context.config.syncApiUrl ?? context.config.targetApiUrl
    );
  }
}

class OtlpIngestInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';

  constructor(
    private readonly credentials?: SSOCredentials | JWTCredentials,
    private readonly baseUrl?: string
  ) { }

  async handleRequest(
    ctx: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    // Only handle POST /v1/otlp/hook-events
    if (ctx.method !== 'POST' || ctx.url !== '/v1/otlp/hook-events') {
      return false;
    }

    // Require gateway key validation (done by gateway-key plugin before this runs)
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn(
        '[otlp-ingest] Rejected request: gateway key not validated',
        ...sanitizeLogArgs({ url: ctx.url })
      );
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Unauthorized' },
      }));
      return true;
    }

    try {
      // Parse request body as JSON
      if (!ctx.requestBody) {
        logger.warn('[otlp-ingest] Received request with empty body');
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Empty body' },
        }));
        return true;
      }

      let payload: OtlpEventPayload;
      try {
        const bodyStr = ctx.requestBody.toString('utf-8');
        payload = JSON.parse(bodyStr) as OtlpEventPayload;
      } catch (parseError) {
        logger.warn(
          '[otlp-ingest] Failed to parse JSON body',
          ...sanitizeLogArgs({
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
          })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid JSON' },
        }));
        return true;
      }

      // Validate required fields
      if (!payload.agentName || !payload.timestamp || !payload.raw) {
        logger.warn(
          '[otlp-ingest] Missing required fields',
          ...sanitizeLogArgs({
            hasAgentName: Boolean(payload.agentName),
            hasTimestamp: Boolean(payload.timestamp),
            hasRaw: Boolean(payload.raw),
          })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Missing required fields' },
        }));
        return true;
      }

      // This endpoint is gated only by the shared local gateway key, not by
      // agent identity, so reject an agentName that isn't a known agent id
      // rather than letting an arbitrary/spoofed value be attributed in the
      // ingested analytics.
      const { AgentRegistry } = await import('../../../../../agents/registry.js');
      if (!AgentRegistry.getAgentNames().includes(payload.agentName)) {
        logger.warn(
          '[otlp-ingest] Rejected request: unrecognized agentName',
          ...sanitizeLogArgs({ agentName: payload.agentName })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Unrecognized agentName' },
        }));
        return true;
      }

      // Append event to hook-events.jsonl. The directory and file carry the
      // 0o700/0o600 modes security-practices.md requires for ~/.codemie/logs/,
      // since this file now stores raw hook payloads that may contain
      // sensitive content.
      const logPath = getCodemiePath('logs', 'hook-events.jsonl');
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      await appendFile(logPath, `${JSON.stringify(payload)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });

      logger.info(
        '[otlp-ingest] Appended event',
        ...sanitizeLogArgs({
          agentName: payload.agentName,
          path: logPath,
        })
      );

      void this.dispatchOtlpSignals(payload).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.info('[otlp-ingest] dispatch error', ...sanitizeLogArgs({ err: msg }));
      });

      // Return 202 Accepted
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    } catch (error) {
      logger.error(
        '[otlp-ingest] Unexpected error',
        ...sanitizeLogArgs({
          error: error instanceof Error ? error.message : String(error),
        })
      );
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'internal_server_error', message: 'Internal server error' },
      }));
      return true;
    }
  }

  private nowNs(): string {
    return (BigInt(Date.now()) * 1_000_000n).toString();
  }

  private toTraceId(sessionId: string): string {
    return createHash('sha256').update(String(sessionId || '')).digest('hex').slice(0, 32);
  }

  private toSpanId(id: string): string {
    return createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16);
  }

  private extractCwd(event: Record<string, unknown>): string {
    const roots = event['workspace_roots'];
    if (Array.isArray(roots) && roots.length > 0) return String(roots[0]);
    return String(event['cwd'] || '');
  }

  private extractPromptBody(event: Record<string, unknown>): string {
    if (typeof event['prompt'] === 'string') return event['prompt'];
    if (typeof event['message'] === 'string') return event['message'];
    const messages = event['messages'];
    if (Array.isArray(messages) && messages.length > 0) {
      const lastUser = [...messages].reverse().find((m: unknown) => {
        return typeof m === 'object' && m !== null &&
          (m as Record<string, unknown>)['role'] === 'user';
      });
      if (lastUser) {
        const content = (lastUser as Record<string, unknown>)['content'];
        if (typeof content === 'string') return content;
      }
    }
    return '';
  }

  private extractFilePath(toolName: string, toolInput: unknown): string {
    let input = toolInput;
    if (typeof input === 'string') {
      try { input = JSON.parse(input) as unknown; } catch { return ''; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    const inp = input as Record<string, unknown>;
    return String(inp['file_path'] ?? inp['path'] ?? inp['notebook_path'] ?? '');
  }

  private skillNameFromPath(filePath: string): string {
    if (!filePath) return '';
    const SKILL_RE = /(?:^|[/\\])skills[/\\]|SKILL\.md$/i;
    if (!SKILL_RE.test(filePath)) return '';
    const parts = filePath.split(/[/\\]/);
    const idx = parts.findIndex(p => p.toLowerCase() === 'skills');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    const last = parts[parts.length - 1];
    return last ? last.replace(/\.md$/i, '') : '';
  }

  private resolveUserEmail(event: Record<string, unknown>): string {
    if (typeof event['user_email'] === 'string' && event['user_email']) {
      return event['user_email'];
    }
    if (this.credentials && isJWTCredentials(this.credentials)) {
      try {
        const parts = this.credentials.token.split('.');
        if (parts.length >= 2) {
          const claims = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf-8')
          ) as Record<string, unknown>;
          if (typeof claims['email'] === 'string' && claims['email']) {
            return claims['email'];
          }
        }
      } catch { /* ignore decode failures */ }
    }
    return '';
  }

  private wrapLogs(records: object[]): object {
    return {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cursor-agent' } }] },
        scopeLogs: [{ scope: {}, logRecords: records }],
      }],
    };
  }

  private wrapTraces(spans: object[]): object {
    return {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cursor-agent' } }] },
        scopeSpans: [{ scope: {}, spans }],
      }],
    };
  }

  private wrapMetrics(metrics: object[]): object {
    return {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cursor-agent' } }] },
        scopeMetrics: [{ scope: {}, metrics }],
      }],
    };
  }

  private buildLogRecord(event: Record<string, unknown>, hookName: string, tsNs: string): object {
    const eventType = EVENT_TYPE_MAP[hookName] ?? hookName;
    const toolUseId = String(event['tool_use_id'] ?? '').replace(/\n/g, '_');
    const userEmail = this.resolveUserEmail(event);
    const attrs: OtlpAttr[] = [
      { key: 'event_type', value: { stringValue: eventType } },
      { key: 'session_id', value: { stringValue: String(event['session_id'] ?? '') } },
      { key: 'developer_name', value: { stringValue: userEmail } },
      { key: 'user.email', value: { stringValue: userEmail } },
      { key: 'cwd', value: { stringValue: this.extractCwd(event) } },
      { key: 'git_branch', value: { stringValue: '' } },
      { key: 'repo_remote', value: { stringValue: '' } },
      { key: 'tool_name', value: { stringValue: String(event['tool_name'] ?? '') } },
      { key: 'tool_use_id', value: { stringValue: toolUseId } },
      { key: 'tool_input', value: { stringValue: event['tool_input'] ? JSON.stringify(event['tool_input']) : '' } },
      { key: 'tool_output', value: { stringValue: typeof event['tool_output'] === 'string' ? event['tool_output'] : event['tool_output'] != null ? JSON.stringify(event['tool_output']) : '' } },
      { key: 'codemie_project_name', value: { stringValue: '' } },
      { key: 'prompt_body', value: { stringValue: hookName === 'beforeSubmitPrompt' ? this.extractPromptBody(event) : '' } },
      { key: 'slash_command', value: { stringValue: '' } },
      { key: 'agent_type', value: { stringValue: String(event['subagent_type'] ?? '') } },
    ];
    return {
      timeUnixNano: tsNs,
      observedTimeUnixNano: tsNs,
      severityNumber: 9,
      severityText: 'INFO',
      body: { stringValue: '' },
      attributes: attrs,
    };
  }

  private buildToolSpan(event: Record<string, unknown>, tsNs: string): object {
    const sessionId = String(event['session_id'] ?? '');
    const toolUseId = String(event['tool_use_id'] ?? '').replace(/\n/g, '_');
    const startNs = this.startNsFromDurationMs(tsNs, event['duration']);
    const filePath = this.extractFilePath(String(event['tool_name'] ?? ''), event['tool_input']);
    return {
      traceId: this.toTraceId(sessionId),
      spanId: this.toSpanId(toolUseId || (sessionId + tsNs)),
      name: 'claude_code.tool',
      kind: 1,
      startTimeUnixNano: startNs,
      endTimeUnixNano: tsNs,
      status: { code: 1 },
      attributes: [
        { key: 'session.id', value: { stringValue: sessionId } },
        { key: 'tool_name', value: { stringValue: String(event['tool_name'] ?? '') } },
        { key: 'tool_use_id', value: { stringValue: toolUseId } },
        { key: 'file_path', value: { stringValue: filePath } },
        { key: 'subagent_type', value: { stringValue: String(event['subagent_type'] ?? '') } },
        { key: 'skill_name', value: { stringValue: this.skillNameFromPath(filePath) } },
      ],
    };
  }

  private buildInteractionSpan(event: Record<string, unknown>, tsNs: string): object {
    const sessionId = String(event['session_id'] ?? '');
    const genId = String(event['generation_id'] ?? '');
    return {
      traceId: this.toTraceId(sessionId),
      spanId: this.toSpanId(genId || (sessionId + tsNs)),
      name: 'claude_code.interaction',
      kind: 1,
      startTimeUnixNano: tsNs,
      endTimeUnixNano: tsNs,
      status: { code: 1 },
      attributes: [
        { key: 'session.id', value: { stringValue: sessionId } },
      ],
    };
  }

  private buildSubagentSpan(event: Record<string, unknown>, tsNs: string): object {
    const sessionId = String(event['session_id'] ?? '');
    const subagentId = String(event['subagent_id'] ?? '');
    const startNs = this.startNsFromDurationMs(tsNs, event['duration_ms']);
    return {
      traceId: this.toTraceId(sessionId),
      spanId: this.toSpanId(subagentId || (sessionId + tsNs)),
      name: 'claude_code.subagent',
      kind: 1,
      startTimeUnixNano: startNs,
      endTimeUnixNano: tsNs,
      status: { code: event['status'] === 'error' ? 2 : 1 },
      attributes: [
        { key: 'session.id', value: { stringValue: sessionId } },
        { key: 'subagent_id', value: { stringValue: subagentId } },
        { key: 'subagent_type', value: { stringValue: String(event['subagent_type'] ?? '') } },
        { key: 'status', value: { stringValue: String(event['status'] ?? '') } },
        { key: 'duration_ms', value: { stringValue: String(Number(event['duration_ms'] ?? 0)) } },
        { key: 'tool_call_count', value: { stringValue: String(Number(event['tool_call_count'] ?? 0)) } },
        { key: 'message_count', value: { stringValue: String(Number(event['message_count'] ?? 0)) } },
      ],
    };
  }

  private startNsFromDurationMs(tsNs: string, rawDur: unknown): string {
    const durationNs = BigInt(Math.round(Number.isFinite(Number(rawDur)) ? Math.max(0, Number(rawDur)) : 0) * 1_000_000);
    const endNs = BigInt(tsNs);
    return endNs > durationNs ? (endNs - durationNs).toString() : '0';
  }

  private buildLinesMetric(event: Record<string, unknown>, tsNs: string): object | null {
    const countLines = (str: unknown): number => {
      if (!str || typeof str !== 'string') return 0;
      const lines = str.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length;
    };
    const edits = Array.isArray(event['edits'])
      ? (event['edits'] as Record<string, unknown>[])
      : [];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) continue;
      linesAdded += countLines(edit['new_string']);
      linesRemoved += countLines(edit['old_string']);
    }
    if (linesAdded === 0 && linesRemoved === 0) return null;
    const sessionId = String(event['session_id'] ?? '');
    const userEmail = this.resolveUserEmail(event);
    const commonAttrs = [
      { key: 'session.id', value: { stringValue: sessionId } },
      { key: 'user.email', value: { stringValue: userEmail } },
    ];
    const dataPoints: object[] = [];
    if (linesAdded > 0) {
      dataPoints.push({
        attributes: [...commonAttrs, { key: 'type', value: { stringValue: 'added' } }],
        startTimeUnixNano: tsNs,
        timeUnixNano: tsNs,
        asInt: String(linesAdded),
      });
    }
    if (linesRemoved > 0) {
      dataPoints.push({
        attributes: [...commonAttrs, { key: 'type', value: { stringValue: 'removed' } }],
        startTimeUnixNano: tsNs,
        timeUnixNano: tsNs,
        asInt: String(linesRemoved),
      });
    }
    return {
      name: 'claude_code.lines_of_code.count',
      sum: { dataPoints, aggregationTemporality: 1, isMonotonic: true },
    };
  }

  private buildApiRequestRecord(event: Record<string, unknown>, tsNs: string): object {
    const sessionId = String(event['session_id'] ?? '');
    const userEmail = this.resolveUserEmail(event);
    const model = String(event['model'] ?? '');
    const toInt = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      timeUnixNano: tsNs,
      observedTimeUnixNano: tsNs,
      severityNumber: 9,
      severityText: 'INFO',
      body: { stringValue: '' },
      attributes: [
        { key: 'event.name', value: { stringValue: 'api_request' } },
        { key: 'session_id', value: { stringValue: sessionId } },
        { key: 'user.email', value: { stringValue: userEmail } },
        { key: 'model', value: { stringValue: model } },
        { key: 'input_tokens', value: { intValue: toInt(event['input_tokens']) } },
        { key: 'output_tokens', value: { intValue: toInt(event['output_tokens']) } },
        { key: 'cache_read_tokens', value: { intValue: toInt(event['cache_read_input_tokens']) } },
        { key: 'cache_creation_tokens', value: { intValue: toInt(event['cache_creation_input_tokens']) } },
      ],
    };
  }

  private async postOtlp(url: string, payload: unknown): Promise<void> {
    try {
      if (!this.credentials || !this.baseUrl) return;
      let headers: Record<string, string>;
      if (isSSOCredentials(this.credentials)) {
        headers = buildAuthHeaders(this.credentials.cookies);
      } else if (isJWTCredentials(this.credentials)) {
        headers = buildAuthHeaders(this.credentials.token);
      } else {
        return;
      }
      headers['Content-Type'] = 'application/json';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          logger.info(
            `[otlp-ingest] postOtlp: status ${response.status}`,
            ...sanitizeLogArgs({ url, body: bodyText.slice(0, 500) })
          );
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info(`[otlp-ingest] postOtlp: ${msg}`, ...sanitizeLogArgs({ url }));
    }
  }

  private async pushMetrics(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS}`, payload);
  }

  private async pushLogs(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS}`, payload);
  }

  private async pushTraces(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES}`, payload);
  }

  private async dispatchOtlpSignals(payload: OtlpEventPayload): Promise<void> {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload.raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const hookName = String(event['hook_event_name'] ?? '');
    const tsNs = this.nowNs();

    if (hookName === 'postToolUse') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs)])),
        this.pushTraces(this.wrapTraces([this.buildToolSpan(event, tsNs)])),
      ]);
      return;
    }
    if (hookName === 'beforeSubmitPrompt') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs)])),
        this.pushTraces(this.wrapTraces([this.buildInteractionSpan(event, tsNs)])),
      ]);
      return;
    }
    if (hookName === 'subagentStop') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs)])),
        this.pushTraces(this.wrapTraces([this.buildSubagentSpan(event, tsNs)])),
      ]);
      return;
    }
    if (hookName === 'afterFileEdit') {
      const metric = this.buildLinesMetric(event, tsNs);
      if (metric) await this.pushMetrics(this.wrapMetrics([metric]));
      return;
    }
    if (hookName === 'stop') {
      await this.pushLogs(this.wrapLogs([
        this.buildLogRecord(event, hookName, tsNs),
        this.buildApiRequestRecord(event, tsNs),
      ]));
      return;
    }
    await this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs)]));
  }
}
