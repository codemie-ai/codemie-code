/**
 * Webhook delivery target for `codemie analytics sync`.
 *
 * POSTs each file of the analytics export as a single JSON attachment, one request per file in
 * order, to a configured HTTPS webhook URL (no per-target grouping, no retry); a file that fails
 * does not stop the ones after it, and after the last file the delivery throws the first error it
 * met, each later one logged at debug level. Any 2xx response resolves; a file above {@link MAX_EXPORT_BYTES} throws
 * `ExportTooLargeError` before its network call; a POST that takes longer than {@link WEBHOOK_TIMEOUT_MS} is aborted;
 * a redirect response or a non-2xx response or a `fetchImpl`
 * rejection becomes a `SyncDeliveryError` with a redacted message (the signed URL query
 * parameter must never leak into it).
 *
 * `sendWebhook` is what `run-sync.ts`'s `deliverToTarget` calls with the run's files;
 * `WebhookTarget` is its implementation, constructed fresh per call since the URL can change
 * between settings reads.
 */

import { ExportTooLargeError, SyncDeliveryError } from '../../../../../utils/errors.js';
import { logger } from '../../../../../utils/logger.js';
import { errorMessage } from '../redact.js';
import type { SyncReport } from '../types.js';

export const MAX_EXPORT_BYTES = 70_000_000;

/** Upper bound on one POST, so a webhook that accepts the connection but never answers cannot
 * keep the daily job (systemd oneshot / launchd, both without their own limit) running. */
export const WEBHOOK_TIMEOUT_MS = 5 * 60_000;

function deliveryFailureMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `Webhook did not respond within ${timeoutMs / 60_000} minutes`;
  }
  return errorMessage(err);
}

const defaultFetch: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

/** POSTs an analytics export's files to one webhook URL, one request per file. */
export class WebhookTarget {
  readonly id = 'webhook';

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly timeoutMs: number = WEBHOOK_TIMEOUT_MS
  ) {}

  /** Posts every one of `reports` in order; throws the first error met once the last file was attempted. */
  async deliver(reports: SyncReport[]): Promise<void> {
    let first: unknown;
    let failed = false;
    for (const report of reports) {
      try {
        await this.post(report);
      } catch (err) {
        if (failed) {
          logger.debug(`[sync:webhook] ${report.fileName} not delivered: ${errorMessage(err)}`);
        } else {
          first = err;
          failed = true;
        }
      }
    }
    if (failed) throw first;
  }

  private async post(report: SyncReport): Promise<void> {
    if (report.bytes.length > MAX_EXPORT_BYTES) {
      throw new ExportTooLargeError(report.bytes.length, MAX_EXPORT_BYTES);
    }

    const body = JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: report.contentType,
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SyncDeliveryError(deliveryFailureMessage(err, this.timeoutMs));
    }

    if (!response.ok) {
      throw new SyncDeliveryError(`Webhook delivery failed with status ${response.status}`, response.status);
    }
  }
}

/** Convenience wrapper matching `SyncDeps.send` in `run-sync.ts`: POST `reports` to `url`. `timeoutMs`
 * defaults to {@link WEBHOOK_TIMEOUT_MS}; the bootstrap wizard's interactive test-send (Task 7)
 * passes a shorter one so a hung flow does not block the terminal for the full 5 minutes. */
export async function sendWebhook(
  url: string,
  reports: SyncReport[],
  fetchImpl?: typeof fetch,
  timeoutMs?: number
): Promise<void> {
  return new WebhookTarget(url, fetchImpl, timeoutMs).deliver(reports);
}
