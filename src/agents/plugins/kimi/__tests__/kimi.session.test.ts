import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { KimiSessionAdapter } from '../kimi.session.js';
import { KimiMetricsProcessor } from '../session/processors/kimi.metrics-processor.js';
import type { MetricDelta } from '../../../core/metrics/types.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const { mockAppendDelta, mockReadAll } = vi.hoisted(() => ({
  mockAppendDelta: vi.fn<(delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>) => Promise<string>>(),
  mockReadAll: vi.fn<() => Promise<MetricDelta[]>>(),
}));

vi.mock('../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js', () => ({
  MetricsWriter: vi.fn(function (this: { appendDelta: typeof mockAppendDelta; readAll: typeof mockReadAll; getFilePath: () => string; exists: () => boolean }) {
    this.appendDelta = mockAppendDelta;
    this.readAll = mockReadAll;
    this.getFilePath = vi.fn().mockReturnValue('/tmp/test-metrics.jsonl');
    this.exists = vi.fn().mockReturnValue(false);
  }),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const baseContext = {
  apiBaseUrl: '',
  cookies: '',
  clientType: 'test',
  version: '0.0.0',
  dryRun: true,
};

function createAdapter(): KimiSessionAdapter {
  return new KimiSessionAdapter({
    name: 'kimi',
    displayName: 'Kimi Code',
    description: 'Kimi Code agent',
    npmPackage: null,
    cliCommand: 'kimi',
    envMapping: {},
    supportedProviders: [],
    dataPaths: { home: '.kimi-code' },
  });
}

describe('KimiSessionAdapter.parseSessionFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadAll.mockResolvedValue([]);
    mockAppendDelta.mockImplementation(async (delta) => delta.recordId);
  });

  it('parses the sample wire.jsonl fixture', async () => {
    const adapter = createAdapter();
    const fixturePath = join(__dirname, 'fixtures', 'sample-wire.jsonl');

    const session = await adapter.parseSessionFile(fixturePath, 'test-session-001');

    expect(session.sessionId).toBe('test-session-001');
    expect(session.agentName).toBe('Kimi Code');
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.metrics).toBeUndefined();
  });

  it('extracts the model from config.update.modelAlias', async () => {
    const adapter = createAdapter();
    const fixturePath = join(__dirname, 'fixtures', 'sample-wire.jsonl');

    const session = await adapter.parseSessionFile(fixturePath, 'test-session-001');

    expect(session.metadata.model).toBe('kimi-code/kimi-for-coding');
  });

  it('falls back to usage.record.model when config.update.modelAlias is absent', async () => {
    const adapter = createAdapter();

    const session = await adapter.parseSessionFile(
      join(__dirname, 'fixtures', 'usage-only-model.jsonl'),
      'usage-model-session'
    );

    expect(session.metadata.model).toBe('kimi-code/fallback-model');
  });

  it('counts Read and Write tool calls after metrics processing', async () => {
    const adapter = createAdapter();
    const processor = new KimiMetricsProcessor();
    const fixturePath = join(__dirname, 'fixtures', 'sample-wire.jsonl');

    const session = await adapter.parseSessionFile(fixturePath, 'test-session-001');
    await processor.process(session, baseContext);

    const deltas = mockAppendDelta.mock.calls.map((call) => call[0]);
    const allTools = deltas.reduce<Record<string, number>>((acc, delta) => {
      for (const [name, count] of Object.entries(delta.tools ?? {})) {
        acc[name] = (acc[name] || 0) + count;
      }
      return acc;
    }, {});

    expect(allTools.Read).toBe(1);
    expect(allTools.Write).toBe(1);
  });

  it('tracks successful Read tool results after metrics processing', async () => {
    const adapter = createAdapter();
    const processor = new KimiMetricsProcessor();
    const fixturePath = join(__dirname, 'fixtures', 'sample-wire.jsonl');

    const session = await adapter.parseSessionFile(fixturePath, 'test-session-001');
    await processor.process(session, baseContext);

    const deltas = mockAppendDelta.mock.calls.map((call) => call[0]);
    const allStatus = deltas.reduce<Record<string, { success: number; failure: number }>>((acc, delta) => {
      for (const [name, status] of Object.entries(delta.toolStatus ?? {})) {
        if (!acc[name]) acc[name] = { success: 0, failure: 0 };
        acc[name].success += status.success;
        acc[name].failure += status.failure;
      }
      return acc;
    }, {});

    expect(allStatus.Read?.success).toBeGreaterThanOrEqual(1);
    expect(allStatus.Read?.failure).toBe(0);
  });

  it('captures file operations from display metadata after metrics processing', async () => {
    const adapter = createAdapter();
    const processor = new KimiMetricsProcessor();
    const fixturePath = join(__dirname, 'fixtures', 'sample-wire.jsonl');

    const session = await adapter.parseSessionFile(fixturePath, 'test-session-001');
    await processor.process(session, baseContext);

    const fileOps = mockAppendDelta.mock.calls
      .map((call) => call[0])
      .flatMap((delta) => delta.fileOperations ?? []);
    const readOps = fileOps.filter((op) => op.type === 'read');
    const writeOps = fileOps.filter((op) => op.type === 'write');

    expect(readOps.length).toBeGreaterThanOrEqual(1);
    expect(writeOps.length).toBeGreaterThanOrEqual(1);
    expect(readOps[0]?.path).toBe('/Users/alice/project/src/index.ts');
  });

  it('returns a minimal session for a missing file', async () => {
    const adapter = createAdapter();

    const session = await adapter.parseSessionFile(
      join(__dirname, 'fixtures', 'does-not-exist.jsonl'),
      'missing-session'
    );

    expect(session.sessionId).toBe('missing-session');
    expect(session.agentName).toBe('Kimi Code');
    expect(session.messages).toEqual([]);
    expect(session.metrics).toBeUndefined();
  });
});
