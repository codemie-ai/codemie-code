import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CONNECT_MESSAGE =
  'This CodeMie CLI is part of CodeMie Connect. Update it from the CodeMie Connect app.';

vi.mock('../../../utils/cli-updater.js', () => ({
  isCodemieConnectInstall: vi.fn().mockResolvedValue(true),
  checkForCliUpdate: vi.fn(),
  updateCli: vi.fn(),
  isAutoUpdateEnabled: vi.fn()
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn()
  }))
}));

import ora from 'ora';
import { checkForCliUpdate, updateCli } from '../../../utils/cli-updater.js';
import { createSelfUpdateCommand } from '../self-update.js';

describe('self-update command in CodeMie Connect', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['without --check', ['node', 'self-update']],
    ['with --check', ['node', 'self-update', '--check']]
  ])('prints the Connect message and does nothing else %s', async (_label, argv) => {
    await createSelfUpdateCommand().parseAsync(argv);

    expect(logSpy).toHaveBeenCalledWith(CONNECT_MESSAGE);
    expect(checkForCliUpdate).not.toHaveBeenCalled();
    expect(updateCli).not.toHaveBeenCalled();
    expect(ora).not.toHaveBeenCalled();
    const nonZeroExit = exitSpy.mock.calls.some(([code]) => code !== undefined && code !== 0);
    expect(nonZeroExit).toBe(false);
  });
});
