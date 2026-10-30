import { describe, expect, it, vi } from 'vitest';

import { ExportTooLargeError, SyncDeliveryError } from '../../../../../utils/errors.js';
import { MAX_EXPORT_BYTES, WebhookTarget } from '../targets/webhook-target.js';

describe('WebhookTarget', () => {
  it('resolves on a 2xx response and sends the expected request shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    const bytes = Buffer.from('{"a":1}');
    await expect(target.deliver({ fileName: 'report.json', bytes })).resolves.toBeUndefined();

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

  it('throws SyncDeliveryError with status on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await expect(target.deliver({ fileName: 'report.json', bytes: Buffer.from('{}') })).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncDeliveryError && err.status === 500
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the signature from a fetch rejection message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network failure for sig=FAKESIG'));
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKESIG', fetchImpl);

    await expect(target.deliver({ fileName: 'report.json', bytes: Buffer.from('{}') })).rejects.toSatisfy(
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

    await target.deliver({ fileName: 'report.json', bytes: Buffer.from('{}') });

    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a timeout abort to SyncDeliveryError naming the timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    await expect(target.deliver({ fileName: 'report.json', bytes: Buffer.from('{}') })).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncDeliveryError && /did not respond within 5 minutes/.test(err.message)
    );
  });

  it('throws ExportTooLargeError above the size limit without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const target = new WebhookTarget('https://example.invalid/hook?sig=FAKE', fetchImpl);

    const bytes = Buffer.alloc(MAX_EXPORT_BYTES + 1);
    await expect(target.deliver({ fileName: 'report.json', bytes })).rejects.toSatisfy(
      (err: unknown) => err instanceof ExportTooLargeError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
