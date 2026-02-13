import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { PluginManifestSchema } from './types.js';
import type { PluginManifest, PluginManifestParseResult } from './types.js';

/**
 * Standard plugin manifest file location
 */
const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/**
 * Plugin manifest parser
 *
 * Parses .claude-plugin/plugin.json files with Zod validation.
 * Supports Claude-compatible manifest format with CodeMie extensions.
 */
export class PluginManifestParser {
  /**
   * Check if a directory contains a valid plugin manifest
   *
   * @param pluginDir - Absolute path to plugin directory
   * @returns true if .claude-plugin/plugin.json exists
   */
  static hasManifest(pluginDir: string): boolean {
    const manifestPath = join(pluginDir, PLUGIN_MANIFEST_PATH);
    return existsSync(manifestPath);
  }

  /**
   * Get the manifest file path for a plugin directory
   *
   * @param pluginDir - Absolute path to plugin directory
   * @returns Absolute path to the manifest file
   */
  static getManifestPath(pluginDir: string): string {
    return join(pluginDir, PLUGIN_MANIFEST_PATH);
  }

  /**
   * Parse a plugin manifest from a directory
   *
   * @param pluginDir - Absolute path to plugin directory
   * @returns Parse result with manifest or error
   */
  static async parse(pluginDir: string): Promise<PluginManifestParseResult> {
    const manifestPath = PluginManifestParser.getManifestPath(pluginDir);

    try {
      // Check if manifest exists
      if (!existsSync(manifestPath)) {
        return {
          error: {
            path: manifestPath,
            message: `Plugin manifest not found at ${PLUGIN_MANIFEST_PATH}`,
          },
        };
      }

      // Read manifest file
      const content = await readFile(manifestPath, 'utf-8');

      // Parse JSON
      let rawManifest: unknown;
      try {
        rawManifest = JSON.parse(content);
      } catch (parseError) {
        return {
          error: {
            path: manifestPath,
            message: 'Invalid JSON in plugin manifest',
            cause: parseError,
          },
        };
      }

      // Validate with Zod schema
      const result = PluginManifestSchema.safeParse(rawManifest);

      if (!result.success) {
        const errors = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');

        return {
          error: {
            path: manifestPath,
            message: `Invalid plugin manifest: ${errors}`,
            cause: result.error,
          },
        };
      }

      return { manifest: result.data };
    } catch (error) {
      return {
        error: {
          path: manifestPath,
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        },
      };
    }
  }

  /**
   * Parse a plugin manifest from raw content
   *
   * @param content - JSON string content
   * @param sourcePath - Path for error reporting
   * @returns Parse result with manifest or error
   */
  static parseContent(
    content: string,
    sourcePath: string = 'unknown'
  ): PluginManifestParseResult {
    try {
      // Parse JSON
      let rawManifest: unknown;
      try {
        rawManifest = JSON.parse(content);
      } catch (parseError) {
        return {
          error: {
            path: sourcePath,
            message: 'Invalid JSON in plugin manifest',
            cause: parseError,
          },
        };
      }

      // Validate with Zod schema
      const result = PluginManifestSchema.safeParse(rawManifest);

      if (!result.success) {
        const errors = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');

        return {
          error: {
            path: sourcePath,
            message: `Invalid plugin manifest: ${errors}`,
            cause: result.error,
          },
        };
      }

      return { manifest: result.data };
    } catch (error) {
      return {
        error: {
          path: sourcePath,
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        },
      };
    }
  }

  /**
   * Validate a manifest object
   *
   * @param manifest - Manifest object to validate
   * @returns true if valid, false otherwise
   */
  static isValid(manifest: unknown): manifest is PluginManifest {
    const result = PluginManifestSchema.safeParse(manifest);
    return result.success;
  }

  /**
   * Get validation errors for a manifest
   *
   * @param manifest - Manifest object to validate
   * @returns Array of error messages, empty if valid
   */
  static getValidationErrors(manifest: unknown): string[] {
    const result = PluginManifestSchema.safeParse(manifest);

    if (result.success) {
      return [];
    }

    return result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`);
  }
}
