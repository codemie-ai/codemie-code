import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendAuditEvent,
  writeOwnershipMarker,
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

describe('writeOwnershipMarker', () => {
  const codemieHome = join(TMP, 'home');
  const sessionsDir = join(codemieHome, 'sessions');
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = codemieHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousHome;
  });

  function sidecars(): Record<string, unknown>[] {
    return readdirSync(sessionsDir)
      .filter((file) => file.endsWith('-codemie-marker.json'))
      .map((file) => JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')));
  }

  it('leaves a claude transcript byte-for-byte unchanged and records ownership in one sidecar', () => {
    const before = readFileSync(transcriptFile);
    writeOwnershipMarker(transcriptFile, 'codemie-id-1', 'claude');
    expect(readFileSync(transcriptFile).equals(before)).toBe(true);
    const [marker, ...rest] = sidecars();
    expect(rest).toEqual([]);
    expect(marker).toMatchObject({ transcriptPath: transcriptFile, codemieSessionId: 'codemie-id-1', codemieAgent: 'claude' });
    expect(typeof marker.timestamp).toBe('string');

    writeOwnershipMarker(transcriptFile, 'codemie-id-1', 'claude');
    expect(sidecars()).toEqual([marker]);
    expect(readFileSync(transcriptFile).equals(before)).toBe(true);
  });

  it('names the sidecar by the first 8 hex of the transcript path hash, then the CodeMie session', () => {
    writeOwnershipMarker('/work/claude/t1.jsonl', 'codemie-id-1', 'claude');
    expect(readdirSync(sessionsDir)).toEqual(['e5b77992-codemie-id-1-codemie-marker.json']);
  });

  it('leaves a sidecar already on disk for the same pair byte-identical', () => {
    mkdirSync(sessionsDir, { recursive: true });
    const sidecar = join(sessionsDir, 'e5b77992-codemie-id-1-codemie-marker.json');
    writeFileSync(sidecar, '{"earlier":"writer"}');
    writeOwnershipMarker('/work/claude/t1.jsonl', 'codemie-id-1', 'claude');
    expect(readFileSync(sidecar, 'utf-8')).toBe('{"earlier":"writer"}');
  });

  it('gives each transcript of a pi run its own sidecar, even when their basenames match, and touches neither', () => {
    const first = join(TMP, 'a', 'run.jsonl');
    const second = join(TMP, 'b', 'run.jsonl');
    for (const file of [first, second]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '{"type":"session","id":"s1"}\n');
    }
    writeOwnershipMarker(first, 'codemie-pi-1', 'pi');
    writeOwnershipMarker(second, 'codemie-pi-1', 'pi');
    for (const file of [first, second]) {
      expect(readFileSync(file, 'utf-8')).toBe('{"type":"session","id":"s1"}\n');
    }
    expect(sidecars().map((marker) => marker.transcriptPath).sort()).toEqual([first, second]);
  });

  it('writes no ownership marker for a shared sqlite store: the file unchanged, no sidecar', () => {
    const dbFile = join(TMP, 'opencode.db');
    writeFileSync(dbFile, 'SQLite format 3\0');
    writeOwnershipMarker(dbFile, 'codemie-id-1', 'opencode');
    expect(readFileSync(dbFile, 'utf-8')).toBe('SQLite format 3\0');
    const markers = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((file) => file.endsWith('-codemie-marker.json')) : [];
    expect(markers).toEqual([]);
  });

  it('is non-fatal when the transcript file does not exist', () => {
    expect(() =>
      writeOwnershipMarker('/does/not/exist/session.jsonl', 'id', 'claude')
    ).not.toThrow();
  });

  it('is non-fatal when transcript path is empty string', () => {
    expect(() => writeOwnershipMarker('', 'id', 'claude')).not.toThrow();
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
