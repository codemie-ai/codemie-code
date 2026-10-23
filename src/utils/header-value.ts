// The backend decodes these headers with decodeURIComponent; '/' stays unescaped so values remain readable.
export function encodeAttributionHeader(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}
