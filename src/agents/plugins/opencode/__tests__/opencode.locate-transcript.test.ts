/**
 * OpenCodeSessionAdapter.locateTranscript resolves the storage from the RECORD's agent, never
 * from this process's environment: a codemie-code record is found in codemie-code's private
 * storage from another agent's wrapper, an opencode record in the user's XDG_DATA_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// The user's own data home, as the process had it before any launch
const previousXdgDataHome = process.env.XDG_DATA_HOME;
const userDataHome = mkdtempSync(join(tmpdir(), 'opencode-user-data-'));
process.env.XDG_DATA_HOME = userDataHome;

afterAll(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  rmSync(userDataHome, { recursive: true, force: true });
});

const { OpenCodeSessionAdapter } = await import('../opencode.session.js');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

let codemieHome: string;
let projectDir: string;
const previousHome = process.env.CODEMIE_HOME;

function writeStoredSession(storageRoot: string, id: string, directory: string): string {
  const dir = join(storageRoot, 'opencode', 'storage', 'session', 'project-1');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, directory, time: { created: Date.now() - 60_000, updated: Date.now() } }));
  return path;
}

function record(agentName: string) {
  return {
    sessionId: 'cccccccc-0000-4000-8000-000000000001',
    agentName,
    provider: 'ai-run-sso',
    startTime: Date.now() - 120_000,
    workingDirectory: projectDir,
    status: 'active' as const,
    activeDurationMs: 0,
    correlation: { status: 'matched' as const, retryCount: 0, agentSessionId: 'cccccccc-0000-4000-8000-000000000001' },
  };
}

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'opencode-project-'));
  process.env.CODEMIE_HOME = codemieHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(codemieHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('OpenCodeSessionAdapter.locateTranscript', () => {
  it('locates a codemie-code record in codemie-code storage from a claude wrapper process', async () => {
    // A claude wrapper: this process's XDG_DATA_HOME / OPENCODE_STORAGE_PATH say nothing about codemie-code
    delete process.env.OPENCODE_STORAGE_PATH;
    const inUserStorage = writeStoredSession(userDataHome, 'ses_user', projectDir);
    const inCodemieStorage = writeStoredSession(join(codemieHome, 'opencode-storage'), 'ses_codemie', projectDir);

    const located = await new OpenCodeSessionAdapter(OpenCodePluginMetadata).locateTranscript(record('codemie-code'));

    expect(located).toEqual([inCodemieStorage]);
    expect(located).not.toContain(inUserStorage);
  });

  it('locates an opencode record in the user XDG_DATA_HOME, in its working directory', async () => {
    writeStoredSession(join(codemieHome, 'opencode-storage'), 'ses_codemie', projectDir);
    const inUserStorage = writeStoredSession(userDataHome, 'ses_user', projectDir);
    // This process's data home now points elsewhere (as after a codemie-code launch)
    process.env.XDG_DATA_HOME = join(codemieHome, 'opencode-storage');
    try {
      const located = await new OpenCodeSessionAdapter(OpenCodePluginMetadata).locateTranscript(record('opencode'));

      expect(located).toEqual([inUserStorage]);
    } finally {
      process.env.XDG_DATA_HOME = userDataHome;
    }
  });
});
