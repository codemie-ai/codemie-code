/**
 * Tests for the run ledger: installing the extension that writes it, and reading it
 * back afterwards.
 *
 * The ledger is what replaced post-hoc transcript attribution, so its failure modes
 * matter more than its happy path. A missing or truncated ledger must yield "claim
 * nothing", never a guess, and a corrupted asset must be removed rather than handed
 * to Pi — which would `process.exit(1)` on it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePiCodeMieExtension,
  getPiRunLedgerPath,
  readPiRunLedger,
} from '../pi.extension.js';

// The file logger appends into CODEMIE_HOME asynchronously, which races the temp-dir
// cleanup below. These tests are about the ledger, not about logging.
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let codemieHome: string;
let projectDir: string;

const SESSION = 'cm-session-1';

/** Absolute path of a transcript that actually exists, as the ledger filter requires. */
function realTranscript(name: string): string {
  const path = join(projectDir, name);
  writeFileSync(path, '{"type":"session"}\n');
  return path;
}

function writeLedger(lines: (Record<string, unknown> | string)[]): void {
  const path = getPiRunLedgerPath(SESSION);
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
  writeFileSync(
    path,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );
}

function extensionDir(): string {
  return join(projectDir, '.pi', 'codemie', 'agent', 'extensions', 'codemie-metrics');
}

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'pi-project-'));
  process.env.CODEMIE_HOME = codemieHome;
  // The self-test failure paths log a warning, and the file logger appends into
  // <home>/logs without creating it.
  mkdirSync(join(codemieHome, 'logs'), { recursive: true });
});

afterEach(() => {
  delete process.env.CODEMIE_HOME;
  rmSync(codemieHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('getPiRunLedgerPath', () => {
  it('sits beside the session record but cannot be mistaken for one', () => {
    const path = getPiRunLedgerPath(SESSION);
    expect(path).toBe(join(codemieHome, 'sessions', `${SESSION}_pi-run.jsonl`));
    // Every consumer that enumerates session records filters on `.json`.
    expect(path.endsWith('.json')).toBe(false);
  });
});

describe('ensurePiCodeMieExtension', () => {
  it('installs the asset where Pi discovers it, and it passes the load self-test', async () => {
    const status = await ensurePiCodeMieExtension(projectDir, {});

    expect(status).toMatchObject({ installed: true });
    expect(existsSync(join(extensionDir(), 'index.js'))).toBe(true);
    // package.json must ship too: it declares {"type":"module"}, without which the
    // asset's `export default` is a syntax error in a CommonJS context.
    expect(JSON.parse(readFileSync(join(extensionDir(), 'package.json'), 'utf-8')).type).toBe('module');
  });

  it('ships the asset byte-identical to the source, since Pi loads it directly', async () => {
    await ensurePiCodeMieExtension(projectDir, {});

    const source = readFileSync(
      join(import.meta.dirname, '..', 'extension', 'index.js'),
      'utf-8'
    );
    expect(readFileSync(join(extensionDir(), 'index.js'), 'utf-8')).toBe(source);
  });

  it('is idempotent and leaves an unchanged file untouched', async () => {
    await ensurePiCodeMieExtension(projectDir, {});
    const first = readFileSync(join(extensionDir(), 'index.js'), 'utf-8');

    const status = await ensurePiCodeMieExtension(projectDir, {});

    expect(status.installed).toBe(true);
    expect(readFileSync(join(extensionDir(), 'index.js'), 'utf-8')).toBe(first);
  });

  it('repairs an asset that was edited or truncated on disk', async () => {
    await ensurePiCodeMieExtension(projectDir, {});
    writeFileSync(join(extensionDir(), 'index.js'), 'export default 42;');

    await ensurePiCodeMieExtension(projectDir, {});

    expect(readFileSync(join(extensionDir(), 'index.js'), 'utf-8')).toContain('codemieMetrics');
  });

  /** Build a stand-in source directory so the self-test failure path is reachable. */
  function fakeSource(indexJs: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'pi-asset-'));
    writeFileSync(join(dir, 'index.js'), indexJs);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    return dir;
  }

  it.each([
    ['exports a non-function', 'export default { notAFunction: true };'],
    ['exports nothing at all', 'export const unused = 1;'],
    ['does not parse', 'export default function ( {{{ ;'],
    ['throws while loading', 'throw new Error("boom"); export default () => {};'],
  ])('removes an asset that %s, rather than letting Pi exit(1) on it', async (_label, source) => {
    const status = await ensurePiCodeMieExtension(projectDir, {}, fakeSource(source));

    expect(status).toEqual({ installed: false, reason: 'selftest-failed' });
    // Pi discovers whatever is in this directory, so a failing asset must not remain.
    expect(existsSync(extensionDir())).toBe(false);
  });

  it('reports source-missing when the package shipped without the asset', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pi-asset-empty-'));

    const status = await ensurePiCodeMieExtension(projectDir, {}, empty);

    expect(status).toEqual({ installed: false, reason: 'source-missing' });
    expect(existsSync(extensionDir())).toBe(false);
  });

  it('leaves no previously-good copy behind when a later asset fails its self-test', async () => {
    await ensurePiCodeMieExtension(projectDir, {});
    expect(existsSync(join(extensionDir(), 'index.js'))).toBe(true);

    await ensurePiCodeMieExtension(projectDir, {}, fakeSource('export default 42;'));

    expect(existsSync(extensionDir())).toBe(false);
  });

  it('uninstalls the asset when the kill switch is set', async () => {
    await ensurePiCodeMieExtension(projectDir, {});
    expect(existsSync(extensionDir())).toBe(true);

    const status = await ensurePiCodeMieExtension(projectDir, { CODEMIE_PI_EXTENSION_DISABLED: '1' });

    expect(status).toEqual({ installed: false, reason: 'disabled' });
    expect(existsSync(extensionDir())).toBe(false);
  });

  it('never throws, whatever the filesystem does', async () => {
    // Make the agent dir a file so every mkdir/write beneath it fails.
    const blocked = join(projectDir, 'blocked');
    writeFileSync(blocked, 'not a directory');

    await expect(ensurePiCodeMieExtension(join(blocked, 'nope'), {})).resolves.toMatchObject({
      installed: false,
    });
  });
});

