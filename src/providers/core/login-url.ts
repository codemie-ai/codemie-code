/**
 * Platform URL to pass to `codemie profile login --url` for a profile. The API base URL (a path
 * under the host) is not a login target, so a codeMieUrl is used only when it shares the API's origin.
 */
export function resolveProfileCodeMieUrl(baseUrl: string, codeMieUrl?: string): string {
  const profileOrigin = new URL(baseUrl).origin;
  if (codeMieUrl && new URL(codeMieUrl).origin === profileOrigin) {
    return codeMieUrl;
  }
  return profileOrigin;
}
