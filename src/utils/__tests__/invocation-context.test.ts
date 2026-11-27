import { describe, it, expect } from 'vitest';
import { getInvocationContext } from '../invocation-context.js';

describe('getInvocationContext', () => {
  it('flags a hook invocation as silent', () => {
    const ctx = getInvocationContext({ argv: ['node', 'codemie', 'hook'] });
    expect(ctx).toEqual({ hook: true, scheduled: false, json: false, completion: false, silent: true });
  });

  it('flags a sound invocation as a hook', () => {
    expect(getInvocationContext({ argv: ['node', 'codemie', 'sound'] }).hook).toBe(true);
  });

  it('flags the scheduled analytics sync run as silent', () => {
    const ctx = getInvocationContext({
      argv: ['node', 'codemie', 'analytics', 'sync', 'run', '--scheduled']
    });
    expect(ctx.scheduled).toBe(true);
    expect(ctx.hook).toBe(false);
    expect(ctx.silent).toBe(true);
  });

  it('reports json from the parsed option without silencing', () => {
    const ctx = getInvocationContext({ argv: ['node', 'codemie', 'proxy', 'status'], json: true });
    expect(ctx.json).toBe(true);
    expect(ctx.silent).toBe(false);
  });

  it('detects --json in argv', () => {
    expect(getInvocationContext({ argv: ['node', 'codemie', 'x', '--json'] }).json).toBe(true);
  });

  it('flags the completion command without changing silent', () => {
    const ctx = getInvocationContext({ argv: ['node', 'codemie', 'completion', 'bash'] });
    expect(ctx.completion).toBe(true);
    expect(ctx.hook).toBe(false);
    expect(ctx.silent).toBe(false);
  });

  it('flags completion when root options precede it', () => {
    expect(getInvocationContext({ argv: ['node', 'codemie', '--debug', 'completion', 'bash'] }).completion).toBe(true);
    expect(getInvocationContext({ argv: ['node', 'codemie', '--task', 'completion', 'completion', 'bash'] }).completion).toBe(true);
  });

  it('does not flag completion when it is not the command', () => {
    expect(getInvocationContext({ argv: ['node', 'codemie', 'list', 'completion'] }).completion).toBe(false);
  });

  it('defaults argv to process.argv', () => {
    const original = process.argv;
    process.argv = ['node', 'codemie', 'hook'];
    try {
      expect(getInvocationContext().hook).toBe(true);
    } finally {
      process.argv = original;
    }
  });
});
