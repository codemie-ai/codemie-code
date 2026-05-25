/**
 * Codebase Memory command tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../daemon-manager.js', () => ({
  checkCodebaseUiStatus: vi.fn(),
  spawnCodebaseUi: vi.fn(),
  stopCodebaseUi: vi.fn(),
}));

vi.mock('../../../../utils/browser.js', () => ({
  openUrlInBrowser: vi.fn(),
}));

vi.mock('../../../../frameworks/plugins/codebase-memory.plugin.js', () => ({
  CodebaseMemoryPlugin: vi.fn(function MockCodebaseMemoryPlugin() {
    return {
      isInstalled: vi.fn().mockResolvedValue(true),
    };
  }),
}));

describe('codebase command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('starts the UI daemon when needed and opens the UI URL', async () => {
    const { checkCodebaseUiStatus, spawnCodebaseUi } = await import('../daemon-manager.js');
    const { openUrlInBrowser } = await import('../../../../utils/browser.js');
    const { createCodebaseCommand } = await import('../index.js');

    vi.mocked(checkCodebaseUiStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnCodebaseUi).mockResolvedValue({
      pid: 12345,
      port: 9749,
      url: 'http://localhost:9749',
      startedAt: new Date().toISOString(),
    });

    const command = createCodebaseCommand();
    await command.parseAsync(['ui'], { from: 'user' });

    expect(spawnCodebaseUi).toHaveBeenCalledWith({ port: 9749 });
    expect(openUrlInBrowser).toHaveBeenCalledWith('http://localhost:9749');
  });

  it('opens an already-running UI without spawning another process', async () => {
    const { checkCodebaseUiStatus, spawnCodebaseUi } = await import('../daemon-manager.js');
    const { openUrlInBrowser } = await import('../../../../utils/browser.js');
    const { createCodebaseCommand } = await import('../index.js');

    vi.mocked(checkCodebaseUiStatus).mockResolvedValue({
      running: true,
      state: {
        pid: 12345,
        port: 9749,
        url: 'http://localhost:9749',
        startedAt: new Date().toISOString(),
      },
    });

    const command = createCodebaseCommand();
    await command.parseAsync(['ui'], { from: 'user' });

    expect(spawnCodebaseUi).not.toHaveBeenCalled();
    expect(openUrlInBrowser).toHaveBeenCalledWith('http://localhost:9749');
  });

  it('restarts the managed daemon when start is called while running', async () => {
    const { checkCodebaseUiStatus, spawnCodebaseUi, stopCodebaseUi } = await import('../daemon-manager.js');
    const { createCodebaseCommand } = await import('../index.js');

    vi.mocked(checkCodebaseUiStatus).mockResolvedValue({
      running: true,
      state: {
        pid: 12345,
        port: 9749,
        url: 'http://localhost:9749',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(spawnCodebaseUi).mockResolvedValue({
      pid: 12346,
      port: 9749,
      url: 'http://localhost:9749',
      startedAt: new Date().toISOString(),
    });

    const command = createCodebaseCommand();
    await command.parseAsync(['start'], { from: 'user' });

    expect(stopCodebaseUi).toHaveBeenCalled();
    expect(spawnCodebaseUi).toHaveBeenCalledWith({ port: 9749 });
  });
});
