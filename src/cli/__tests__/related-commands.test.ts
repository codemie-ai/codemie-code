import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../program.js';
import { RELATED, printNext } from '../related-commands.js';

interface Node {
  path: string;
  cmd: Command;
}

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden: boolean })._hidden === true;
}

function collect(cmd: Command, prefix: string, out: Node[]): Node[] {
  for (const sub of cmd.commands) {
    const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
    if (!isHidden(sub)) {
      if (/^(proxy|analytics)\b/.test(path)) out.push({ path, cmd: sub });
      collect(sub, path, out);
    }
  }
  return out;
}

/** Resolve `codemie <path> [flags/args]` against the program tree. */
function resolves(program: Command, full: string): boolean {
  const tokens = full.split(/\s+/);
  if (tokens[0] !== 'codemie') return false;
  let node: Command = program;
  let i = 1;
  for (; i < tokens.length; i++) {
    const next = node.commands.find((c) => c.name() === tokens[i]);
    if (!next || isHidden(next)) break;
    node = next;
  }
  if (node === program) return false;
  return tokens.slice(i).every((t) => /^[-<[]/.test(t));
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('RELATED registry', () => {
  const program = createProgram();
  const nodes = collect(program, '', []);

  it('covers every visible proxy/analytics node', () => {
    expect(nodes.length).toBeGreaterThan(20);
    for (const { path } of nodes) expect(RELATED, path).toHaveProperty([path]);
  });

  it('only references commands that resolve to a visible node', () => {
    for (const [key, entry] of Object.entries(RELATED)) {
      for (const r of entry.related) expect(resolves(program, r.path), `${key} -> ${r.path}`).toBe(true);
      const nexts = [entry.next.default, ...Object.values(entry.next.byOutcome ?? {})];
      for (const n of nexts) if (n) expect(resolves(program, n), `${key} next ${n}`).toBe(true);
    }
  });

  it('ends `proxy status --help` with a Related commands block', () => {
    const status = nodes.find((n) => n.path === 'proxy status')!.cmd;
    const help = status.helpInformation() + '\n';
    let extra = '';
    status.configureOutput({ writeOut: (s) => (extra += s) });
    status.outputHelp();
    expect(extra.trimEnd()).toMatch(/Related commands:\n( {2}codemie .+\n?)+$/);
    expect(help.length).toBeGreaterThan(0);
  });
});

describe('printNext', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  afterEach(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    vi.restoreAllMocks();
  });

  function capture(): () => string {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return () => spy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('prints one Next line on a TTY', () => {
    setTty(true);
    const out = capture();
    printNext('proxy start');
    expect(out()).toBe(`Next: ${RELATED['proxy start'].next.default}\n`);
  });

  it('prints nothing when stdout is not a TTY', () => {
    setTty(false);
    const out = capture();
    printNext('proxy start');
    expect(out()).toBe('');
  });

  it('prints nothing under json', () => {
    setTty(true);
    const out = capture();
    printNext('proxy start', undefined, { json: true });
    expect(out()).toBe('');
  });

  it('prints nothing in a silent (hook) context', () => {
    setTty(true);
    const argv = process.argv;
    process.argv = [argv[0], argv[1], 'hook'];
    const out = capture();
    try {
      printNext('proxy start');
    } finally {
      process.argv = argv;
    }
    expect(out()).toBe('');
  });

  it('prints nothing for an unknown path', () => {
    setTty(true);
    const out = capture();
    printNext('nope nothing');
    expect(out()).toBe('');
  });

  it('byOutcome overrides default', () => {
    setTty(true);
    const out = capture();
    printNext('proxy status', 'stopped');
    expect(out()).toBe(`Next: ${RELATED['proxy status'].next.byOutcome!.stopped}\n`);
  });

  it('prints nothing after a failed command (non-zero exit code)', () => {
    setTty(true);
    const out = capture();
    const prior = process.exitCode;
    process.exitCode = 1;
    try {
      printNext('proxy connect');
    } finally {
      process.exitCode = prior;
    }
    expect(out()).toBe('');
  });

  it('connect and disconnect name an outcome-specific follow-up', () => {
    expect(RELATED['proxy connect'].next.byOutcome?.analytics).toBe('codemie proxy doctor');
    expect(RELATED['proxy disconnect'].next.byOutcome?.all).toBe('codemie proxy clients');
  });
});
