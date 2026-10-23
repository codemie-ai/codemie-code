const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Percent-encodes each '/'-separated segment so the value is a valid HTTP header value.
 * Not idempotent: an already-encoded input is encoded again ('%' becomes '%25').
 * Lone surrogates become U+FFFD so encoding never throws.
 */
export function encodeAttributionHeader(value: string): string {
  return value
    .replace(LONE_SURROGATE, '\uFFFD')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}
