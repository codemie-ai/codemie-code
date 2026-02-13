import { mkdir, writeFile, rm, rename, readdir, copyFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { existsSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getCodemiePath } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { exec } from '../../utils/processes.js';
import { PluginDiscovery } from '../core/PluginDiscovery.js';
import { PluginManifestParser } from '../core/PluginManifestParser.js';
import { validatePluginName } from '../core/types.js';
import { MarketplaceClient } from './MarketplaceClient.js';
import { MarketplaceRegistry } from './MarketplaceRegistry.js';
import type {
  PluginInstallOptions,
  PluginInstallResult,
  PluginUpdateInfo,
  PluginDownloadInfo,
} from './types.js';
import type { InstalledPluginMeta } from '../core/types.js';

/**
 * Temporary directory for downloads
 */
const TEMP_DIR = 'tmp';

/**
 * Installed plugin metadata filename
 */
const INSTALLED_META_FILE = 'plugin.installed.json';

/**
 * Plugin installer
 *
 * Downloads and installs plugins from GitHub-based marketplaces.
 * Handles extraction, validation, and metadata tracking.
 */
export class PluginInstaller {
  private client: MarketplaceClient;
  private registry: MarketplaceRegistry;

  constructor() {
    this.client = new MarketplaceClient();
    this.registry = MarketplaceRegistry.getInstance();
  }

  /**
   * Install a plugin from the marketplace
   *
   * @param pluginName - Name of the plugin to install
   * @param options - Installation options
   * @returns Installation result
   */
  async install(
    pluginName: string,
    options: PluginInstallOptions = {}
  ): Promise<PluginInstallResult> {
    const { force = false, sourceId } = options;

    try {
      validatePluginName(pluginName);

      // Get marketplace source
      const source = sourceId
        ? await this.registry.getSource(sourceId)
        : await this.registry.getDefaultSource();

      if (!source) {
        return {
          success: false,
          pluginName,
          version: '',
          installedPath: '',
          message: `Marketplace source '${sourceId}' not found`,
        };
      }

      // Get plugin download info
      const downloadInfo = await this.client.getPluginDownloadInfo(source, pluginName);

      if (!downloadInfo) {
        return {
          success: false,
          pluginName,
          version: '',
          installedPath: '',
          message: `Plugin '${pluginName}' not found in marketplace '${source.name}'`,
        };
      }

      // Check if already installed
      const pluginDir = PluginDiscovery.getPluginDir(pluginName);
      if (existsSync(pluginDir) && !force) {
        return {
          success: false,
          pluginName,
          version: downloadInfo.version,
          installedPath: pluginDir,
          message: `Plugin '${pluginName}' is already installed. Use --force to reinstall.`,
        };
      }

      // Download and extract
      await this.downloadAndExtract(downloadInfo, pluginDir);

      // Write installation metadata
      const installedMeta: InstalledPluginMeta = {
        name: pluginName,
        version: downloadInfo.version,
        source: 'marketplace',
        marketplaceId: source.id,
        repositoryUrl: `https://github.com/${downloadInfo.repository}`,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        commitHash: downloadInfo.commitHash,
      };

      await writeFile(
        join(pluginDir, INSTALLED_META_FILE),
        JSON.stringify(installedMeta, null, 2),
        'utf-8'
      );

      return {
        success: true,
        pluginName,
        version: downloadInfo.version,
        installedPath: pluginDir,
        message: `Successfully installed plugin '${pluginName}' v${downloadInfo.version}`,
      };
    } catch (error) {
      return {
        success: false,
        pluginName,
        version: '',
        installedPath: '',
        message: `Failed to install plugin '${pluginName}': ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Install a plugin from a local directory
   *
   * @param sourcePath - Path to the plugin directory
   * @returns Installation result
   */
  async installFromLocal(sourcePath: string): Promise<PluginInstallResult> {
    try {
      // Verify it's a valid plugin
      if (!PluginManifestParser.hasManifest(sourcePath)) {
        return {
          success: false,
          pluginName: basename(sourcePath),
          version: '',
          installedPath: '',
          message: `Directory '${sourcePath}' is not a valid plugin (missing .claude-plugin/plugin.json)`,
        };
      }

      // Parse manifest to get plugin name
      const parseResult = await PluginManifestParser.parse(sourcePath);
      if (!parseResult.manifest) {
        return {
          success: false,
          pluginName: basename(sourcePath),
          version: '',
          installedPath: '',
          message: `Invalid plugin manifest: ${parseResult.error?.message}`,
        };
      }

      const pluginName = parseResult.manifest.name;
      validatePluginName(pluginName);
      const pluginDir = PluginDiscovery.getPluginDir(pluginName);

      // Copy to plugins directory
      await this.copyDirectory(sourcePath, pluginDir);

      // Write installation metadata
      const installedMeta: InstalledPluginMeta = {
        name: pluginName,
        version: parseResult.manifest.version,
        source: 'local',
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await writeFile(
        join(pluginDir, INSTALLED_META_FILE),
        JSON.stringify(installedMeta, null, 2),
        'utf-8'
      );

      return {
        success: true,
        pluginName,
        version: parseResult.manifest.version,
        installedPath: pluginDir,
        message: `Successfully installed plugin '${pluginName}' v${parseResult.manifest.version} from local directory`,
      };
    } catch (error) {
      return {
        success: false,
        pluginName: basename(sourcePath),
        version: '',
        installedPath: '',
        message: `Failed to install from local directory: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Uninstall a plugin
   *
   * @param pluginName - Name of the plugin to uninstall
   * @returns Success status
   */
  async uninstall(pluginName: string): Promise<PluginInstallResult> {
    try {
      validatePluginName(pluginName);
    } catch (error) {
      return {
        success: false,
        pluginName,
        version: '',
        installedPath: '',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const pluginDir = PluginDiscovery.getPluginDir(pluginName);

    if (!existsSync(pluginDir)) {
      return {
        success: false,
        pluginName,
        version: '',
        installedPath: pluginDir,
        message: `Plugin '${pluginName}' is not installed`,
      };
    }

    try {
      // Get version before removing
      const parseResult = await PluginManifestParser.parse(pluginDir);
      const version = parseResult.manifest?.version || 'unknown';

      // Remove plugin directory
      await rm(pluginDir, { recursive: true, force: true });

      return {
        success: true,
        pluginName,
        version,
        installedPath: pluginDir,
        message: `Successfully uninstalled plugin '${pluginName}'`,
      };
    } catch (error) {
      return {
        success: false,
        pluginName,
        version: '',
        installedPath: pluginDir,
        message: `Failed to uninstall plugin '${pluginName}': ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Update a plugin to the latest version
   *
   * @param pluginName - Name of the plugin to update
   * @returns Update result
   */
  async update(pluginName: string): Promise<PluginInstallResult> {
    // Force reinstall
    return this.install(pluginName, { force: true });
  }

  /**
   * Check for plugin updates
   *
   * @param pluginName - Plugin name (or all if not specified)
   * @returns Update information
   */
  async checkForUpdates(pluginName?: string): Promise<PluginUpdateInfo[]> {
    const updates: PluginUpdateInfo[] = [];
    const discovery = new PluginDiscovery();

    // Get installed plugins
    const plugins = await discovery.discoverPlugins({
      pluginName,
      forceReload: true,
    });

    for (const plugin of plugins) {
      if (!plugin.installedMeta || plugin.isDevelopment) {
        continue;
      }

      try {
        // Get marketplace source
        const sourceId = plugin.installedMeta.marketplaceId;
        const source = sourceId
          ? await this.registry.getSource(sourceId)
          : await this.registry.getDefaultSource();

        if (!source) continue;

        // Get latest version from marketplace
        const marketplacePlugin = await this.client.getPlugin(source, plugin.name);

        if (marketplacePlugin) {
          updates.push({
            pluginName: plugin.name,
            currentVersion: plugin.manifest.version,
            latestVersion: marketplacePlugin.version,
            // Simple string comparison — sufficient for detecting changes without adding a semver dependency
            hasUpdate: marketplacePlugin.version !== plugin.manifest.version,
          });
        }
      } catch (error) {
        logger.debug(`Failed to check updates for ${plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return updates;
  }

  /**
   * Download and extract a plugin
   */
  private async downloadAndExtract(
    downloadInfo: PluginDownloadInfo,
    targetDir: string
  ): Promise<void> {
    const tempDir = getCodemiePath(TEMP_DIR);
    const tempFile = join(tempDir, `${downloadInfo.name}-${Date.now()}.zip`);

    try {
      // Create temp directory
      await mkdir(tempDir, { recursive: true });

      // Download the archive
      const response = await fetch(downloadInfo.downloadUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      // Save to temp file
      const fileStream = createWriteStream(tempFile);
      if (!response.body) {
        throw new Error('Download response has no body');
      }
      // Convert Web ReadableStream to Node.js Readable
      const nodeReadable = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
      await pipeline(nodeReadable, fileStream);

      // Extract the archive
      await this.extractZip(tempFile, targetDir, downloadInfo.path);
    } finally {
      // Cleanup temp file
      try {
        await rm(tempFile, { force: true });
      } catch (error) {
        logger.debug(`Failed to clean up temp file ${tempFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Extract a ZIP archive
   *
   * Note: Using a simple approach with decompress package would be better,
   * but for now we use unzip command as a simple solution
   */
  private async extractZip(
    zipPath: string,
    targetDir: string,
    subPath: string
  ): Promise<void> {
    const tempExtractDir = join(dirname(zipPath), `extract-${Date.now()}`);

    try {
      // Create temp extract directory
      await mkdir(tempExtractDir, { recursive: true });

      // Extract using unzip command (available on most systems)
      await exec('unzip', ['-q', '-o', zipPath, '-d', tempExtractDir]);

      // Find the extracted content (usually in a subdirectory like repo-branch/)
      const entries = await readdir(tempExtractDir);
      if (entries.length === 0) {
        throw new Error('Archive is empty');
      }

      // Get the root directory of extracted content
      const extractedRoot = join(tempExtractDir, entries[0]);

      // Determine source path (could be a subdirectory within the archive)
      let sourcePath = extractedRoot;
      if (subPath) {
        sourcePath = join(extractedRoot, subPath);
        if (!existsSync(sourcePath)) {
          throw new Error(`Plugin path '${subPath}' not found in archive`);
        }
      }

      // Remove existing target if any
      if (existsSync(targetDir)) {
        await rm(targetDir, { recursive: true, force: true });
      }

      // Create target parent directory
      await mkdir(dirname(targetDir), { recursive: true });

      // Move to target
      await rename(sourcePath, targetDir);
    } finally {
      // Cleanup temp extract directory
      try {
        await rm(tempExtractDir, { recursive: true, force: true });
      } catch (error) {
        logger.debug(`Failed to clean up temp extract dir ${tempExtractDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Copy a directory recursively
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    // Remove existing target
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }

    // Create target directory
    await mkdir(target, { recursive: true });

    // Copy all files
    const entries = await readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(source, entry.name);
      const destPath = join(target, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Get the temp directory path
   */
  static getTempDir(): string {
    return getCodemiePath(TEMP_DIR);
  }
}
