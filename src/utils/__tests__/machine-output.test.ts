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
    [['analytics', 'view', '--input', 'sessions.json']],
    [['analytics', 'view', '--input', 'sessions.json', '--session', 'abc', '-o', 'out.json']],
    [['analytics', 'view']],
    [['analytics', '--last', '7d', 'view', '--input', 'f']],
    [['analytics', '--redact', 'view', '--input', 'f']],
  ])('is true for `analytics view`, whose stdout is always JSON: %j', (argv) => {
    expect(isMachineOutputInvocation(argv)).toBe(true);
  });

  it.each([
    [['analytics']],
    [['analytics', '--last', '7d']],
    [['analytics', '--export', 'json']],
    [['analytics', 'otel', '--file', 'events.jsonl']],
    [['analytics', 'sync', 'status']],
    [['view']],
    [['run', 'claude', '--', 'analytics', 'view']],
    [['analytics', '--', 'view']],
  ])('stays false for other analytics invocations: %j', (argv) => {
    expect(isMachineOutputInvocation(argv)).toBe(false);
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
