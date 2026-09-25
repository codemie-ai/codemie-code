import { createHash } from 'node:crypto';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../core/types.js';
import { buildAuthHeaders } from '../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../sso.http-client.js';

export interface OtlpEventPayload {
  agentName: string;
  timestamp: string;
  raw: string;
}

type OtlpAttr = { key: string; value: { stringValue: string } };

const SERVICE_NAME = 'cursor-agent';
const OTLP_POST_TIMEOUT_MS = 1500;
const OTLP_SEVERITY_NUMBER = 9;
const OTLP_SEVERITY_TEXT = 'INFO';
const SPAN_NAME_TOOL = 'cursor.tool';
const SPAN_NAME_INTERACTION = 'cursor.interaction';
const SPAN_NAME_SUBAGENT = 'cursor.subagent';
const METRIC_NAME_LINES = 'cursor.lines_of_code.count';

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

export class OtlpDispatcher {
  constructor(
    private readonly credentials?: SSOCredentials | JWTCredentials,
    private readonly baseUrl?: string,
    private readonly projectName?: string
  ) { }

  async dispatch(payload: OtlpEventPayload): Promise<void> {
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

    let gitBranch = '';
    let repoRemote = '';
    const cwd = this.extractCwd(event);
    if (cwd) {
      try {
        const { detectGitBranch, detectGitRemoteRepo } = await import('../../../../../utils/processes.js');
        [gitBranch, repoRemote] = await Promise.all([
          detectGitBranch(cwd).then(v => v ?? ''),
          detectGitRemoteRepo(cwd).then(v => v ?? ''),
        ]);
      } catch {
        // ignore — git info is best-effort
      }
    }

    if (hookName === 'postToolUse') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs, gitBranch, repoRemote)])),
        this.pushTraces(this.wrapTraces([this.buildToolSpan(event, tsNs)])),
      ]);
      return;
    }
    if (hookName === 'beforeSubmitPrompt') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs, gitBranch, repoRemote)])),
        this.pushTraces(this.wrapTraces([this.buildInteractionSpan(event, tsNs)])),
      ]);
      return;
    }
    if (hookName === 'subagentStop') {
      await Promise.all([
        this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs, gitBranch, repoRemote)])),
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
        this.buildLogRecord(event, hookName, tsNs, gitBranch, repoRemote),
        this.buildApiRequestRecord(event, tsNs),
      ]));
      return;
    }
    await this.pushLogs(this.wrapLogs([this.buildLogRecord(event, hookName, tsNs, gitBranch, repoRemote)]));
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
    const raw = Array.isArray(roots) && roots.length > 0 ? String(roots[0]) : String(event['cwd'] || '');
    // Cursor sends MINGW-style paths on Windows: /C:/foo → C:/foo
    const normalized = raw.replace(/^\/([A-Za-z]):\//, '$1:/');
    // Ensure Windows uses backslashes (C:\foo), while leaving POSIX paths untouched.
    return /^[A-Za-z]:\//.test(normalized) ? normalized.replace(/\//g, '\\') : normalized;
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

  private extractFilePath(_toolName: string, toolInput: unknown): string {
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

  private decodeJwtClaims(token: string): Record<string, unknown> {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
  }

  private resolveUserEmail(event: Record<string, unknown>): string {
    if (this.credentials && isJWTCredentials(this.credentials)) {
      try {
        const claims = this.decodeJwtClaims(this.credentials.token);
        if (typeof claims['email'] === 'string' && claims['email']) {
          return claims['email'];
        }
      } catch { /* ignore decode failures */ }
    }
    if (this.credentials && isSSOCredentials(this.credentials)) {
      const accessToken = this.credentials.cookies['codemie_access_token'];
      if (accessToken) {
        try {
          const claims = this.decodeJwtClaims(accessToken);
          const email = claims['email'] ?? claims['preferred_username'];
          if (typeof email === 'string' && email) return email;
        } catch { /* ignore decode failures */ }
      }
    }
    if (typeof event['user_email'] === 'string' && event['user_email']) {
      return event['user_email'];
    }
    return '';
  }

  private toStringField(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value != null) return JSON.stringify(value);
    return '';
  }

  private wrapSignal(resourceKey: string, scopeKey: string, recordKey: string, records: object[]): object {
    return {
      [resourceKey]: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICE_NAME } }] },
        [scopeKey]: [{ scope: {}, [recordKey]: records }],
      }],
    };
  }

  private wrapLogs(records: object[]): object {
    return this.wrapSignal('resourceLogs', 'scopeLogs', 'logRecords', records);
  }

  private wrapTraces(spans: object[]): object {
    return this.wrapSignal('resourceSpans', 'scopeSpans', 'spans', spans);
  }

  private wrapMetrics(metrics: object[]): object {
    return this.wrapSignal('resourceMetrics', 'scopeMetrics', 'metrics', metrics);
  }

  private buildLogRecord(event: Record<string, unknown>, hookName: string, tsNs: string, gitBranch = '', repoRemote = ''): object {
    const eventType = EVENT_TYPE_MAP[hookName] ?? hookName;
    const toolUseId = String(event['tool_use_id'] ?? '').replace(/\n/g, '_');
    const userEmail = this.resolveUserEmail(event);
    const attrs: OtlpAttr[] = [
      { key: 'event_type', value: { stringValue: eventType } },
      { key: 'session_id', value: { stringValue: String(event['session_id'] ?? '') } },
      { key: 'developer_name', value: { stringValue: userEmail } },
      { key: 'user.email', value: { stringValue: userEmail } },
      { key: 'cwd', value: { stringValue: this.extractCwd(event) } },
      { key: 'git_branch', value: { stringValue: gitBranch } },
      { key: 'repo_remote', value: { stringValue: repoRemote } },
      { key: 'tool_name', value: { stringValue: String(event['tool_name'] ?? '') } },
      { key: 'tool_use_id', value: { stringValue: toolUseId } },
      { key: 'tool_input', value: { stringValue: event['tool_input'] ? JSON.stringify(event['tool_input']) : '' } },
      { key: 'tool_output', value: { stringValue: this.toStringField(event['tool_output']) } },
      { key: 'codemie_project_name', value: { stringValue: this.projectName ?? '' } },
      { key: 'prompt_body', value: { stringValue: hookName === 'beforeSubmitPrompt' ? this.extractPromptBody(event) : '' } },
      { key: 'slash_command', value: { stringValue: '' } },
      { key: 'agent_type', value: { stringValue: String(event['subagent_type'] ?? '') } },
    ];
    return {
      timeUnixNano: tsNs,
      observedTimeUnixNano: tsNs,
      severityNumber: OTLP_SEVERITY_NUMBER,
      severityText: OTLP_SEVERITY_TEXT,
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
      name: SPAN_NAME_TOOL,
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
      name: SPAN_NAME_INTERACTION,
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
      name: SPAN_NAME_SUBAGENT,
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

  private countLines(str: unknown): number {
    if (!str || typeof str !== 'string') return 0;
    const lines = str.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  private buildLinesMetric(event: Record<string, unknown>, tsNs: string): object | null {
    const edits = Array.isArray(event['edits'])
      ? (event['edits'] as Record<string, unknown>[])
      : [];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) continue;
      linesAdded += this.countLines(edit['new_string']);
      linesRemoved += this.countLines(edit['old_string']);
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
      name: METRIC_NAME_LINES,
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
      severityNumber: OTLP_SEVERITY_NUMBER,
      severityText: OTLP_SEVERITY_TEXT,
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
      const timeout = setTimeout(() => controller.abort(), OTLP_POST_TIMEOUT_MS);
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
          logger.info(`[otlp-ingest] postOtlp: ok ${response.status}`, ...sanitizeLogArgs({ url }));
          await response.body?.cancel().catch(() => { });
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info(`[otlp-ingest] postOtlp: ${msg}`, ...sanitizeLogArgs({ url }));
    }
  }

  private async pushLogs(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS}`, payload);
  }

  private async pushTraces(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES}`, payload);
  }

  private async pushMetrics(payload: unknown): Promise<void> {
    return this.postOtlp(`${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS}`, payload);
  }
}
