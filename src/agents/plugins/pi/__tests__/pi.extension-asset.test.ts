/**
 * Tests for the Pi extension asset itself (`../extension/index.js`).
 *
 * This asset runs inside Pi's process, where any load failure makes Pi call
 * `process.exit(1)` and take the user's coding session with it. These tests drive
 * the real file — not a copy or a mock — against a hand-rolled Pi API, and assert
 * the safety invariants documented in `../extension/README.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

 
type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
  on: (name: string, handler: Handler) => void;
  handlers: Map<string, Handler>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  return { on: (name, handler) => handlers.set(name, handler), handlers };
}

interface SessionOverrides {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
  getCwd?: () => string | undefined;
}

function fakeCtx(overrides: SessionOverrides = {}): unknown {
  return {
    mode: 'tui',
    sessionManager: {
      getSessionFile: overrides.getSessionFile ?? (() => '/abs/sessions/2026_pi7.jsonl'),
      getSessionId: overrides.getSessionId ?? (() => 'pi7'),
      getCwd: overrides.getCwd ?? (() => '/abs/repo'),
    },
  };
}

let dir: string;
let ledger: string;

/** The asset reads env at factory time, so each test gets a fresh registration. */
async function activate(): Promise<FakePi> {
  const module = await import('../extension/index.js');
  const pi = fakePi();
  (module.default as (pi: FakePi) => void)(pi);
  return pi;
}

function ledgerLines(): Record<string, unknown>[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-ledger-'));
  ledger = join(dir, 'nested', 'run.jsonl');
  process.env.CODEMIE_PI_LEDGER = ledger;
  delete process.env.CODEMIE_PI_EXTENSION_DISABLED;
});

