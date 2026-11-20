import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';

function sub(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find(c => c.name() === name);
}

describe('createProgram', () => {
  it('builds the command tree without parsing argv', async () => {
    const { createProgram } = await import('../program.js');
    const program = createProgram();

    expect(program.name()).toBe('codemie');
    expect(sub(program, 'proxy')).toBeDefined();
    expect(sub(program, 'analytics')).toBeDefined();
    expect(sub(program, 'doctor')).toBeDefined();
    expect(sub(program, 'tips')).toBeDefined();
  });

  it('exposes proxy status, proxy connect and analytics sync', async () => {
    const { createProgram } = await import('../program.js');
    const program = createProgram();

    expect(sub(sub(program, 'proxy')!, 'status')).toBeDefined();
    expect(sub(sub(program, 'proxy')!, 'connect')).toBeDefined();
    expect(sub(sub(program, 'analytics')!, 'sync')).toBeDefined();
  });

  it('returns a fresh tree per call', async () => {
    const { createProgram } = await import('../program.js');
    expect(createProgram()).not.toBe(createProgram());
  });
});
