import { describe, it, expect } from 'vitest';

const REQUIRED: Array<{ topic: string; prefix: string }> = [
  { topic: 'proxy doctor', prefix: 'codemie proxy doctor' },
  { topic: 'proxy analytics enable', prefix: 'codemie proxy analytics enable' },
  { topic: 'proxy analytics disable', prefix: 'codemie proxy analytics disable' },
  { topic: 'proxy analytics include', prefix: 'codemie proxy analytics include' },
  { topic: 'proxy analytics exclude', prefix: 'codemie proxy analytics exclude' },
  { topic: 'proxy analytics consent', prefix: 'codemie proxy analytics consent' },
  { topic: 'Claude connectors', prefix: 'codemie proxy connect --claude-otlp' },
  { topic: 'Copilot connectors', prefix: 'codemie proxy connect --copilot-otlp' },
  { topic: 'proxy clients', prefix: 'codemie proxy clients' },
  { topic: 'analytics sync', prefix: 'codemie analytics sync' },
];

describe('tip catalog coverage', () => {
  it.each(REQUIRED)('has a tip for $topic', async ({ prefix }) => {
    const { TIPS } = await import('../tips.js');
    const commands = TIPS.flatMap(t => t.commands ?? []);
    expect(commands.some(c => c.startsWith(prefix))).toBe(true);
  });

  it('teaches no deprecated or removed form', async () => {
    const { TIPS } = await import('../tips.js');
    const { createProgram } = await import('../../cli/program.js');
    const { validateCommandExample } = await import('../tips-validator.js');
    const program = createProgram();
    const bad = TIPS.flatMap(t => (t.commands ?? []).map(c => ({ id: t.id, c, r: validateCommandExample(program, c) })))
      .filter(x => !x.r.ok).map(x => `${x.id}: ${x.c}`);
    expect(bad).toEqual([]);
  });
});
