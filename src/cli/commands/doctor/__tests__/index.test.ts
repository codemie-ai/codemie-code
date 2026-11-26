/**
 * `codemie doctor` as the developer runs it, on a home of its own: the collection the command resolves reaches its
 * proxy check, and a collection that does not resolve fails that check alone while every other check runs.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setUpHome, tearDownHome } from '../../shared/analytics-collection/__tests__/stand.js';

const h = vi.hoisted(() => {
  const spawned: string[] = [];
  // No process starts: a call that reaches the child-process module is recorded and finds nothing.
  const childProcessStandIn = (actual: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(actual).map(([name, value]) => [
        name,
        typeof value === 'function' && /^(spawn|exec|fork)/.test(name)
          ? (...args: unknown[]) => {
              spawned.push(`${name} ${String(args[0])}`);
              throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
            }
          : value,
      ])
    );
  return { resolveError: undefined as Error | undefined, spawned, childProcessStandIn };
});

vi.mock('node:child_process', async (importOriginal) => h.childProcessStandIn(await importOriginal()));
vi.mock('child_process', async (importOriginal) => h.childProcessStandIn(await importOriginal()));
// Every probe of the machine finds nothing.
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  exec: vi.fn(async () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  }),
  commandExists: vi.fn(async () => false),
  getCommandPath: vi.fn(async () => null),
  getCommandMatches: vi.fn(async () => []),
}));
// The module's own calls (the npm version, agents, frameworks, the scheduler) go through this one.
vi.mock('@/utils/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/exec.js')>()),
  exec: vi.fn(async () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  }),
}));
vi.mock('@/utils/npm-prefix.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/npm-prefix.js')>()),
  getUserNpmrcPrefix: vi.fn(async () => null),
}));
vi.mock('@/workflows/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/workflows/index.js')>()),
  detectVCSProvider: vi.fn(() => ({ isGitRepo: false })),
}));
// The resolver as it is, unless a test makes it reject.
vi.mock('@/cli/commands/shared/analytics-collection/resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/commands/shared/analytics-collection/resolve.js')>();
  return {
    ...actual,
    resolveCollection: async () => {
      if (h.resolveError) throw h.resolveError;
      return actual.resolveCollection();
    },
  };
});

const SETTINGS = {
  webhookUrl: 'https://hooks.example.invalid/x?sig=FAKE',
  format: 'json',
  includeExternal: 'never',
  at: '03:00',
  local: true,
};
const OTHER_CHECKS = ['Node.js', 'npm', 'Python', 'uv', 'AWS CLI', 'Installed Agents', 'Frameworks'];

let home: string;
let printed: string[];
let exitCodes: unknown[];
beforeEach(() => {
  home = setUpHome();
  // The working folder is the home: a project config of the folder the tests run in holds no profile here.
  vi.spyOn(process, 'cwd').mockReturnValue(home);
  h.resolveError = undefined;
  h.spawned.length = 0;
  printed = [];
  exitCodes = [];
  const record = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  });
  // A machine with no profile has issues, and the summary exits 1 for them.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tearDownHome(home);
});

async function doctor(): Promise<string> {
  const { createDoctorCommand } = await import('../index.js');
  await createDoctorCommand().parseAsync([], { from: 'user' });
  return printed.join('\n');
}

/** The output up to the proxy check, the last check, its colours dropped: every other check's own lines. */
function beforeProxy(output: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  return plain.slice(0, plain.indexOf('\nProxy:\n'));
}

describe('createDoctorCommand', () => {
  it('on a machine in the local mode hands the proxy check the local plan', async () => {
    writeFileSync(join(home, 'analytics-sync.json'), JSON.stringify(SETTINGS));

    const output = await doctor();

    expect(output).toContain(`Local analytics folder is missing (${join(home, 'analytics', 'sessions')})`);
    // The job's name is the platform's own, and on Windows it holds spaces.
    expect(output).toMatch(/Scheduled job .+: not registered or disabled/);
    expect(output).not.toContain('Proxy check failed');
    expect(exitCodes).toEqual([1]);
    expect(h.spawned).toEqual([]);
  });

  it('a collection that does not resolve fails the proxy check alone, and the other checks run', async () => {
    writeFileSync(join(home, 'analytics-sync.json'), JSON.stringify(SETTINGS));
    const resolved = beforeProxy(await doctor());
    printed.length = 0;
    exitCodes.length = 0;
    h.resolveError = new Error('settings unreadable');

    const output = await doctor();

    expect(output).toContain('Proxy check failed: settings unreadable');
    for (const name of OTHER_CHECKS) expect(resolved).toContain(`\n${name}:\n`);
    expect(beforeProxy(output)).toBe(resolved);
    expect(exitCodes).toEqual([1]);
    expect(h.spawned).toEqual([]);
  });
});
