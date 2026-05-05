/**
 * skills.sh egress guard
 *
 * Loaded into the upstream `skills` CLI child process via `NODE_OPTIONS=--require`.
 * Wraps `globalThis.fetch` and rejects only requests targeting the upstream
 * telemetry/audit host so legitimate skill source fetches still work.
 *
 * Blocked: add-skill.vercel.sh
 */

'use strict';

const BLOCKED_HOST = 'add-skill.vercel.sh';
const ERROR_MESSAGE = `Request to ${BLOCKED_HOST} blocked by codemie skill wrapper (CODEMIE_SKILL_EGRESS_BLOCKED)`;

const originalFetch = globalThis.fetch;

if (typeof originalFetch === 'function') {
  globalThis.fetch = function patchedFetch(input, init) {
    try {
      const url = extractUrl(input);
      if (url && isBlockedHost(url)) {
        return Promise.reject(new Error(ERROR_MESSAGE));
      }
    } catch {
      // If URL parsing fails for an unexpected input shape, fall through
      // to the original fetch rather than blocking unrelated traffic.
    }
    return originalFetch.call(this, input, init);
  };
}

function extractUrl(input) {
  if (!input) {
    return null;
  }
  if (typeof input === 'string') {
    return input;
  }
  if (typeof globalThis.URL !== 'undefined' && input instanceof globalThis.URL) {
    return input.href;
  }
  if (typeof input === 'object' && typeof input.url === 'string') {
    return input.url;
  }
  return null;
}

function isBlockedHost(rawUrl) {
  let parsed;
  try {
    parsed = new globalThis.URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.host === BLOCKED_HOST || parsed.hostname === BLOCKED_HOST;
}
