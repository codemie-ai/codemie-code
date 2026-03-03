/**
 * Plugin Manifest Parser
 *
 * Parses and validates .claude-plugin/plugin.json files.
 * Falls back to deriving plugin name from directory name if no manifest exists.
 */

import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import type { PluginManifest } from './types.js';

/**
 * Manifest file paths to check (in order of priority)
 */
const MANIFEST_PATHS = [
  '.claude-plugin/plugin.json',
  'plugin.json',
];

/**
 * Validate that a plugin name is kebab-case
 */
function isValidPluginName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * Expand ${CLAUDE_PLUGIN_ROOT} placeholders in string values
 */
export function expandPluginRoot(value: string, pluginRoot: string): string {
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

/**
 * Recursively expand ${CLAUDE_PLUGIN_ROOT} in all string values of an object
 */
export function expandPluginRootDeep(obj: unknown, pluginRoot: string): unknown {
  if (typeof obj === 'string') {
    return expandPluginRoot(obj, pluginRoot);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => expandPluginRootDeep(item, pluginRoot));
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandPluginRootDeep(value, pluginRoot);
    }
    return result;
  }
  return obj;
}

/**
 * Parse a plugin manifest from a plugin directory
 *
 * @param pluginDir - Absolute path to the plugin root directory
 * @returns Parsed and validated PluginManifest
 * @throws Error if manifest is invalid (missing required fields)
 */
export async function parseManifest(pluginDir: string): Promise<PluginManifest> {
  // Try to find manifest file
  for (const manifestPath of MANIFEST_PATHS) {
    const fullPath = join(pluginDir, manifestPath);
    if (existsSync(fullPath)) {
      return parseManifestFile(fullPath, pluginDir);
    }
  }

  // No manifest found — derive from directory name
  logger.debug(`[plugin] No manifest found in ${pluginDir}, deriving from directory name`);
  return deriveManifestFromDir(pluginDir);
}

/**
 * Parse a manifest from a specific file path
 */
async function parseManifestFile(filePath: string, pluginDir: string): Promise<PluginManifest> {
  const raw = await readFile(filePath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in plugin manifest ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Plugin manifest must be a JSON object: ${filePath}`);
  }

  // Name is required
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Plugin manifest must have a "name" field (string): ${filePath}`);
  }

  const name = parsed.name as string;
  if (!isValidPluginName(name)) {
    throw new Error(
      `Plugin name must be kebab-case (lowercase alphanumeric with hyphens): "${name}" in ${filePath}`
    );
  }

  // Expand ${CLAUDE_PLUGIN_ROOT} in all string values
  const expanded = expandPluginRootDeep(parsed, pluginDir) as Record<string, unknown>;

  // Validate path fields are relative (if present)
  validateRelativePaths(expanded, filePath);

  return expanded as unknown as PluginManifest;
}

/**
 * Derive a minimal manifest from the directory name
 */
function deriveManifestFromDir(pluginDir: string): PluginManifest {
  const dirName = basename(pluginDir);
  // Convert to kebab-case (replace spaces/underscores with hyphens, lowercase)
  const name = dirName
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!name) {
    throw new Error(`Cannot derive valid plugin name from directory: ${pluginDir}`);
  }

  return { name };
}

/**
 * Validate that path-like fields contain only relative paths
 */
function validateRelativePaths(manifest: Record<string, unknown>, filePath: string): void {
  const pathFields = ['commands', 'agents', 'skills', 'outputStyles'];

  for (const field of pathFields) {
    const value = manifest[field];
    if (!value) continue;

    const paths = Array.isArray(value) ? value : [value];
    for (const p of paths) {
      if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('\\'))) {
        throw new Error(
          `Plugin manifest field "${field}" must use relative paths, got absolute: "${p}" in ${filePath}`
        );
      }
    }
  }
}

/**
 * Check if a directory contains a plugin manifest
 */
export function hasManifest(pluginDir: string): boolean {
  return MANIFEST_PATHS.some(p => existsSync(join(pluginDir, p)));
}
