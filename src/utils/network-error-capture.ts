/**
 * Network error capture
 *
 * The CodeMie SDK collapses response-less axios failures (redirect loops, DNS,
 * TLS, resets) into a generic "HTTP 500 error". This module keeps the original
 * axios error code so SDK commands can report it.
 */

import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { logger } from '@/utils/logger.js';
import { maskSecretsInText, sanitizeLogArgs } from '@/utils/security.js';

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
  logger.debug('Network error captured', ...sanitizeLogArgs({ code, message }));
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

const WRAPPED = Symbol.for('codemie.networkErrorCapture');

/**
 * Wrap the public axios default adapter so response-less failures are recorded.
 *
 * Verified against axios 1.18.1 (the repo and codemie-sdk resolve the same
 * node_modules/axios/dist/node/axios.cjs; the SDK pins 1.15.0, so a future
 * install may nest a second copy, in which case this has no effect):
 * - `axios.defaults.adapter` is the array ["xhr", "http", "fetch"], not a
 *   function, so it is resolved with `axios.getAdapter` before wrapping.
 * - `axios.create()` copies `defaults.adapter` at creation: an instance made
 *   before the assignment keeps the old adapter, one made after uses the new
 *   one. Call this before `new CodeMieClient`.
 *
 * Idempotent. Failures are logged at debug level and leave axios untouched.
 */
export function installNetworkErrorCapture(): void {
  try {
    const current = axios.defaults.adapter;
    if (typeof current === 'function' && (current as unknown as Record<symbol, boolean>)[WRAPPED]) {
      return;
    }
    const resolved = axios.getAdapter(current);
    const wrapped = (async (config: InternalAxiosRequestConfig) => {
      clearNetworkError();
      try {
        return await resolved(config);
      } catch (err) {
        recordNetworkError(err);
        throw err;
      }
    }) as AxiosAdapter;
    (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
    axios.defaults.adapter = wrapped;
  } catch (err) {
    logger.debug('Network error capture not installed', ...sanitizeLogArgs({ error: String(err) }));
  }
}
