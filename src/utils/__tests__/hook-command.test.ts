/**
 * Unit tests for the shared codemie hook-command resolver.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('hook-command resolver', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolveHookCommand replaces the leading codemie token, preserving args', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('codemie hook', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie hook');
    expect(resolveHookCommand('codemie sound SessionStart', '/usr/local/bin/codemie')).toBe(
      '/usr/local/bin/codemie sound SessionStart',
    );
    expect(resolveHookCommand('codemie', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie');
  });

  it('resolveHookCommand leaves non-codemie and already-absolute commands unchanged', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('echo hi', '/usr/local/bin/codemie')).toBe('echo hi');
    expect(resolveHookCommand('/usr/local/bin/codemie hook', '/usr/local/bin/codemie')).toBe(
      '/usr/local/bin/codemie hook',
    );
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

  it('resolveCodemieBinary: on Windows, a .js argv[1] fallback is prefixed with the node executable', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'C:\\Users\\u\\app\\codemie.js']);
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const execSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('C:\\Program Files\\nodejs\\node.exe');
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    // A raw .js path is not invocable as a Windows hook command; prefix node.
    expect(bin).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\app\\codemie.js"');
    expect(resolveHookCommand('codemie hook', bin)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\app\\codemie.js" hook',
    );
    argvSpy.mockRestore();
    platSpy.mockRestore();
    execSpy.mockRestore();
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
