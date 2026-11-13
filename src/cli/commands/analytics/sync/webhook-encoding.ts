/**
 * Shell-neutral transport for the webhook URL in the install command that `bootstrap` prints.
 *
 * A Power Automate trigger URL carries `&`, `?` and `%XX` runs. No single quoting survives
 * every shell a developer may paste into: PowerShell splits at `&` when the `codemie` it
 * resolves is a `.cmd` file, and cmd.exe expands `%name%` runs (and re-expands them through
 * a `call … %*` wrapper) even inside double quotes. base64url uses only `A-Z a-z 0-9 - _`,
 * which no shell treats specially, so `--webhook-b64 <value>` reaches `install` byte-for-byte.
 */

import { SyncConfigError } from '@/utils/errors.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVALID_MESSAGE =
  '--webhook-b64 is not a valid encoded webhook: copy the whole value from the command your team lead shared.';

/** Encodes `url` as unpadded base64url. */
export function encodeWebhook(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64url');
}

/**
 * Decodes a `--webhook-b64` value back to the URL. Throws `SyncConfigError` naming the flag
 * when the value is empty, uses characters outside the base64url alphabet, or does not
 * round-trip (a truncated or mistyped value). The decoded URL itself is validated by the
 * caller, as for `--webhook`.
 */
export function decodeWebhook(value: string): string {
  const trimmed = value.trim();
  if (!BASE64URL_PATTERN.test(trimmed)) {
    throw new SyncConfigError(INVALID_MESSAGE);
  }
  const decoded = Buffer.from(trimmed, 'base64url').toString('utf-8');
  if (encodeWebhook(decoded) !== trimmed) {
    throw new SyncConfigError(INVALID_MESSAGE);
  }
  return decoded;
}
