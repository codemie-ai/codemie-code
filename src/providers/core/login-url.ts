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

/**
 * Target for `codemie profile login --url`. Stricter than {@link resolveProfileCodeMieUrl}: a codeMieUrl
 * that points at the API itself (e.g. `.../code-assistant-api`, which answers 404 to login) falls back to
 * the API origin. Other paths, such as a UI path, are kept.
 */
export function resolveLoginUrl(baseUrl: string, codeMieUrl?: string): string {
  const resolved = resolveProfileCodeMieUrl(baseUrl, codeMieUrl);
  const trim = (path: string): string => path.replace(/\/+$/, '');
  const apiPath = trim(new URL(baseUrl).pathname);
  const resolvedUrl = new URL(resolved);
  const resolvedPath = trim(resolvedUrl.pathname);
  const pointsAtApi = apiPath !== '' && (resolvedPath === apiPath || resolvedPath.startsWith(`${apiPath}/`));
  return pointsAtApi ? resolvedUrl.origin : resolved;
}
