/**
 * Network error capture
 *
 * The CodeMie SDK collapses response-less axios failures (redirect loops, DNS,
 * TLS, resets) into a generic "HTTP 500 error". This module keeps the original
 * axios error code so SDK commands can report it.
 */

import { maskSecretsInText } from '@/utils/security.js';

export interface CapturedNetworkError {
  code: string;
  message: string;
}

let captured: CapturedNetworkError | undefined;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

function sanitizeMessage(message: string): string {
  return maskSecretsInText(message.replace(URL_PATTERN, '[url]'));
}

/**
 * Record an axios-style error, only when it carries no HTTP response.
 */
export function recordNetworkError(err: unknown): void {
  if (!err || typeof err !== 'object') {
    return;
  }
  const candidate = err as { response?: unknown; code?: unknown; message?: unknown };
  if (candidate.response) {
    return;
  }
  const code = typeof candidate.code === 'string' && candidate.code ? candidate.code : 'ERR_NETWORK';
  const message = typeof candidate.message === 'string' ? sanitizeMessage(candidate.message) : '';
  captured = { code, message };
}

/**
 * Read and clear the recorded error.
 */
export function takeNetworkError(): CapturedNetworkError | undefined {
  const value = captured;
  captured = undefined;
  return value;
}

export function clearNetworkError(): void {
  captured = undefined;
}
