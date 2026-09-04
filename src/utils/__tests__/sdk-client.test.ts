import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const oraInstance = {
  text: '',
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
};
const oraFactory = vi.fn(() => {
  oraInstance.start.mockReturnValue(oraInstance);
  return oraInstance;
});

vi.mock('ora', () => ({ default: oraFactory }));

vi.mock('../interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn(),
  isNonInteractiveOutput: vi.fn(),
}));

vi.mock('../config.js', () => ({
  ConfigLoader: { load: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const getStoredCredentials = vi.fn();
vi.mock('../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = getStoredCredentials;
  },
}));

describe('getCodemieClient spinner behaviour', () => {
  beforeEach(() => {
    oraFactory.mockClear();
    oraInstance.start.mockClear();
    getStoredCredentials.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function arrange(opts: { stdinTty: boolean; stderrTty: boolean }) {
    const { isNonInteractiveEnvironment, isNonInteractiveOutput } = await import(
      '../interactive.js'
    );
    const { ConfigLoader } = await import('../config.js');

    vi.mocked(isNonInteractiveEnvironment).mockReturnValue(!opts.stdinTty);
    vi.mocked(isNonInteractiveOutput).mockReturnValue(!opts.stderrTty);
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      codeMieUrl: 'https://example.test',
    } as never);
    getStoredCredentials.mockResolvedValue(null);

    return import('../sdk-client.js');
  }



  it('suppresses the spinner when stdout/stderr are redirected but stdin is a TTY', async () => {
    const { ConfigurationError } = await import('../errors.js');
    const { getCodemieClient } = await arrange({
      stdinTty: true,
      stderrTty: false,
    });

    await expect(getCodemieClient()).rejects.toThrow(ConfigurationError);
    expect(oraFactory).not.toHaveBeenCalled();
  });

  it('keeps the spinner when stdin is redirected but stderr is still a TTY', async () => {
    const { ConfigurationError } = await import('../errors.js');
    const { getCodemieClient } = await arrange({
      stdinTty: false,
      stderrTty: true,
    });

    await expect(getCodemieClient()).rejects.toThrow(ConfigurationError);
    expect(oraFactory).toHaveBeenCalled();
  });

  it('honours an explicit quiet flag even when stderr is a TTY', async () => {
    const { ConfigurationError } = await import('../errors.js');
    const { getCodemieClient } = await arrange({
      stdinTty: true,
      stderrTty: true,
    });

    await expect(getCodemieClient(true)).rejects.toThrow(ConfigurationError);
    expect(oraFactory).not.toHaveBeenCalled();
  });
});