describe('readPiRunLedger', () => {
  it('reports not-loaded when the extension never ran', async () => {
    expect(await readPiRunLedger(SESSION)).toEqual({
      loaded: false,
      transcripts: [],
      commandInvocations: {},
      skillCommandInvocations: {},
    });
  });

  it('reports loaded with no transcripts when the run ended before its first reply', async () => {
    writeLedger([{ v: 1, t: 'boot', pid: 1 }]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.loaded).toBe(true);
    expect(ledger.transcripts).toEqual([]);
    expect(ledger.primaryTranscript).toBeUndefined();
  });

  it('collects transcripts in first-seen order, deduped', async () => {
    const a = realTranscript('a.jsonl');
    const b = realTranscript('b.jsonl');
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'session', reason: 'startup', file: a, piSessionId: 'pa', cwd: projectDir },
      { v: 1, t: 'session', reason: 'new', file: b, piSessionId: 'pb', cwd: projectDir },
      { v: 1, t: 'shutdown', reason: 'quit', file: b, piSessionId: 'pb', cwd: projectDir },
    ]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.transcripts).toEqual([a, b]);
    expect(ledger.primaryTranscript).toBe(b);
    expect(ledger.piSessionId).toBe('pb');
  });

  it('drops transcripts Pi planned but never wrote', async () => {
    const real = realTranscript('real.jsonl');
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'session', reason: 'startup', file: real, piSessionId: 'pa', cwd: projectDir },
      // getSessionFile() reports the intended path; _persist writes lazily.
      { v: 1, t: 'session', reason: 'new', file: join(projectDir, 'never-written.jsonl'), piSessionId: 'pb' },
    ]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.transcripts).toEqual([real]);
  });

  it('ignores an ephemeral run that recorded file:null', async () => {
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'session', reason: 'startup', file: null, piSessionId: null, cwd: projectDir },
    ]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.loaded).toBe(true);
    expect(ledger.transcripts).toEqual([]);
  });

  it('takes cwd from the last session record, which --session <path> changes', async () => {
    const a = realTranscript('a.jsonl');
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'session', reason: 'startup', file: a, piSessionId: 'pa', cwd: '/first/repo' },
      { v: 1, t: 'session', reason: 'resume', file: a, piSessionId: 'pa', cwd: '/other/repo' },
    ]);

    expect((await readPiRunLedger(SESSION)).cwd).toBe('/other/repo');
  });

  it('skips malformed lines individually, keeping the records around them', async () => {
    const a = realTranscript('a.jsonl');
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      'not json at all',
      '{"t":"session","file":',
      { v: 1, t: 'session', reason: 'startup', file: a, piSessionId: 'pa', cwd: projectDir },
    ]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.loaded).toBe(true);
    expect(ledger.transcripts).toEqual([a]);
  });

  it('survives a truncated final line after a hard kill', async () => {
    const a = realTranscript('a.jsonl');
    const path = getPiRunLedgerPath(SESSION);
    mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, t: 'boot', pid: 1 })}\n`
      + `${JSON.stringify({ v: 1, t: 'session', reason: 'startup', file: a, piSessionId: 'pa' })}\n`
      + '{"v":1,"t":"cmd","kind":"pro'
    );

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.transcripts).toEqual([a]);
  });

  it('aggregates prompt and skill command counts separately', async () => {
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'cmd', kind: 'prompt', name: 'review' },
      { v: 1, t: 'cmd', kind: 'prompt', name: 'review' },
      { v: 1, t: 'cmd', kind: 'prompt', name: 'ship' },
      { v: 1, t: 'cmd', kind: 'skill', name: 'brave-search' },
      { v: 1, t: 'cmd', kind: 'skill', name: '' },
      { v: 1, t: 'cmd', kind: 'skill' },
    ]);

    const ledger = await readPiRunLedger(SESSION);

    expect(ledger.commandInvocations).toEqual({ review: 2, ship: 1 });
    expect(ledger.skillCommandInvocations).toEqual({ 'brave-search': 1 });
  });

  it('ignores record types it does not know', async () => {
    writeLedger([
      { v: 1, t: 'boot', pid: 1 },
      { v: 1, t: 'some-future-record', payload: 'whatever' },
    ]);

    await expect(readPiRunLedger(SESSION)).resolves.toMatchObject({ loaded: true, transcripts: [] });
  });
});
