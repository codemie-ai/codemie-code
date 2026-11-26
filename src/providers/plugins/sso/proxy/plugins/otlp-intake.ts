/**
 * The intake of the analytics plugins: a hook batch (`POST /v1/analytics/hooks`) and an OTLP export
 * (`POST /v1/analytics/otlp/v1/<signal>`) validated and appended to the spool. What a plugin adds around the write
 * comes in as `OtlpIntakeParts`.
 */
import type { ServerResponse } from 'http';
import type { ProxyContext } from '../proxy-types.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { maskOtlpJson } from './otlp-json-masking.js';
import { OTEL_JSON_STREAM_BY_SIGNAL } from './otlp-spool/spool-paths.js';
import { appendSpool } from './otlp-spool/spool-io.js';
import type { OtlpHookBatchRequest, OtlpHookSpoolData } from './otlp.plugin.js';

const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

/** A batch's report of events the hook could not stamp, its count normalized to a positive integer. */
export interface StampLoss {
  session_id: string;
  reason: string;
  events: number;
}

export interface OtlpIntakeParts {
  /** The project names `appendSpool` marks the session with, from the events that are written. */
  projectNamesOf(writtenEvents: Record<string, unknown>[]): string[] | undefined;
  /**
   * Asked before a hooks batch is written, with the whole batch: the check `appendSpool` runs under the session's
   * lock — a batch it answers `true` for is accepted and not written. No part, or no check: the batch is written.
   */
  skipHooksWrite?(sessionId: string, agentName: string, batchEvents: Record<string, unknown>[]): (() => Promise<boolean>) | undefined;
  /**
   * Runs after a hooks batch is written, with the whole batch, and is awaited before the answer; a throw or a
   * rejection is logged, the batch stays accepted.
   */
  afterHooksWrite(sessionId: string, agentName: string, batchEvents: Record<string, unknown>[]): void | Promise<void>;
  /** Records a batch's `evidence_loss`. */
  recordStampLoss(loss: StampLoss): Promise<void>;
  /**
   * A JSON export is divided by the session each record names, each session's records appended to its own file;
   * without it the whole export goes to the file of the first session id in its text.
   */
  splitJsonBySession?: boolean;
}

export interface OtlpIntake {
  handleHooks(ctx: ProxyContext, res: ServerResponse): Promise<true>;
  handleOtlp(ctx: ProxyContext, res: ServerResponse, signal: 'logs' | 'metrics' | 'traces'): Promise<true>;
}

const SESSION_FILE_ID_RE = new RegExp(`^${UUID_V4_RE.source}$`, 'i');

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

const SIGNAL_LEVELS: Record<'logs' | 'metrics' | 'traces', [string[], string[], string[]]> = {
  logs: [['resourceLogs', 'resource_logs'], ['scopeLogs', 'scope_logs'], ['logRecords', 'log_records']],
  traces: [['resourceSpans', 'resource_spans'], ['scopeSpans', 'scope_spans'], ['spans']],
  metrics: [['resourceMetrics', 'resource_metrics'], ['scopeMetrics', 'scope_metrics'], ['metrics']],
};
const METRIC_KINDS = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'exponential_histogram', 'summary'];

/** The session a record or data point names, when it is a UUID v4: a log's `session.id`, else its `session_id`. */
function recordSession(unit: unknown, signal: 'logs' | 'metrics' | 'traces'): string | undefined {
  if (!isObject(unit) || !Array.isArray(unit['attributes'])) return undefined;
  const text = (key: string): unknown => {
    const attr = (unit['attributes'] as unknown[]).find((a) => isObject(a) && a['key'] === key);
    const value = isObject(attr) ? attr['value'] : undefined;
    return isObject(value) ? value['stringValue'] ?? value['string_value'] : undefined;
  };
  const id = text('session.id') ?? (signal === 'logs' ? text('session_id') : undefined);
  return typeof id === 'string' && SESSION_FILE_ID_RE.test(id) ? id : undefined;
}

