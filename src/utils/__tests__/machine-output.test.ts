import { describe, it, expect } from 'vitest';
import { isMachineOutputInvocation } from '../machine-output.js';

describe('isMachineOutputInvocation', () => {
  it.each([
    [['proxy', 'analytics', 'status', '--json']],
    [['skills', 'list', '--json']],
    [['--json', 'proxy', 'status']],
    [['assistants', 'get', '--json=out.json']],
  ])('is true when --json is passed: %j', (argv) => {
    expect(isMachineOutputInvocation(argv)).toBe(true);
  });

  it.each([
    [[]],
    [['version']],
    [['--version']],
    [['proxy', 'analytics', 'status']],
    [['run', 'claude', '--', '--json']],
    [['--jsonl']],
    [['--no-json']],
    [['-j']],
    [['--json-schema']],
  ])('is false when --json is not a CLI flag: %j', (argv) => {
    expect(isMachineOutputInvocation(argv)).toBe(false);
  });
});
