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

const { stripVTControlCharacters } = require('node:util');

const BLOCKED_HOST = 'add-skill.vercel.sh';
const ERROR_MESSAGE = `Request to ${BLOCKED_HOST} blocked by codemie skill wrapper (CODEMIE_SKILL_EGRESS_BLOCKED)`;
const TELEMETRY_MARKER = 'CODEMIE_SKILLS_SH_TELEMETRY';

const originalFetch = globalThis.fetch;

if (typeof originalFetch === 'function') {
  globalThis.fetch = function patchedFetch(input, init) {
    try {
      const url = extractUrl(input);
      if (url && shouldForcePublicRepoProbe(url)) {
        return Promise.resolve(
          new globalThis.Response(JSON.stringify({ private: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url && isBlockedHost(url)) {
        emitTelemetryPayload(url);
        return Promise.reject(new Error(ERROR_MESSAGE));
      }
    } catch {
      // If URL parsing fails for an unexpected input shape, fall through
      // to the original fetch rather than blocking unrelated traffic.
    }
    return originalFetch.call(this, input, init);
  };
}

if (process.env.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT === '1') {
  patchStdoutForUpdateResults();
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

function shouldForcePublicRepoProbe(rawUrl) {
  if (process.env.CODEMIE_CAPTURE_SKILLS_SH_INSTALL_TELEMETRY !== '1') {
    return false;
  }

  let parsed;
  try {
    parsed = new globalThis.URL(rawUrl);
  } catch {
    return false;
  }

  return (
    parsed.hostname === 'api.github.com' &&
    /^\/repos\/[^/]+\/[^/]+$/.test(parsed.pathname)
  );
}

function emitTelemetryPayload(rawUrl) {
  let parsed;
  try {
    parsed = new globalThis.URL(rawUrl);
  } catch {
    return;
  }

  if (parsed.pathname !== '/t') {
    return;
  }

  const payload = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    payload[key] = value;
  }

  try {
    emitPayload(payload);
  } catch {
    // Debug/capture output must never affect the upstream command.
  }
}

function patchStdoutForUpdateResults() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let buffered = '';

  process.stdout.write = function patchedStdoutWrite(chunk, encoding, callback) {
    try {
      // `skills update` does not expose structured per-skill results. It does
      // print one stable success line per updated skill, even in interactive
      // mode where stdout is inherited by the parent. Intercepting stdout in
      // the child lets CodeMie capture those success names without parsing the
      // human terminal stream in the parent process.
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        captureUpdatedSkillLine(line);
      }
    } catch {
      // Output capture must not affect normal CLI rendering.
    }

    return originalWrite(chunk, encoding, callback);
  };
}

function captureUpdatedSkillLine(rawLine) {
  const line = stripVTControlCharacters(rawLine).trim();
  const match = /^✓\s+Updated\s+(.+)$/.exec(line);
  if (!match) {
    return;
  }

  const skill = match[1].trim();
  if (!skill || /^\d+\s+skill\(s\)$/.test(skill)) {
    return;
  }

  emitPayload({
    event: 'update',
    skills: skill,
  });
}

function emitPayload(payload) {
  process.stderr.write(`${TELEMETRY_MARKER} ${JSON.stringify(payload)}\n`);
}
