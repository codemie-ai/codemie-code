/**
 * omp onSessionEnd: every ledger transcript gets an omp ownership marker, and the run's providers
 * file (it carries the run's key) is removed even when the session-end processing fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpPluginMetadata } from '../omp.plugin.js';
import { getOmpProvidersConfigPath, writeOmpProvidersConfig } from '../omp.extension.js';
import { getPiRunLedgerPath } from '../../pi/pi.extension.js';

const processEvent = vi.fn();
vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: (...args: unknown[]) => processEvent(...args) }));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'cm-omp-owner-1';
let codemieHome: string;
let projectDir: string;

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'omp-project-'));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
  processEvent.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(codemieHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeLedger(): string {
  const file = join(projectDir, 'run.jsonl');
  writeFileSync(file, '{"type":"session","id":"s1"}\n');
  writeFileSync(
    join(codemieHome, 'sessions', `${SESSION}.json`),
    JSON.stringify({ sessionId: SESSION, agentName: 'omp', status: 'active', correlation: { status: 'pending' } }),
  );
  writeFileSync(
    getPiRunLedgerPath(SESSION),
    [{ t: 'boot' }, { t: 'session', file, piSessionId: 'p1' }].map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  return file;
}

function markers(): Array<{ transcriptPath: string; codemieAgent: string }> {
  const dir = join(codemieHome, 'sessions');
  return readdirSync(dir)
    .filter((file) => file.endsWith('-codemie-marker.json'))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf-8')));
}

describe('omp onSessionEnd', () => {
  it('claims each ledger transcript as omp and removes the providers file', async () => {
    const transcript = writeLedger();
    const providersFile = await writeOmpProvidersConfig(SESSION, { providers: {} });

    await OmpPluginMetadata.lifecycle!.onSessionEnd!(0, {
      CODEMIE_SESSION_ID: SESSION,
      CODEMIE_OMP_PROVIDERS: providersFile,
    });

    expect(markers()).toEqual([expect.objectContaining({ transcriptPath: transcript, codemieAgent: 'omp' })]);
    expect(existsSync(providersFile)).toBe(false);
  });

  it('removes the providers file even when session-end processing rejects', async () => {
    writeLedger();
    const providersFile = await writeOmpProvidersConfig(SESSION, { providers: {} });
    processEvent.mockRejectedValue(new Error('hook exploded'));

    await OmpPluginMetadata.lifecycle!.onSessionEnd!(0, {
      CODEMIE_SESSION_ID: SESSION,
      CODEMIE_OMP_PROVIDERS: providersFile,
    }).catch(() => undefined);

    expect(existsSync(providersFile)).toBe(false);
    expect(providersFile).toBe(getOmpProvidersConfigPath(SESSION));
  });
});
