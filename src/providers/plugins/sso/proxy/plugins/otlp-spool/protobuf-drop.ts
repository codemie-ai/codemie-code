/**
 * One log line per daemon run for protobuf OTLP dropped from a reduced session (EPMCDME-17748), until a JSON
 * request is seen. Protobuf is never decoded, so a reduced session cannot send it: only the JSON route is reduced.
 * Process-local on purpose: the line says what the user has to do, not what happened to each request.
 */
import { logger } from '@/utils/logger.js';

let announced = false;

export function noteProtobufDropped(): void {
  if (announced) return;
  announced = true;
  logger.warn(
    '[otlp-ingest] protobuf OTLP dropped for a session with analytics prompt reduction on: reconnect with `codemie proxy connect --claude-otlp` to send OTLP as JSON'
  );
}

/** A JSON OTLP request arrived: the connection already sends JSON, so a later protobuf drop is news again. */
export function noteJsonRequestSeen(): void {
  announced = false;
}

export function resetProtobufDropLog(): void {
  announced = false;
}