/**
 * `obj` with its list under `keys` narrowed to the children `child` keeps; a container with no children stays with
 * `fallback` alone, one whose children all go elsewhere is left out.
 */
function narrow(obj: JsonObject, keys: string[], child: (v: unknown) => unknown, session: string, fallback: string): JsonObject | undefined {
  const key = keys.find((k) => Array.isArray(obj[k]));
  const items = key ? (obj[key] as unknown[]) : [];
  if (!key || items.length === 0) return session === fallback ? obj : undefined;
  const kept = items.map(child).filter((v) => v !== undefined);
  return kept.length ? { ...obj, [key]: kept } : undefined;
}

/** The part of an export that is `session`'s: a unit naming no valid session belongs to `fallback`. */
function sessionPart(top: JsonObject, signal: 'logs' | 'metrics' | 'traces', session: string, fallback: string): JsonObject | undefined {
  const [resources, scopes, units] = SIGNAL_LEVELS[signal];
  const owns = (unit: unknown) => (recordSession(unit, signal) ?? fallback) === session;
  const fallbackOnly = (v: unknown) => (session === fallback ? v : undefined);
  const unit = (u: unknown): unknown => {
    if (signal !== 'metrics') return owns(u) ? u : undefined;
    const kind = isObject(u) ? METRIC_KINDS.find((k) => isObject(u[k])) : undefined;
    if (!kind) return fallbackOnly(u);
    const metric = u as JsonObject;
    const points = narrow(metric[kind] as JsonObject, ['dataPoints', 'data_points'], (p) => (owns(p) ? p : undefined), session, fallback);
    return points ? { ...metric, [kind]: points } : undefined;
  };
  const scope = (s: unknown) => (isObject(s) ? narrow(s, units, unit, session, fallback) : fallbackOnly(s));
  const resource = (r: unknown) => (isObject(r) ? narrow(r, scopes, scope, session, fallback) : fallbackOnly(r));
  return narrow(top, resources, resource, session, fallback);
}

/** Every session the records and data points of an export name, in their order. */
function namedSessions(top: JsonObject, signal: 'logs' | 'metrics' | 'traces', fallback: string): string[] {
  const [resources, scopes, units] = SIGNAL_LEVELS[signal];
  const found = new Set<string>();
  const listOf = (obj: unknown, keys: string[]): unknown[] => {
    if (!isObject(obj)) return [];
    const key = keys.find((k) => Array.isArray(obj[k]));
    return key ? (obj[key] as unknown[]) : [];
  };
  for (const r of listOf(top, resources)) {
    for (const s of listOf(r, scopes)) {
      for (const u of listOf(s, units)) {
        if (signal !== 'metrics') {
          found.add(recordSession(u, signal) ?? fallback);
          continue;
        }
        const kind = isObject(u) ? METRIC_KINDS.find((k) => isObject(u[k])) : undefined;
        for (const p of kind ? listOf((u as JsonObject)[kind], ['dataPoints', 'data_points']) : []) found.add(recordSession(p, signal) ?? fallback);
      }
    }
  }
  return [...found];
}

/**
 * The lines of a masked export, each with the session whose file it is appended to. An export whose records name one
 * session goes whole to that session, and to `fallback` (the first UUID v4 of its text) only when no record names one.
 * An export naming more is divided: each named session gets its records, and `fallback` also gets whatever names no
 * session (a record, a metric of no known kind, a container with no records) whenever that part holds anything.
 */
function sessionLines(masked: unknown, signal: 'logs' | 'metrics' | 'traces', fallback: string): Array<[string, string]> {
  const named = isObject(masked) ? namedSessions(masked, signal, fallback) : [];
  if (named.length <= 1) return [[named[0] ?? fallback, JSON.stringify(masked)]];
  const sessions = named.includes(fallback) ? named : [...named, fallback];
  return sessions.flatMap((session) => {
    const part = sessionPart(masked as JsonObject, signal, session, fallback);
    return part ? [[session, JSON.stringify(part)] as [string, string]] : [];
  });
}

