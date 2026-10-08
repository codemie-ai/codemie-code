/**
 * Platform helpers.
 */

import path from 'path';

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * The `path` implementation whose separator and case rules match `platform`.
 */
export function getPathModule(platform: NodeJS.Platform = process.platform): path.PlatformPath {
  return isWindows(platform) ? path.win32 : path.posix;
}