afterEach(() => {
  delete process.env.CODEMIE_PI_LEDGER;
  delete process.env.CODEMIE_PI_EXTENSION_DISABLED;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('extension asset contract', () => {
  it('exports a factory function, as Pi requires', async () => {
    const module = await import('../extension/index.js');
    expect(typeof module.default).toBe('function');
  });

  it('writes nothing merely by being imported', async () => {
    await import('../extension/index.js');
    expect(existsSync(ledger)).toBe(false);
  });

  it('subscribes only to session_start, session_shutdown and input', async () => {
    const pi = await activate();
    expect([...pi.handlers.keys()].sort()).toEqual(['input', 'session_shutdown', 'session_start']);
  });

  it('never subscribes to tool_call, which would let a throw block the tool', async () => {
    const pi = await activate();
    expect(pi.handlers.has('tool_call')).toBe(false);
  });

  it('creates the ledger directory and records a boot line', async () => {
    await activate();
    expect(ledgerLines()).toEqual([
      expect.objectContaining({ v: 1, t: 'boot', pid: process.pid }),
    ]);
  });
});

describe('registration guards', () => {
  it('registers nothing when no ledger path is configured', async () => {
    delete process.env.CODEMIE_PI_LEDGER;
    const pi = await activate();
    expect(pi.handlers.size).toBe(0);
    expect(existsSync(ledger)).toBe(false);
  });

  it('registers nothing when the kill switch is set', async () => {
    process.env.CODEMIE_PI_EXTENSION_DISABLED = '1';
    const pi = await activate();
    expect(pi.handlers.size).toBe(0);
    expect(existsSync(ledger)).toBe(false);
  });
});

describe('session records', () => {
  it('records the transcript path, Pi session id and the transcript cwd', async () => {
    const pi = await activate();
    pi.handlers.get('session_start')!({ reason: 'startup' }, fakeCtx());

    expect(ledgerLines()[1]).toEqual({
      v: 1,
      ts: expect.any(Number),
      t: 'session',
      reason: 'startup',
      prevFile: null,
      file: '/abs/sessions/2026_pi7.jsonl',
      piSessionId: 'pi7',
      cwd: '/abs/repo',
      mode: 'tui',
    });
  });

  it('records previousSessionFile so /new and /fork chains are reconstructable', async () => {
    const pi = await activate();
    pi.handlers.get('session_start')!(
      { reason: 'fork', previousSessionFile: '/abs/sessions/old.jsonl' },
      fakeCtx()
    );

    expect(ledgerLines()[1]).toMatchObject({
      reason: 'fork',
      prevFile: '/abs/sessions/old.jsonl',
    });
  });

  it('records file:null for an ephemeral (--no-session) run rather than omitting the line', async () => {
    const pi = await activate();
    pi.handlers.get('session_start')!({ reason: 'startup' }, fakeCtx({ getSessionFile: () => undefined }));

    expect(ledgerLines()[1]).toMatchObject({ t: 'session', file: null });
  });

  it('records the shutdown reason and switch target', async () => {
    const pi = await activate();
    pi.handlers.get('session_shutdown')!(
      { reason: 'resume', targetSessionFile: '/abs/sessions/next.jsonl' },
      fakeCtx()
    );

    expect(ledgerLines()[1]).toMatchObject({
      t: 'shutdown',
      reason: 'resume',
      target: '/abs/sessions/next.jsonl',
      file: '/abs/sessions/2026_pi7.jsonl',
    });
  });

  it('appends rather than rewriting, so the whole run is preserved in order', async () => {
    const pi = await activate();
    pi.handlers.get('session_start')!({ reason: 'startup' }, fakeCtx());
    pi.handlers.get('session_start')!({ reason: 'new' }, fakeCtx({ getSessionFile: () => '/abs/b.jsonl' }));
    pi.handlers.get('session_shutdown')!({ reason: 'quit' }, fakeCtx({ getSessionFile: () => '/abs/b.jsonl' }));

    expect(ledgerLines().map((line) => line.t)).toEqual(['boot', 'session', 'session', 'shutdown']);
  });
});

describe('slash-command records', () => {
  it.each([
    ['/skill:brave-search find things', 'skill', 'brave-search'],
    ['/skill:x', 'skill', 'x'],
    ['/review the diff', 'prompt', 'review'],
    ['/review', 'prompt', 'review'],
  ])('records %s as %s:%s', async (text, kind, name) => {
    const pi = await activate();
    pi.handlers.get('input')!({ text, source: 'interactive' }, fakeCtx());

    expect(ledgerLines()[1]).toMatchObject({ t: 'cmd', kind, name });
  });

  it('never records argument text alongside the command name', async () => {
    const pi = await activate();
    pi.handlers.get('input')!(
      { text: '/review my-secret-token AKIAIOSFODNN7EXAMPLE', source: 'interactive' },
      fakeCtx()
    );

    const raw = readFileSync(ledger, 'utf-8');
    expect(raw).not.toContain('my-secret-token');
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it.each([
    ['ordinary prose'],
    ['/usr/local/bin/thing is the path'],
    ['/1234 numeric start'],
    [' /review leading space'],
    ['//comment'],
  ])('records nothing for %s', async (text) => {
    const pi = await activate();
    pi.handlers.get('input')!({ text, source: 'interactive' }, fakeCtx());

    expect(ledgerLines().map((line) => line.t)).toEqual(['boot']);
  });

  it('ignores a non-string input payload', async () => {
    const pi = await activate();
    pi.handlers.get('input')!({ text: undefined }, fakeCtx());
    pi.handlers.get('input')!({}, fakeCtx());

    expect(ledgerLines().map((line) => line.t)).toEqual(['boot']);
  });
});

describe('failure containment', () => {
  it('every handler returns undefined, so input cannot be transformed or swallowed', async () => {
    const pi = await activate();
    for (const [name, handler] of pi.handlers) {
      const event = name === 'input' ? { text: '/review' } : { reason: 'startup' };
      expect(handler(event, fakeCtx()), `${name} must return undefined`).toBeUndefined();
    }
  });

  it('swallows a sessionManager whose getters throw, still recording the line', async () => {
    const pi = await activate();
    const hostile = fakeCtx({
      getSessionFile: () => {
        throw new Error('session manager exploded');
      },
      getSessionId: () => {
        throw new Error('session manager exploded');
      },
    });

    expect(() => pi.handlers.get('session_start')!({ reason: 'startup' }, hostile)).not.toThrow();
    expect(ledgerLines()[1]).toMatchObject({ t: 'session', file: null, piSessionId: null, cwd: '/abs/repo' });
  });

  it('swallows a completely malformed context', async () => {
    const pi = await activate();
    expect(() => pi.handlers.get('session_start')!({ reason: 'startup' }, undefined)).not.toThrow();
    expect(() => pi.handlers.get('session_shutdown')!({ reason: 'quit' }, null)).not.toThrow();
  });

  it('swallows an unwritable ledger path instead of failing the session', async () => {
    process.env.CODEMIE_PI_LEDGER = join(dir, 'a-file');
    // Make the parent of the ledger a file, so mkdir and append both fail.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'a-file'), 'not a directory');
    process.env.CODEMIE_PI_LEDGER = join(dir, 'a-file', 'nested', 'run.jsonl');

    const pi = await activate();
    expect(pi.handlers.size).toBe(3);
    expect(() => pi.handlers.get('session_start')!({ reason: 'startup' }, fakeCtx())).not.toThrow();
  });

  it('does not throw out of the factory even when the Pi API is hostile', async () => {
    const module = await import('../extension/index.js');
    const hostilePi = {
      on: () => {
        throw new Error('registration refused');
      },
    };

    expect(() => (module.default as (pi: unknown) => void)(hostilePi)).not.toThrow();
  });
});
