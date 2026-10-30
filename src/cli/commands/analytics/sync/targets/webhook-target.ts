/**
 * Webhook delivery target for `codemie analytics sync`.
 *
 * POSTs the analytics export as a single JSON attachment to a configured HTTPS webhook URL —
 * the one target `codemie analytics sync` ships to (no per-target grouping, no retry). Any 2xx
 * response resolves; a response above {@link MAX_EXPORT_BYTES} throws `ExportTooLargeError`
 * before any network call; a POST that takes longer than {@link WEBHOOK_TIMEOUT_MS} is aborted;
 * a redirect response or a non-2xx response or a `fetchImpl`
 * rejection becomes a `SyncDeliveryError` with a redacted message (the signed URL query
 * parameter must never leak into it).
 *
 * `sendWebhook` is the free-function seam `run-sync.ts`'s `SyncDeps.send(url, report)` wires to;
 * `WebhookTarget` is its implementation, constructed fresh per call since the URL can change
 * between settings reads.
 */

import { ExportTooLargeError, SyncDeliveryError } from '../../../../../utils/errors.js';
import { errorMessage } from '../redact.js';
import type { SyncReport } from '../types.js';

export const MAX_EXPORT_BYTES = 70_000_000;

/** Upper bound on one POST, so a webhook that accepts the connection but never answers cannot
 * keep the daily job (systemd oneshot / launchd, both without their own limit) running. */
export const WEBHOOK_TIMEOUT_MS = 5 * 60_000;

function deliveryFailureMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `Webhook did not respond within ${WEBHOOK_TIMEOUT_MS / 60_000} minutes`;
  }
  return errorMessage(err);
}

const defaultFetch: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

/** POSTs one analytics export to one webhook URL. */
export class WebhookTarget {
  readonly id = 'webhook';

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  async deliver(report: SyncReport): Promise<void> {
    if (report.bytes.length > MAX_EXPORT_BYTES) {
      throw new ExportTooLargeError(report.bytes.length, MAX_EXPORT_BYTES);
    }

    const body = JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: 'application/json',
          name: report.fileName,
          contentBytes: report.bytes.toString('base64'),
        },
      ],
    });

    let response: { ok: boolean; status: number };
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SyncDeliveryError(deliveryFailureMessage(err));
    }

    if (!response.ok) {
      throw new SyncDeliveryError(`Webhook delivery failed with status ${response.status}`, response.status);
    }
  }
}

/** Convenience wrapper matching `SyncDeps.send` in `run-sync.ts`: POST `report` to `url`. */
export async function sendWebhook(url: string, report: SyncReport, fetchImpl?: typeof fetch): Promise<void> {
  return new WebhookTarget(url, fetchImpl).deliver(report);
}
