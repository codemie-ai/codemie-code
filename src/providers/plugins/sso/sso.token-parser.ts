/**
 * SSO token parser
 *
 * Shared by the browser callback and the headless paste-back flow. Accepts a raw
 * base64 token or a full redirect URL carrying it, and resolves the API URL.
 * Error messages are fixed strings: pasted input is never echoed.
 */

import { ensureApiBase } from '../../core/codemie-auth-helpers.js';
import { ConfigurationError } from '../../../utils/errors.js';

export interface ParsedSSOToken {
  apiUrl: string;
  cookies: Record<string, string>;
}

export interface ParseSSOTokenOptions {
  /** CodeMie base URL, used to resolve the API URL */
  codeMieUrl: string;
  signal?: AbortSignal;
  /** Timeout for the optional config.js fetch (default 5000 ms) */
  fetchTimeoutMs?: number;
}

const INVALID_TOKEN = 'Invalid login token. Copy the full address from the browser and try again.';
const MISSING_COOKIES = 'Login token does not contain session cookies.';

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A token parameter in a query string. Base64 never contains ?, &, so a raw token cannot match. */
const REDIRECT_TOKEN_PARAM = /[?&](?:token|auth|data)=/;

/** A redirect: a URL, a bare query, or a scheme-less address carrying a token parameter. */
function looksLikeRedirect(input: string): boolean {
  return /^https?:\/\//i.test(input) || input.startsWith('?') || REDIRECT_TOKEN_PARAM.test(input);
}

function extractRawToken(input: string): string | null {
  if (looksLikeRedirect(input)) {
    let search: string;
    try {
      // A scheme-less address (localhost:1234/?token=...) parses against a placeholder base
      search = input.startsWith('?') ? input : new URL(input, 'http://localhost').search;
    } catch {
      return null;
    }
    const params = new URLSearchParams(search);
    const value = params.get('token') || params.get('auth') || params.get('data');
    if (value) return value;
    const match = /(?:^|[?&])token=([^&]+)/.exec(safeDecodeURIComponent(search));
    return match?.[1] ?? null;
  }
  return input;
}

function decodeToken(raw: string): { cookies: Record<string, string> } {
  // URLSearchParams turns '+' into ' ' and pasted tokens may stay percent-encoded
  const normalized = safeDecodeURIComponent(raw).replace(/ /g, '+');
  let token: unknown;
  try {
    token = JSON.parse(Buffer.from(normalized, 'base64').toString('ascii'));
  } catch {
    throw new ConfigurationError(INVALID_TOKEN);
  }
  const cookies = (token as { cookies?: unknown } | null)?.cookies;
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) {
    throw new ConfigurationError(MISSING_COOKIES);
  }
  return { cookies: cookies as Record<string, string> };
}

/**
 * Decode a pasted or callback token into session cookies and the API URL.
 *
 * @throws ConfigurationError with the invalid-token message when the input is empty, carries no token,
 *   or does not decode, and with the missing-cookies message when the decoded token has no cookies object.
 *   A failed or timed-out config.js fetch is not an error: the default API URL is used instead.
 */
export async function parseSSOToken(input: string, opts: ParseSSOTokenOptions): Promise<ParsedSSOToken> {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new ConfigurationError(INVALID_TOKEN);
  }
  const raw = extractRawToken(trimmed);
  if (!raw) {
    throw new ConfigurationError(INVALID_TOKEN);
  }
  const { cookies } = decodeToken(raw);

  // Resolve the real API URL from config.js (optional; bounded by a timeout)
  let apiUrl = ensureApiBase(opts.codeMieUrl);
  try {
    const timeout = AbortSignal.timeout(opts.fetchTimeoutMs ?? 5000);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const response = await fetch(`${apiUrl}/config.js`, {
      headers: {
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join(';')
      },
      signal
    });
    if (response.ok) {
      const match = /VITE_API_URL:\s*"([^"]+)"/.exec(await response.text());
      if (match?.[1]) {
        apiUrl = match[1].replace(/\/$/, '');
      }
    }
  } catch {
    // config.js fetch is optional - fall back to the default API URL
  }

  return { apiUrl, cookies };
}