function sendError(res: ServerResponse, status: number, type: string, message: string): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  return true;
}

class SpoolIntake implements OtlpIntake {
  constructor(private readonly parts: OtlpIntakeParts) {}

  /**
   * One hook invocation's batch, appended to the spool as one write so the client's
   * commit decision (advance its transcript cursor or not) can be a single boolean.
   */
  async handleHooks(ctx: ProxyContext, res: ServerResponse): Promise<true> {
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn('[otlp-ingest] Rejected hooks request: gateway key not validated');
      return sendError(res, 401, 'authentication_error', 'Unauthorized');
    }

    if (!ctx.requestBody) {
      return sendError(res, 400, 'invalid_request_error', 'Empty body');
    }

    let batch: OtlpHookBatchRequest;
    try {
      batch = JSON.parse(ctx.requestBody.toString('utf-8')) as OtlpHookBatchRequest;
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    }

    if (!Array.isArray(batch.hookEvents)) {
      return sendError(res, 400, 'invalid_request_error', 'Missing hookEvents array');
    }

    // Validate agentName - dynamic import avoids circular dependency
    try {
      const { AgentRegistry } = await import('@/agents/registry.js');
      if (!AgentRegistry.getAnalyticsAgent(batch.agentName)) {
        return sendError(res, 400, 'invalid_request_error', 'Unrecognized agentName');
      }
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Agent validation failed');
    }

    const loss = batch.evidence_loss;
    if (loss && batch.hookEvents.length === 0) {
      if (typeof loss.session_id !== 'string' || !isSafeSessionId(loss.session_id) || typeof loss.reason !== 'string') {
        return sendError(res, 400, 'invalid_request_error', 'Invalid evidence_loss');
      }
      try {
        await this.parts.recordStampLoss({
          session_id: loss.session_id,
          reason: loss.reason,
          events: Number.isInteger(loss.events) && loss.events > 0 ? loss.events : 1,
        });
      } catch (err) {
        logger.warn('[otlp-ingest] stamp loss record error', ...sanitizeLogArgs({ sessionId: loss.session_id, err: err instanceof Error ? err.message : String(err) }));
        return sendError(res, 500, 'api_error', 'Failed to record evidence loss');
      }
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    }

    // A batch is one hook invocation, so it is single-session. Events without a
    // session_id are discarded individually; a batch mixing more than one non-empty
    // session_id is rejected whole, so the client's commit stays all-or-nothing.
    let sessionId = '';
    const lines: string[] = [];
    const written: Record<string, unknown>[] = [];
    for (const event of batch.hookEvents) {
      const eventSessionId = String((event as Record<string, unknown> | null)?.['session_id'] ?? '');
      if (!eventSessionId) {
        logger.debug('[otlp-ingest] hooks: no session_id in hookEvent, discarding');
        continue;
      }
      if (!isSafeSessionId(eventSessionId)) {
        return sendError(res, 400, 'invalid_request_error', 'Invalid session_id');
      }
      if (!sessionId) {
        sessionId = eventSessionId;
      } else if (sessionId !== eventSessionId) {
        return sendError(res, 400, 'invalid_request_error', 'Mixed session_id in one batch');
      }
      const spoolRecord: OtlpHookSpoolData = { agentName: batch.agentName, hookEvent: JSON.stringify(event), ...(batch.evidence_v === 1 ? { evidence_v: 1 as const } : {}) };
      lines.push(JSON.stringify(spoolRecord));
      written.push(event);
    }

    if (lines.length === 0) {
      // Every event lacked a session_id — nothing to retry, so accept without spooling.
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    }

