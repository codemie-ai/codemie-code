import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendAuditEvent,
  appendTranscriptMarker,
  isExternalOrigin,
} from '../session/session-origin-audit.js';
import { SESSION_ORIGIN, SESSION_ORIGIN_ENV_KEY } from '../session/types.js';

const TMP = join(tmpdir(), `codemie-audit-test-${process.pid}`);
const auditFile = join(TMP, 'logs', 'session-origin-audit.jsonl');
const transcriptFile = join(TMP, 'transcript.jsonl');

beforeEach(() => {
  mkdirSync(join(TMP, 'logs'), { recursive: true });
  writeFileSync(transcriptFile, '{"type":"user","uuid":"abc"}\n');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('appendAuditEvent', () => {
  it('creates the file and appends a valid JSON line', () => {
    appendAuditEvent('resume_blocked', { claudeSessionId: 'ses-1' }, join(TMP, 'logs'));
    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe('resume_blocked');
    expect(parsed.data.claudeSessionId).toBe('ses-1');
    expect(typeof parsed.ts).toBe('string');
  });

  it('appends multiple events', () => {
    appendAuditEvent('resume_blocked', { claudeSessionId: 'a' }, join(TMP, 'logs'));
    appendAuditEvent('resume_external_confirmed', { claudeSessionId: 'b' }, join(TMP, 'logs'));
    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('is non-fatal when the directory does not exist', () => {
    expect(() =>
      appendAuditEvent('resume_blocked', {}, '/nonexistent/path/that/does/not/exist/logs')
    ).not.toThrow();
  });
});

describe('appendTranscriptMarker', () => {
  it('appends a codemie_session_start line to the transcript', () => {
    appendTranscriptMarker(transcriptFile, 'codemie-id-1', 'claude');
    const lines = readFileSync(transcriptFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const marker = JSON.parse(lines[1]);
    expect(marker.type).toBe('codemie_session_start');
    expect(marker.codemie_session_id).toBe('codemie-id-1');
    expect(marker.codemie_agent).toBe('claude');
    expect(typeof marker.uuid).toBe('string');
    expect(typeof marker.timestamp).toBe('string');
  });

  it('is non-fatal when the transcript file does not exist', () => {
    expect(() =>
      appendTranscriptMarker('/does/not/exist/session.jsonl', 'id', 'claude')
    ).not.toThrow();
  });

  it('is non-fatal when transcript path is empty string', () => {
    expect(() => appendTranscriptMarker('', 'id', 'claude')).not.toThrow();
  });
});

describe('isExternalOrigin', () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env[SESSION_ORIGIN_ENV_KEY];
    delete process.env[SESSION_ORIGIN_ENV_KEY];
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env[SESSION_ORIGIN_ENV_KEY];
    } else {
      process.env[SESSION_ORIGIN_ENV_KEY] = origEnv;
    }
  });

  it('returns true when the session record is flagged external-resume', () => {
    expect(isExternalOrigin({ origin: SESSION_ORIGIN.EXTERNAL_RESUME })).toBe(true);
  });

  it('returns false when the session record is codemie-owned', () => {
    expect(isExternalOrigin({ origin: 'codemie' })).toBe(false);
  });

  it('returns false for a session record with no origin field when env is unset (back-compat default)', () => {
    expect(isExternalOrigin({})).toBe(false);
  });

  it('does not fall back to env when the record explicitly says codemie-owned', () => {
    process.env[SESSION_ORIGIN_ENV_KEY] = SESSION_ORIGIN.EXTERNAL_RESUME;
    expect(isExternalOrigin({ origin: 'codemie' })).toBe(false);
  });

  it('falls back to the env var when no record is available (fail-closed)', () => {
    process.env[SESSION_ORIGIN_ENV_KEY] = SESSION_ORIGIN.EXTERNAL_RESUME;
    expect(isExternalOrigin(null)).toBe(true);
    expect(isExternalOrigin(undefined)).toBe(true);
  });

  it('falls back to the env var when the record has no origin field (write failure case)', () => {
    process.env[SESSION_ORIGIN_ENV_KEY] = SESSION_ORIGIN.EXTERNAL_RESUME;
    expect(isExternalOrigin({})).toBe(true);
  });

  it('returns false when neither the record nor env indicate external origin', () => {
    expect(isExternalOrigin(null)).toBe(false);
  });
});
