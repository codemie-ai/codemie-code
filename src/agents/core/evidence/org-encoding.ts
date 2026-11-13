import { rawProjectHeader } from '@/utils/header-value.js';

/**
 * Transport encoding for an organization the plain `X-CodeMie-Organization` header cannot represent
 * (not Latin-1 printable). The original UTF-8 text is encoded as-is (no trim/casefold/NFC; the backend
 * normalizes after decoding) as canonical unpadded base64url behind a version tag. The plain header is
 * never percent-decoded by the backend, so it is never used for these values.
 */
export const ORG_ENCODING_V1 = 'utf8-b64u.v1';
export const ORG_ENCODED_HEADER = 'X-CodeMie-Organization-Encoded';

const MAX_CODE_POINTS = 256;
const MAX_UTF8_BYTES = 1024;

/** No lone surrogate and no C0 (incl. DEL) / C1 control; lib ES2022 has no String.isWellFormed. */
function plainText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** True when the plain header cannot carry this organization (so the encoded form is the only option). */
export function needsOrganizationEncoding(organization: string): boolean {
  return rawProjectHeader(organization) === undefined;
}

/**
 * `utf8-b64u.v1:<payload>`, or undefined when the value is not encodable under the contract
 * (blank, lone surrogate, control character, > 256 code points or > 1024 UTF-8 bytes).
 */
export function encodeOrganization(organization: string): string | undefined {
  if (!organization.trim() || !plainText(organization)) return undefined;
  if ([...organization].length > MAX_CODE_POINTS) return undefined;
  const bytes = Buffer.from(organization, 'utf-8');
  if (bytes.length > MAX_UTF8_BYTES) return undefined;
  return `${ORG_ENCODING_V1}:${bytes.toString('base64url')}`;
}

/** The organization can be sent to a backend that advertises `encodings`. */
export function organizationSendable(organization: string, encodings: readonly string[] | undefined): boolean {
  if (!needsOrganizationEncoding(organization)) return true;
  return !!encodings?.includes(ORG_ENCODING_V1) && encodeOrganization(organization) !== undefined;
}
