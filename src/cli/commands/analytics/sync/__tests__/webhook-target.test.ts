import { describe, expect, it, vi } from 'vitest';

import { ExportTooLargeError, SyncDeliveryError } from '../../../../../utils/errors.js';
import { MAX_EXPORT_BYTES, WEBHOOK_TIMEOUT_MS, WebhookTarget, sendWebhook } from '../targets/webhook-target.js';

describe('WebhookTarget', () => {
  it('resolves on a 2xx response and sends the expected request shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    const bytes = Buffer.from('{"a":1}');
    await expect(target.deliver([{ fileName: 'report.json', bytes, contentType: 'application/json' }])).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.invalid/hook?sig=FAKE');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      type: 'message',
      attachments: [
        {
          contentType: 'application/json',
          name: 'report.json',
          contentBytes: bytes.toString('base64'),
        },
      ],
    });
  });

  it('labels the attachment with the report\'s own content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await target.deliver([{ fileName: 'export.otlp.jsonl.gz', bytes: Buffer.from('x'), contentType: 'application/gzip' }]);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).attachments[0].contentType).toBe('application/gzip');
  });

  it('throws SyncDeliveryError with status on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await expect(target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }])).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncDeliveryError && err.status === 500
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the signature from a fetch rejection message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network failure for sig=FAKESIG'));
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKESIG', fetchImpl);

    await expect(target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }])).rejects.toSatisfy(
      (err: unknown) => {
        if (!(err instanceof SyncDeliveryError)) return false;
        return !err.message.includes('FAKESIG');
      }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds the POST with a timeout signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }]);

    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a timeout abort to SyncDeliveryError naming the timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await expect(target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }])).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncDeliveryError && /did not respond within 5 minutes/.test(err.message)
    );
  });

  it('bounds the POST with WEBHOOK_TIMEOUT_MS by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }]);

    expect(spy).toHaveBeenCalledWith(WEBHOOK_TIMEOUT_MS);
  });

  it('honors a custom timeoutMs passed to the constructor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl, 30_000);

    await target.deliver([{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }]);

    expect(spy).toHaveBeenCalledWith(30_000);
  });

  it('honors a custom timeoutMs passed to sendWebhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await sendWebhook('https://example.invalid/hook?sig=FAKE', [{ fileName: 'report.json', bytes: Buffer.from('{}'), contentType: 'application/json' }], fetchImpl, 30_000);

    expect(spy).toHaveBeenCalledWith(30_000);
  });

  it('throws ExportTooLargeError above the size limit without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    const bytes = Buffer.alloc(MAX_EXPORT_BYTES + 1);
    await expect(target.deliver([{ fileName: 'report.json', bytes, contentType: 'application/json' }])).rejects.toSatisfy(
      (err: unknown) => err instanceof ExportTooLargeError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('several files', () => {
    const file = (fileName: string) => ({ fileName, bytes: Buffer.from(fileName), contentType: 'application/gzip' });

    /** A webhook answering `statuses[name]` for a file of that name, 200 for any other. */
    function webhook(statuses: Record<string, number>) {
      const posted: string[] = [];
      const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
        const name = JSON.parse(init.body).attachments[0].name as string;
        posted.push(name);
        const status = statuses[name] ?? 200;
        return { ok: status === 200, status };
      });
      return { posted, target: new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl as never) };
    }

    it('posts one request each, in order', async () => {
      const { posted, target } = webhook({});

      await target.deliver([file('a.gz'), file('c.gz')]);
      expect(posted).toEqual(['a.gz', 'c.gz']);
    });

    it('the second failing: all three posted in order, the second error thrown', async () => {
      const { posted, target } = webhook({ 'b.gz': 500 });

      await expect(target.deliver([file('a.gz'), file('b.gz'), file('c.gz')])).rejects.toSatisfy(
        (err: unknown) => err instanceof SyncDeliveryError && err.status === 500
      );
      expect(posted).toEqual(['a.gz', 'b.gz', 'c.gz']);
    });

    it('edge: the first and the third failing: the first one\'s error', async () => {
      const { posted, target } = webhook({ 'a.gz': 502, 'c.gz': 503 });

      await expect(target.deliver([file('a.gz'), file('b.gz'), file('c.gz')])).rejects.toSatisfy(
        (err: unknown) => err instanceof SyncDeliveryError && err.status === 502
      );
      expect(posted).toEqual(['a.gz', 'b.gz', 'c.gz']);
    });

    it('edge: a file above the cap between two others: no request for it, the other two posted, ExportTooLargeError', async () => {
      const { posted, target } = webhook({});
      const big = { fileName: 'big.gz', bytes: Buffer.alloc(MAX_EXPORT_BYTES + 1), contentType: 'application/gzip' };

      await expect(target.deliver([file('a.gz'), big, file('c.gz')])).rejects.toSatisfy(
        (err: unknown) => err instanceof ExportTooLargeError
      );
      expect(posted).toEqual(['a.gz', 'c.gz']);
    });
  });
});
