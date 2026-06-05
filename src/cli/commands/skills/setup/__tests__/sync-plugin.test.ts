/**
 * syncPluginSkills tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../agents/plugins/claude/claude.plugin-installer.js', () => ({
  ClaudePluginInstaller: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe('syncPluginSkills', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs plugin and copies SKILL.md files with resolved CLAUDE_PLUGIN_ROOT', async () => {
    const { ClaudePluginInstaller } = await import('../../../../../agents/plugins/claude/claude.plugin-installer.js');
    const fs = (await import('fs/promises')).default;
    const { syncPluginSkills } = await import('../sync-plugin.js');

    const mockTargetPath = '/home/user/.codemie/claude-plugin';

    vi.mocked(ClaudePluginInstaller).mockImplementation(function MockInstaller() {
      return {
        install: vi.fn().mockResolvedValue({ success: true, targetPath: mockTargetPath }),
      };
    } as unknown as typeof ClaudePluginInstaller);

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'msgraph', isDirectory: () => true },
    ] as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      '# Skill\nnode ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js status'
    );
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await syncPluginSkills();

    expect(fs.writeFile).toHaveBeenCalledOnce();
    const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0];
    expect(writtenContent).toContain(`${mockTargetPath}/skills/msgraph/scripts/msgraph.js status`);
    expect(writtenContent).not.toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('silently returns when plugin install fails', async () => {
    const { ClaudePluginInstaller } = await import('../../../../../agents/plugins/claude/claude.plugin-installer.js');
    const fs = (await import('fs/promises')).default;
    const { syncPluginSkills } = await import('../sync-plugin.js');

    vi.mocked(ClaudePluginInstaller).mockImplementation(function MockInstaller() {
      return {
        install: vi.fn().mockResolvedValue({ success: false, targetPath: '' }),
      };
    } as unknown as typeof ClaudePluginInstaller);

    await expect(syncPluginSkills()).resolves.toBeUndefined();
    expect(fs.readdir).not.toHaveBeenCalled();
  });
});
