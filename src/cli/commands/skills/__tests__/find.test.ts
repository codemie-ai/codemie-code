/**
 * Command-level tests for `codemie skills find`.
 *
 * Spec §10 acceptance criteria:
 *   - two-section render with EPAM Internal first, Public second
 *   - empty query → delegates to upstream `skills find`
 *   - query <2 chars → exits 0 with hint, no HTTP, no metric
 *   - all-source failure → exit 1, error_code='all_searches_failed'
 *   - no lifecycle metrics; find/search is intentionally too noisy
 *   - SSO-gated
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireAuth = vi.fn();
const mockRunSkillsCli = vi.fn();
const mockEmitCompleted = vi.fn();
const mockEmitFailed = vi.fn();
const mockStartSkillMetric = vi.fn();
const mockSearchInternal = vi.fn();
const mockSearchPublic = vi.fn();
const mockResolveInternalContext = vi.fn();
const mockConfigLoad = vi.fn();

vi.mock('../lib/require-auth.js', () => ({
  requireAuthenticatedSession: () => mockRequireAuth(),
}));

vi.mock('../lib/run-skills-cli.js', () => ({
  runSkillsCli: (...args: unknown[]) => mockRunSkillsCli(...args),
}));

vi.mock('../lib/skills-metrics.js', () => ({
  startSkillMetric: (...args: unknown[]) => mockStartSkillMetric(...args),
  emitCompleted: (...args: unknown[]) => mockEmitCompleted(...args),
  emitFailed: (...args: unknown[]) => mockEmitFailed(...args),
}));

vi.mock('../lib/skills-search-client.js', () => ({
  searchInternal: (...args: unknown[]) => mockSearchInternal(...args),
  searchPublic: (...args: unknown[]) => mockSearchPublic(...args),
  resolveInternalContext: () => mockResolveInternalContext(),
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: () => mockConfigLoad() },
}));

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let exitCalls: number[];
let stdoutBuf: string;

beforeEach(() => {
  delete process.env.CODEMIE_SKILLS_SEARCH_URL;
  mockRequireAuth.mockReset().mockResolvedValue(true);
  mockRunSkillsCli
    .mockReset()
    .mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });
  mockStartSkillMetric.mockReset().mockResolvedValue({
    command: 'find',
    sessionId: 's',
    agentVersion: '0',
    workingDirectory: process.cwd(),
    transport: null,
  });
  mockEmitCompleted.mockReset().mockResolvedValue(undefined);
  mockEmitFailed.mockReset().mockResolvedValue(undefined);
  mockSearchInternal
    .mockReset()
    .mockResolvedValue({ available: false, results: [] });
  mockSearchPublic.mockReset().mockResolvedValue({
    available: true,
    results: [{ name: 'pdf', slug: 'a/b/pdf', source: 'a/b', installs: 100 }],
  });
  // Default: internal is NOT configured (env var unset, no profile field).
  // Tests opt in to "configured" by overriding this mock.
  mockResolveInternalContext.mockReset().mockResolvedValue(null);
  mockConfigLoad.mockReset().mockResolvedValue({});

  exitCalls = [];
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__EXIT__:${code ?? 0}`);
  }) as never);
  stdoutBuf = '';
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    }) as typeof process.stdout.write);
});

afterEach(() => {
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  delete process.env.CODEMIE_SKILLS_SEARCH_URL;
  vi.resetModules();
});

async function importCommands(): Promise<typeof import('../index.js')> {
  vi.resetModules();
  return import('../index.js');
}

async function parse(argv: string[]): Promise<void> {
  const { createSkillsCommand } = await importCommands();
  const command = createSkillsCommand();
  command.exitOverride();
  await command.parseAsync(['node', 'codemie', ...argv]);
}

describe('codemie skills find', () => {
  it('runs the auth gate before any side effect', async () => {
    await parse(['find', 'pdf']);
    expect(mockRequireAuth).toHaveBeenCalled();
    // requireAuth is the FIRST awaited call
    const requireAuthOrder = mockRequireAuth.mock.invocationCallOrder[0]!;
    const searchOrder = mockSearchPublic.mock.invocationCallOrder[0]!;
    expect(requireAuthOrder).toBeLessThan(searchOrder);
  });

  it('prints a hint and exits 0 when query is shorter than 2 chars', async () => {
    await parse(['find', 'p']);
    expect(stdoutBuf).toContain('Start typing (min 2 chars)');
    expect(mockSearchInternal).not.toHaveBeenCalled();
    expect(mockSearchPublic).not.toHaveBeenCalled();
    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(exitCalls).toEqual([]);
  });

  it('delegates to upstream skills find when no query is provided', async () => {
    await parse(['find']);
    expect(mockRunSkillsCli).toHaveBeenCalledWith(['find'], expect.any(Object));
    expect(mockSearchInternal).not.toHaveBeenCalled();
    expect(mockSearchPublic).not.toHaveBeenCalled();
  });

  it('renders both sections in order: EPAM Internal first, Public second', async () => {
    await parse(['find', 'pdf']);
    const internalIdx = stdoutBuf.indexOf('EPAM Internal');
    const publicIdx = stdoutBuf.indexOf('Public (skills.sh)');
    expect(internalIdx).toBeGreaterThanOrEqual(0);
    expect(publicIdx).toBeGreaterThan(internalIdx);
  });

  it('does not emit lifecycle metrics for successful searches', async () => {
    await parse(['find', 'pdf']);

    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(mockEmitCompleted).not.toHaveBeenCalled();
    expect(mockEmitFailed).not.toHaveBeenCalled();
  });

  it('does not emit lifecycle metrics when the internal endpoint is configured', async () => {
    mockResolveInternalContext.mockResolvedValue({
      url: 'https://internal.example.com/search',
      headers: { Cookie: 'session=abc' },
    });
    mockSearchInternal.mockResolvedValue({
      available: true,
      results: [{ name: 'sec', slug: 'epam/sec', source: 'epam', installs: 1 }],
    });

    await parse(['find', 'pdf']);

    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(mockEmitCompleted).not.toHaveBeenCalled();
    expect(mockEmitFailed).not.toHaveBeenCalled();
  });

  it('exits 1 with all_searches_failed when every attempted call fails', async () => {
    mockSearchPublic.mockResolvedValue({ available: false, results: [] });

    await expect(parse(['find', 'pdf'])).rejects.toThrow(/__EXIT__:/);

    expect(exitCalls[0]).toBe(1);
    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(mockEmitFailed).not.toHaveBeenCalled();
    expect(mockEmitCompleted).not.toHaveBeenCalled();
  });

  it('exits 0 without metrics when partial degradation still has one successful source', async () => {
    mockResolveInternalContext.mockResolvedValue({
      url: 'https://internal.example.com/search',
      headers: { Cookie: 'session=abc' },
    });
    mockSearchInternal.mockResolvedValue({
      available: true,
      results: [{ name: 'sec', slug: 'epam/sec', source: 'epam' }],
    });
    mockSearchPublic.mockResolvedValue({ available: false, results: [] });

    await parse(['find', 'pdf']);

    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(mockEmitCompleted).not.toHaveBeenCalled();
    expect(mockEmitFailed).not.toHaveBeenCalled();
    expect(exitCalls).toEqual([]);
  });

  it('--json emits a JSON object and never sends the raw query in metrics', async () => {
    await parse(['find', 'pdf', '--json']);

    expect(stdoutBuf.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed.query).toBe('pdf');
    expect(parsed.public.available).toBe(true);
    expect(parsed.internal.available).toBe(false);

    expect(mockStartSkillMetric).not.toHaveBeenCalled();
    expect(mockEmitCompleted).not.toHaveBeenCalled();
    expect(mockEmitFailed).not.toHaveBeenCalled();
  });

  it('caps --limit at 50 and forwards the value to both searches', async () => {
    await parse(['find', 'pdf', '--limit', '999']);
    expect(mockSearchInternal).toHaveBeenCalledWith('pdf', 50, null);
    expect(mockSearchPublic).toHaveBeenCalledWith('pdf', 50);
  });

  it('uses default limit of 10 when --limit is omitted', async () => {
    await parse(['find', 'pdf']);
    expect(mockSearchPublic).toHaveBeenCalledWith('pdf', 10);
  });

  it('passes the resolved internal context through to searchInternal', async () => {
    const ctx = {
      url: 'https://internal.example.com/search',
      headers: { Cookie: 'session=abc', 'X-CodeMie-Client': 'codemie-cli' },
    };
    mockResolveInternalContext.mockResolvedValue(ctx);

    await parse(['find', 'pdf']);
    expect(mockResolveInternalContext).toHaveBeenCalledOnce();
    expect(mockSearchInternal).toHaveBeenCalledWith('pdf', 10, ctx);
  });
});
