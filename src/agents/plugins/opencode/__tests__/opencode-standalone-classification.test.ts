/** P0 A3: isolate only v2 commands accepting ServerParams, without changing v1 ownership. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } = await import('fs');
const realFs = await vi.importActual<typeof import('fs')>('fs');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');
const enrich = OpenCodePluginMetadata.lifecycle!.enrichArgs!;
const VERSION = 'CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION';
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'opencode-a3-'));
  mkdirSync(join(directory, 'run'));
  writeFileSync(join(directory, 'file.txt'), 'not a directory');
});

beforeEach(() => {
  vi.stubEnv(VERSION, 'v2');
  vi.stubEnv('CODEMIE_OPENCODE_V2_MODEL_REF', undefined);
  vi.mocked(statSync).mockReset().mockImplementation(realFs.statSync);
});

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('A3 v2 standalone capabilities', () => {
  it.each(['mini', 'api', 'models', 'stats', 'reload'])('isolates %s without adding command ownership', command => {
    expect(enrich([command], {} as never)).toEqual([command, '--standalone']);
    expect(OpenCodePluginMetadata.ownedSubcommands).not.toContain(command);
  });

  it.each([
    ['auth', 'list'], ['auth', 'login'], ['auth', 'logout'],
    ['auth', 'export'], ['auth', 'import'], ['auth', 'switch'],
    ['session', 'list'], ['session', 'delete'], ['session', 'export'], ['session', 'import'],
  ])('isolates the known leaf %s %s', (group, leaf) => {
    expect(enrich([group, leaf, '--print-logs'], {} as never)).toEqual([group, leaf, '--print-logs', '--standalone']);
  });

  it.each([
    ['auth'], ['session'], ['auth', '--help'], ['session', '--help'],
    ['auth', 'unknown'], ['session', 'unknown'],
    ['debug', 'paths', 'db'], ['mcp', 'list'], ['plugin', 'list'],
    ['upgrade'], ['update'], ['uninstall', '--dry-run'], ['serve'],
    ['service', 'status'], ['acp'], ['pair'], ['chat'], ['config'], ['init'], ['help'], ['version'],
  ])('does not enrich administrative, bare-group or unknown commands: %j', (...args) => {
    expect(enrich(args, {} as never)).toEqual(args);
  });

  it.each([
    ['--session', 'debug'], ['-s', 'session'], ['--prompt', 'auth'], ['--resume', 'run'],
  ])('skips the root value of %s before identifying debug', (flag, value) => {
    const args = [flag, value, 'debug', 'paths'];
    expect(enrich(args, {} as never)).toEqual(args);
    expect(enrich([flag, value], {} as never)).toEqual([flag, value, '--standalone']);
    expect(enrich([flag, value, 'run', 'hello'], {} as never)).toEqual([flag, value, 'run', '--standalone', 'hello']);
  });

  it('skips root boolean and inline-value options', () => {
    expect(enrich(['--print-logs', '--continue', '--session=debug', 'run', 'hello'], {} as never))
      .toEqual(['--print-logs', '--continue', '--session=debug', 'run', '--standalone', 'hello']);
    expect(enrich(['--prompt=run', 'service', 'status'], {} as never))
      .toEqual(['--prompt=run', 'service', 'status']);
    expect(enrich(['auth', '--print-logs', 'list'], {} as never)).toEqual(['auth', '--print-logs', 'list', '--standalone']);
  });

  it.each([
    ['--standalone'], ['--standalone=true'], ['--standalone=false'],
    ['--server', 'http://localhost:4096'], ['--server=http://localhost:4096'],
  ])('respects explicit server/isolation selection: %j', (...flags) => {
    const args = ['run', ...flags, 'hello'];
    expect(enrich(args, {} as never)).toEqual(args);
  });

  it('inserts isolation before -- and never reads prompt flags after it', () => {
    expect(enrich(['run', '--', '--server', '--standalone'], {} as never))
      .toEqual(['run', '--standalone', '--', '--server', '--standalone']);
    expect(enrich(['session', 'list', '--'], {} as never)).toEqual(['session', 'list', '--standalone', '--']);
    expect(enrich(['debug', 'paths', '--', '--standalone'], {} as never)).toEqual(['debug', 'paths', '--', '--standalone']);
    expect(enrich(['--'], {} as never)).toEqual(['--standalone', '--']);
  });

  it('isolates root invocations and real directories, but not files or missing paths', () => {
    expect(enrich([], {} as never)).toEqual(['--standalone']);
    expect(enrich(['--print-logs'], {} as never)).toEqual(['--print-logs', '--standalone']);
    expect(enrich([directory], {} as never)).toEqual([directory, '--standalone']);
    expect(enrich(['--', directory], {} as never)).toEqual(['--standalone', '--', directory]);
    for (const path of [join(directory, 'file.txt'), join(directory, 'missing')]) {
      expect(enrich([path], {} as never)).toEqual([path]);
      expect(enrich(['--', path], {} as never)).toEqual(['--', path]);
    }
  });

  it('treats a command-named directory after -- as root data', () => {
    vi.mocked(statSync).mockReturnValueOnce(realFs.statSync(join(directory, 'run')));
    expect(enrich(['--', 'run'], {} as never)).toEqual(['--standalone', '--', 'run']);
    expect(statSync).toHaveBeenCalledWith('run', { throwIfNoEntry: false });
  });

  it('leaves inaccessible directories for native validation', () => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw new Error('EACCES'); });
    expect(enrich([directory], {} as never)).toEqual([directory]);
  });

  it('preserves existing task and honored-effort mappings', () => {
    vi.stubEnv('CODEMIE_OPENCODE_V2_MODEL_REF', 'codemie-proxy/model#high');
    expect(enrich(['--task', 'hello', '--message', 'discarded'], {} as never))
      .toEqual(['run', '--standalone', 'hello', '-m', 'codemie-proxy/model#high']);
    expect(enrich(['--task'], {} as never)).toEqual(['--task', '--standalone']);
  });
});

describe('A3 retained v1 behavior', () => {
  it.each(['v1', '', undefined])('never adds a v2-only flag for marker %j', version => {
    vi.stubEnv(VERSION, version);
    for (const args of [[], ['run', 'hello'], ['debug', 'paths'], ['models'], ['--', directory], ['--standalone']]) {
      expect(enrich(args, {} as never)).toEqual(args);
    }
    expect(enrich(['--task', 'hello'], {} as never)).toEqual(['run', 'hello']);
    expect(statSync).not.toHaveBeenCalled();
    expect(OpenCodePluginMetadata.ownedSubcommands).toEqual(['run', 'chat', 'config', 'init', 'help', 'version']);
  });
});