    try {
      await appendSpool(sessionId, 'hooks', lines.join('\n') + '\n', this.parts.projectNamesOf(written), {
        skipIf: this.parts.skipHooksWrite?.(sessionId, batch.agentName, batch.hookEvents),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[otlp-ingest] hooks disk write error', ...sanitizeLogArgs({ sessionId, err: msg }));
      return sendError(res, 500, 'api_error', 'Failed to persist hooks batch');
    }

    try {
      await this.parts.afterHooksWrite(sessionId, batch.agentName, batch.hookEvents);
    } catch (err) {
      logger.warn('[otlp-ingest] after-write step failed', ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
    }

    res.statusCode = 202;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accepted: true }));
    return true;
  }

  async handleOtlp(
    ctx: ProxyContext,
    res: ServerResponse,
    signal: 'logs' | 'metrics' | 'traces'
  ): Promise<true> {
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn(`[otlp-ingest] Rejected ${signal} request: gateway key not validated`);
      return sendError(res, 401, 'authentication_error', 'Unauthorized');
    }

    if (!ctx.requestBody) {
      res.statusCode = 200;
      res.end();
      return true;
    }

    const contentType = (ctx.headers['content-type'] ?? '').toLowerCase();
    if (contentType.startsWith('application/json')) {
      return this.handleOtlpJson(ctx.requestBody, res, signal);
    }
    return this.handleOtlpBinary(ctx.requestBody, res, signal);
  }

  /**
   * `application/json` OTLP: parsed, masked, and NDJSON-spooled into the signal's `*Json` stream, to the file of the
   * first session id in its text, or divided by the session each record names when `splitJsonBySession` is set.
   */
  private async handleOtlpJson(
    body: Buffer,
    res: ServerResponse,
    signal: 'logs' | 'metrics' | 'traces'
  ): Promise<true> {
    const text = body.toString('utf8');
    const jsonMatch = UUID_V4_RE.exec(text);
    const sessionId = jsonMatch ? jsonMatch[0] : '';

    if (!sessionId) {
      // No session id found: same as the byte-blind path's no-session-id case —
      // log and 200, nothing spooled. Never falls through to the byte-blind branch:
      // these bytes are JSON, not protobuf, so re-parsing them there would be wrong.
      logger.debug(
        '[otlp-ingest] no session id in JSON payload, dropping',
        ...sanitizeLogArgs({ signal, bytes: body.length })
      );
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      const parsed = JSON.parse(text);
      const masked = maskOtlpJson(parsed);
      const lines = this.parts.splitJsonBySession ? sessionLines(masked, signal, sessionId) : [[sessionId, JSON.stringify(masked)]];
      for (const [lineSession, line] of lines) {
        await appendSpool(lineSession, OTEL_JSON_STREAM_BY_SIGNAL[signal], line + '\n');
      }
    } catch (err) {
      // Masking is the guarantee this path exists for: a parse/mask/spool failure drops
      // the record (logged) rather than falling through to spool the original bytes
      // unmasked through the byte-blind branch below.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[otlp-ingest] ${signal} JSON parse/mask/spool failure, dropping record`,
        ...sanitizeLogArgs({ sessionId, err: msg })
      );
    }

    res.statusCode = 200;
    res.end();
    return true;
  }

  /** Anything else (protobuf, or no Content-Type): byte-blind, unmasked, unchanged. */
  private async handleOtlpBinary(
    bytes: Buffer,
    res: ServerResponse,
    signal: 'logs' | 'metrics' | 'traces'
  ): Promise<true> {
    // Extract session ID via UUID v4 regex on latin1-decoded bytes
    const latin1Str = Buffer.from(bytes).toString('latin1');
    const match = UUID_V4_RE.exec(latin1Str);
    const sessionId = match ? match[0] : '';

    if (!sessionId) {
      logger.debug('[otlp-ingest] no session id in payload, dropping', ...sanitizeLogArgs({ signal, bytes: bytes.length }));
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      await appendSpool(sessionId, signal, bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[otlp-ingest] ${signal} disk write error`, ...sanitizeLogArgs({ sessionId, err: msg }));
    }

    res.statusCode = 200;
    res.end();
    return true;
  }
}

/** The proxy's OTLP intake: hooks batches and OTLP signals appended to the session spool, with `parts` as its hooks. */
export function createOtlpIntake(parts: OtlpIntakeParts): OtlpIntake {
  return new SpoolIntake(parts);
}
