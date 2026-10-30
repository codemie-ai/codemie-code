import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Pins the shapes the backend uses to report a discarded analytics request, hard-coded here so
 * the test never reads the backend: the hooks route answers 200 with a JSON body, the OTLP routes
 * answer 200 with a `partial_success` whose `error_message` is the reason (protobuf or JSON).
 */

const snapshotPendingHookRecordsMock = vi.fn();
const snapshotPendingBytesMock = vi.fn();
const advanceCursorMock = vi.fn();
const markSessionEndedMock = vi.fn();
const isSendAllowedMock = vi.fn();
const readStateMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../spool-io.js', () => ({
  snapshotPendingHookRecords: snapshotPendingHookRecordsMock,
  snapshotPendingBytes: snapshotPendingBytesMock,
  isSendAllowed: isSendAllowedMock,
}));
vi.mock('../session-status.js', () => ({
  advanceCursor: advanceCursorMock,
  markSessionEnded: markSessionEndedMock,
}));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };

const EXPECTED_REASONS = ['cli_analytics_disabled', 'project_context_required', 'project_context_conflict'];
const UNKNOWN_REASON = 'some_future_reason';

type OtlpStream = 'logs' | 'metrics' | 'traces';
const OTLP_STREAMS: OtlpStream[] = ['logs', 'metrics', 'traces'];

/** Hooks route body for a discarded request. */
const hooksDropBody = (reason: string, dropped = 3): string =>
  JSON.stringify({ accepted: 0, dropped, reason });

/**
 * Protobuf `Export*ServiceResponse { partial_success = 1 { rejected_* = 1 (varint), error_message = 2 } }`.
 * Logs, metrics and traces differ only in the name of field 1 of the inner message, not on the wire.
 */
function otlpProtobufBody(reason: string, rejected = 3): string {
  const message = Buffer.from(reason, 'utf8');
  const partial = Buffer.concat([Buffer.from([0x08, rejected, 0x12, message.length]), message]);
  return Buffer.concat([Buffer.from([0x0a, partial.length]), partial]).toString('latin1');
}

const REJECTED_FIELD: Record<OtlpStream, string> = {
  logs: 'rejectedLogRecords',
  metrics: 'rejectedDataPoints',
  traces: 'rejectedSpans',
};

const otlpJsonBody = (stream: OtlpStream, reason: string, rejected = 3): string =>
  JSON.stringify({ partialSuccess: { [REJECTED_FIELD[stream]]: rejected, errorMessage: reason } });

const spoolLine = (wireEvent: Record<string, unknown>): string =>
  JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(wireEvent) });

/** Answers the request for `stream` with `body`; every other route answers a clean 200. */
function respondOnly(stream: 'hooks' | OtlpStream, body: string): void {
  const suffix = stream === 'hooks' ? '/event-hooks' : `/${stream}`;
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith(suffix) ? { ok: true, status: 200, text: async () => body } : { ok: true, status: 200 }
  );
}

async function drive(stream: 'hooks' | OtlpStream, sessionId = 's1'): Promise<void> {
  const { forwardSession } = await import('../forwarder.js');
  await forwardSession(sessionId, stream === 'hooks', credentials);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('backend drop contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    isSendAllowedMock.mockResolvedValue(true);
    snapshotPendingHookRecordsMock.mockResolvedValue({
      project: 'Proj A',
      records: [spoolLine({ type: 'agent.tool.end', session_id: 's1' })],
      cursor: 0,
      byteLength: 10,
      dropped: 0,
      filtered: false,
    });
    snapshotPendingBytesMock.mockResolvedValue({ project: 'Proj A', cursor: 0, bytes: Buffer.alloc(10) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('knows exactly the reasons the backend gate and ingestor report', async () => {
    const { BACKEND_DROP_REASONS } = await import('../forwarder.js');

    expect([...BACKEND_DROP_REASONS].sort()).toEqual([...EXPECTED_REASONS].sort());
  });

  describe.each(EXPECTED_REASONS)('reason %s', (reason) => {
    it('is reported from the hooks JSON body', async () => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly('hooks', hooksDropBody(reason));

      await drive('hooks');

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[otlp-forwarder] backend dropped analytics events',
        expect.objectContaining({ reason, stream: 'hooks', project: 'Proj A', dropped: 3 })
      );
    });

    it.each(OTLP_STREAMS)('is reported from the %s protobuf partial_success', async (stream) => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly(stream, otlpProtobufBody(reason));

      await drive(stream);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[otlp-forwarder] backend dropped analytics events',
        expect.objectContaining({ reason, stream, project: 'Proj A' })
      );
    });

    it.each(OTLP_STREAMS)('is reported from the %s JSON partialSuccess', async (stream) => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly(stream, otlpJsonBody(stream, reason));

      await drive(stream);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[otlp-forwarder] backend dropped analytics events',
        expect.objectContaining({ reason, stream, project: 'Proj A' })
      );
    });
  });

  describe('an unknown reason', () => {
    it('is not reported from the hooks JSON body', async () => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly('hooks', hooksDropBody(UNKNOWN_REASON));

      await drive('hooks');

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each(OTLP_STREAMS)('is not reported from the %s protobuf partial_success', async (stream) => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly(stream, otlpProtobufBody(UNKNOWN_REASON));

      await drive(stream);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each(OTLP_STREAMS)('is not reported from the %s JSON partialSuccess', async (stream) => {
      const { logger } = await import('@/utils/logger.js');
      respondOnly(stream, otlpJsonBody(stream, UNKNOWN_REASON));

      await drive(stream);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
