import open from 'open';

/**
 * Open a URL in the user's default browser.
 *
 * The `open` package handles macOS, Windows, and Linux platform differences.
 */
export async function openUrlInBrowser(url: string): Promise<void> {
  await open(url, { wait: false });
}
