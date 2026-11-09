const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;

/**
 * Percent-encodes each '/'-separated segment that contains a character outside printable ASCII,
 * so the value is a valid HTTP header value. Segments that are already printable ASCII are sent
 * unchanged, so values that work today stay byte-identical.
 * Not idempotent: an already-encoded non-ASCII input is encoded again ('%' becomes '%25').
 * Lone surrogates become U+FFFD so encoding never throws.
 */
export function encodeAttributionHeader(value: string): string {
  return value
    .replace(LONE_SURROGATE, '�')
    .split('/')
    .map(segment => (NON_PRINTABLE_ASCII.test(segment) ? encodeURIComponent(segment) : segment))
    .join('/');
}

const LATIN1_HEADER_VALUE = /^[\x20-\x7e\xa0-\xff]*$/;

/**
 * The project header is sent raw (the backend does not decode it). Returns the value when it is a
 * valid Latin-1 header value, otherwise undefined so the caller omits the header.
 */
export function rawProjectHeader(project: string): string | undefined {
  return LATIN1_HEADER_VALUE.test(project) ? project : undefined;
}
