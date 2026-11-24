/**
 * Unit tests for the shared codemie hook-command resolver.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('hook-command resolver', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolveHookCommand replaces the leading codemie token, preserving args', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('codemie hook', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie hook');
    expect(resolveHookCommand('codemie sound SessionStart', '/usr/local/bin/codemie')).toBe(
      '/usr/local/bin/codemie sound SessionStart',
    );
    expect(resolveHookCommand('codemie', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie');
  });

  it('resolveHookCommand leaves non-codemie commands unchanged', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('echo hi', '/usr/local/bin/codemie')).toBe('echo hi');
    expect(resolveHookCommand('/usr/bin/env hook', '/usr/local/bin/codemie')).toBe('/usr/bin/env hook');
  });

  it('resolveHookCommand re-resolves an absolute codemie path whose file no longer exists (EPMCDME-15907)', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(
      resolveHookCommand('C:/Users/u/AppData/Local/CodeMie/npm-prefix/codemie hook', 'C:/x/bin/codemie.cmd'),
    ).toBe('C:/x/bin/codemie.cmd hook');
  });

  it('resolveHookCommand adds/removes the PowerShell `& ` prefix on a quoted existing path', async () => {
    const p = 'C:/Users/u/CodeMie Connect/bin/codemie.cmd';
    vi.doMock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), existsSync: () => true }));
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand(`"${p}" hook`, `"${p}"`, true)).toBe(`& "${p}" hook`);
    expect(resolveHookCommand(`& "${p}" hook`, `"${p}"`, false)).toBe(`"${p}" hook`);
    vi.doUnmock('fs');
  });

  it('resolveHookCommand round-trips the `"node" "script.js"` form emitted by resolveBinary', async () => {
    const bin = '"C:/Program Files/nodejs/node.exe" "C:/app/bin/codemie.js"';
    vi.doMock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), existsSync: () => true }));
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand(`${bin} hook`, bin, true)).toBe(`& ${bin} hook`);
    expect(resolveHookCommand(`& ${bin} hook`, bin, false)).toBe(`${bin} hook`);
    vi.doUnmock('fs');
  });

  it('resolveHookCommand heals a stale .exe / .ps1 codemie path', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('"C:/gone/codemie.exe" hook', 'C:/x/codemie.cmd')).toBe('C:/x/codemie.cmd hook');
    expect(resolveHookCommand('& "C:/gone/codemie.ps1" hook', 'C:/x/codemie.cmd')).toBe('C:/x/codemie.cmd hook');
  });

  it('rewriteHooksCommandTree pins quoted-path hooks to "shell": "powershell" only in powershell mode', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const bin = '"C:/Program Files/CodeMie/bin/codemie.cmd"';
    const make = () => ({ SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }] });
    const ps = make();
    expect(rewriteHooksCommandTree(ps, bin, true)).toBe(true);
    expect(ps.SessionStart[0].hooks[0]).toMatchObject({ command: `& ${bin} hook`, shell: 'powershell' });
    const sh = make();
    rewriteHooksCommandTree(sh, bin, false);
    expect(sh.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: `${bin} hook` });
  });

  it('resolveCodemieBinary prefers getCommandPath and quotes spaces', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue('/opt/my apps/codemie') }));
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    expect(bin).toBe('"/opt/my apps/codemie"');
    expect(resolveHookCommand('codemie hook', bin)).toBe('"/opt/my apps/codemie" hook');
  });

  it('resolveCodemieBinary falls back to process.argv[1] when getCommandPath is null', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const spy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('/home/u/.npm/bin/codemie');
    spy.mockRestore();
  });

  it('resolveCodemieBinary never throws — falls back when getCommandPath is unavailable/throws', async () => {
    // Simulates an incomplete mock or a resolver failure: must degrade, not crash.
    vi.doMock('../processes.js', () => ({}));
    const spy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
    const { resolveCodemieBinary } = await import('../hook-command.js');
    await expect(resolveCodemieBinary()).resolves.toBe('/home/u/.npm/bin/codemie');
    spy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, a .js argv[1] fallback is prefixed with node and uses forward slashes', async () => {
    vi.doMock('../processes.js', () => ({
      getCommandPath: vi.fn(async (c: string) => (c === 'git' ? 'C:/Git/cmd/git.exe' : null)),
    }));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'C:\\Users\\u\\app\\codemie.js']);
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const execSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('C:\\Program Files\\nodejs\\node.exe');
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    // Backslashes are converted to forward slashes so bash (Git Bash / WSL) can execute the path.
    expect(bin).toBe('"C:/Program Files/nodejs/node.exe" "C:/Users/u/app/codemie.js"');
    expect(resolveHookCommand('codemie hook', bin)).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/Users/u/app/codemie.js" hook',
    );
    argvSpy.mockRestore();
    platSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, getCommandPath result with backslashes is converted to forward slashes', async () => {
    vi.doMock('../processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('C:\\Users\\u\\AppData\\Local\\CodeMie\\bin\\codemie.cmd'),
    }));
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('C:/Users/u/AppData/Local/CodeMie/bin/codemie.cmd');
    platSpy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, getCommandPath result with spaces and backslashes is quoted with forward slashes', async () => {
    vi.doMock('../processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('C:\\Program Files\\CodeMie\\bin\\codemie.cmd'),
    }));
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('"C:/Program Files/CodeMie/bin/codemie.cmd"');
    platSpy.mockRestore();
  });

  it('resolveCodemieBinary: on non-Windows, a .js argv[1] fallback stays a bare path (shebang-executable)', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/app/codemie.js']);
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('/home/u/app/codemie.js');
    argvSpy.mockRestore();
    platSpy.mockRestore();
  });

  it('rewriteHooksCommandTree rewrites every command and reports change', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const hooks = {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'codemie hook' },
            { type: 'command', command: 'codemie sound SessionStart' },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }],
    };
    const changed = rewriteHooksCommandTree(hooks, '/abs/codemie');
    expect(changed).toBe(true);
    expect(hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(hooks.SessionStart[0].hooks[1].command).toBe('/abs/codemie sound SessionStart');
    expect(hooks.Stop[0].hooks[0].command).toBe('/abs/codemie hook');
  });

  it('rewriteHooksCommandTree returns false when nothing matches', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] };
    expect(rewriteHooksCommandTree(hooks, '/abs/codemie')).toBe(false);
    expect(rewriteHooksCommandTree(null, '/abs/codemie')).toBe(false);
  });
});
