/**
 * MCP command tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';

vi.mock('../../../../utils/exec.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../../../utils/processes.js', () => ({
  getCommandPath: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn().mockReturnValue('/home/test/.local/bin/claude'),
}));

// The fast-path claude lookup is only attempted on non-Windows; the fallback shell flag
// mirrors os.platform() === 'win32' either way, so compute the expectation from the real os module.
const expectedShell = os.platform() === 'win32';

describe('mcp command', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  /** Makes the ~/.local/bin/claude fast-path check fail so resolution falls back to PATH lookup. */
  async function mockClaudeResolved(mcpResultCode = 0) {
    const { exec } = await import('../../../../utils/exec.js');
    const { getCommandPath } = await import('../../../../utils/processes.js');

    vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
      if (command === 'claude') return '/usr/local/bin/claude';
      if (command === 'codemie-mcp-proxy') return '/usr/local/bin/codemie-mcp-proxy';
      return null;
    });

    vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
      if (args.includes('--version')) {
        throw new Error('ENOENT: claude not found at fast path');
      }
      return { code: mcpResultCode, stdout: '', stderr: '' };
    });

    return { exec, getCommandPath };
  }

  describe('add', () => {
    it('registers the MCP server via codemie-mcp-proxy and exits with the claude exit code', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', 'my-server', '--', 'codemie-mcp-proxy', 'https://example.com/mcp'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('inserts --scope before the server name when provided', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp', '--scope', 'project'], {
          from: 'user',
        })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', '--scope', 'project', 'my-server', '--', 'codemie-mcp-proxy', 'https://example.com/mcp'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('rejects an invalid MCP server URL before touching claude', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'not-a-url'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid MCP server URL: not-a-url');
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects a server name that looks like a flag', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', '--', '-badname', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid server name: -badname');
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when codemie-mcp-proxy is not installed', async () => {
      const { exec, getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
        if (command === 'claude') return '/usr/local/bin/claude';
        return null;
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'codemie-mcp-proxy not found. Reinstall @codemieai/code to restore the MCP proxy binary.'
      );
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockImplementation(async (command: string) => {
        if (command === 'codemie-mcp-proxy') return '/usr/local/bin/codemie-mcp-proxy';
        return null;
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['add', 'my-server', 'https://example.com/mcp'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });
  });

  describe('remove', () => {
    it('removes a registered MCP server by name', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['remove', 'my-server'], { from: 'user' })).rejects.toThrow(
        /^process\.exit:/
      );

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'remove', 'my-server'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('forwards --scope to the underlying claude mcp remove call', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['remove', 'my-server', '--scope', 'project'], { from: 'user' })
      ).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'remove', '--scope', 'project', 'my-server'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('rejects a server name that looks like a flag', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(
        command.parseAsync(['remove', '--', '-badname'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Invalid server name: -badname');
      expect(exec).not.toHaveBeenCalled();
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockResolvedValue(null);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['remove', 'my-server'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });
  });

  describe('list', () => {
    it('lists registered MCP servers', async () => {
      const { exec } = await mockClaudeResolved(0);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exec).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'list'],
        { interactive: true, shell: expectedShell }
      );
    });

    it('errors out when the claude CLI cannot be found', async () => {
      const { getCommandPath } = await mockClaudeResolved(0);
      vi.mocked(getCommandPath).mockResolvedValue(null);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });

    it('propagates the exit code returned by the claude CLI', async () => {
      await mockClaudeResolved(3);
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow(/^process\.exit:/);

      expect(exitSpy).toHaveBeenNthCalledWith(1, 3);
    });

    it('exits 1 when claude cannot be spawned (ENOENT)', async () => {
      const { exec } = await mockClaudeResolved(0);
      vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
        if (args.includes('--version')) {
          throw new Error('ENOENT: claude not found at fast path');
        }
        throw new Error('spawn claude ENOENT');
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith('claude CLI not found. Install Claude Code: https://claude.ai/code');
    });

    it('extracts the exit code from a non-interactive rejection message', async () => {
      const { exec } = await mockClaudeResolved(0);
      vi.mocked(exec).mockImplementation(async (_command: string, args: string[] = []) => {
        if (args.includes('--version')) {
          throw new Error('ENOENT: claude not found at fast path');
        }
        throw new Error('Command exited with code 7');
      });
      const { createMcpCommand } = await import('../index.js');

      const command = createMcpCommand();
      await expect(command.parseAsync(['list'], { from: 'user' })).rejects.toThrow('process.exit:7');
    });
  });
});
