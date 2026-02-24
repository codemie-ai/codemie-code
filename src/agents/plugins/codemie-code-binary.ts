import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

/**
 * Platform-specific package name mapping for @codemieai/codemie-opencode.
 * The wrapper package lists these as optionalDependencies; npm only downloads
 * the one matching the current platform.
 */
export function getPlatformPackage(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  const platformMap: Record<string, Record<string, string>> = {
    darwin: {
      x64: '@codemieai/codemie-opencode-darwin-x64',
      arm64: '@codemieai/codemie-opencode-darwin-arm64',
    },
    linux: {
      x64: '@codemieai/codemie-opencode-linux-x64',
      arm64: '@codemieai/codemie-opencode-linux-arm64',
    },
    win32: {
      x64: '@codemieai/codemie-opencode-windows-x64',
      arm64: '@codemieai/codemie-opencode-windows-arm64',
    },
  };

  return platformMap[platform]?.[arch] ?? null;
}

/**
 * Walk up from a starting directory looking for a node_modules directory
 * that contains the given package.
 */
function findPackageInNodeModules(startDir: string, packageName: string): string | null {
  let current = startDir;

  while (true) {
    const candidate = join(current, 'node_modules', packageName);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  return null;
}

/**
 * Resolve the bundled @codemieai/codemie-opencode binary from node_modules.
 *
 * Resolution order:
 * 1. CODEMIE_OPENCODE_WL_BIN env var override (escape hatch)
 * 2. Platform-specific binary from node_modules/@codemieai/codemie-opencode-{platform}-{arch}/bin/codemie
 * 3. Wrapper package binary from node_modules/@codemieai/codemie-opencode/bin/codemie
 * 4. Fallback: null (binary not found)
 */
export function resolveCodemieOpenCodeBinary(): string | null {
  // 1. Environment variable override
  const envBin = process.env.CODEMIE_OPENCODE_WL_BIN;
  if (envBin) {
    if (existsSync(envBin)) {
      logger.debug(`[codemie-code] Using binary from CODEMIE_OPENCODE_WL_BIN: ${envBin}`);
      return envBin;
    }
    logger.warn(`[codemie-code] CODEMIE_OPENCODE_WL_BIN set but binary not found: ${envBin}`);
  }

  // Start searching from this module's directory
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === 'win32' ? 'codemie.exe' : 'codemie';

  // 2. Try platform-specific package first (direct binary, no wrapper)
  const platformPkg = getPlatformPackage();
  if (platformPkg) {
    const platformDir = findPackageInNodeModules(moduleDir, platformPkg);
    if (platformDir) {
      const platformBin = join(platformDir, 'bin', binName);
      if (existsSync(platformBin)) {
        logger.debug(`[codemie-code] Resolved platform binary: ${platformBin}`);
        return platformBin;
      }
    }
  }

  // 3. Fall back to wrapper package binary
  const wrapperDir = findPackageInNodeModules(moduleDir, '@codemieai/codemie-opencode');
  if (wrapperDir) {
    const wrapperBin = join(wrapperDir, 'bin', binName);
    if (existsSync(wrapperBin)) {
      logger.debug(`[codemie-code] Resolved wrapper binary: ${wrapperBin}`);
      return wrapperBin;
    }
  }

  // 4. Not found
  logger.debug('[codemie-code] Binary not found in node_modules');
  return null;
}
