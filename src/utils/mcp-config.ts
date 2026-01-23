/**
 * MCP Configuration Detection Utilities
 *
 * Generic utilities for reading MCP (Model Context Protocol) server configurations.
 * Works with any agent's config format based on MCPConfigSource definitions.
 *
 * Security Notes:
 * - ONLY extracts server names (keys from mcpServers object)
 * - NEVER captures URLs, commands, args, env values, or any secrets
 * - All failures return empty/zero values (graceful degradation)
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import type { AgentMCPConfig, MCPConfigSource, MCPConfigSummary } from '../agents/core/types.js';

// Re-export types for convenience
export type { MCPConfigSummary, AgentMCPConfig, MCPConfigSource };

// ============================================================================
// File Reading
// ============================================================================

/**
 * Safely read and parse a JSON configuration file
 *
 * @param filePath - Absolute path to the config file
 * @returns Parsed JSON or null on error
 */
async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.debug(`[mcp-config] Invalid config format at ${filePath}`);
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      logger.debug(`[mcp-config] Failed to read ${filePath}: ${errorCode || error}`);
    }
    return null;
  }
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve config file path
 * Handles ~ expansion and relative paths
 *
 * @param configPath - Path from MCPConfigSource (may start with ~/)
 * @param cwd - Current working directory
 * @returns Absolute path
 */
function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.startsWith('~/')) {
    return path.join(homedir(), configPath.slice(2));
  }
  if (path.isAbsolute(configPath)) {
    return configPath;
  }
  return path.join(cwd, configPath);
}

// ============================================================================
// JSON Path Navigation
// ============================================================================

/**
 * Navigate to a value in a nested object using a dot-separated path
 * Supports {cwd} placeholder replacement
 *
 * @param obj - Object to navigate
 * @param jsonPath - Dot-separated path (e.g., 'projects.{cwd}.mcpServers')
 * @param cwd - Current working directory (for {cwd} replacement)
 * @returns Value at path or undefined
 *
 * @example
 * navigateJsonPath({ projects: { '/path': { mcpServers: {...} } } }, 'projects.{cwd}.mcpServers', '/path')
 * // Returns the mcpServers object
 */
function navigateJsonPath(
  obj: Record<string, unknown>,
  jsonPath: string,
  cwd: string
): Record<string, unknown> | undefined {
  // Replace {cwd} with actual path
  const resolvedPath = jsonPath.replace('{cwd}', cwd);
  const parts = resolvedPath.split('.');

  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }

  return undefined;
}

// ============================================================================
// Server Name Extraction
// ============================================================================

/**
 * Extract server names from mcpServers object
 * Security: Only extracts keys (server names), never values
 *
 * @param mcpServers - MCP servers object or undefined
 * @returns Array of server names
 */
function extractServerNames(mcpServers: Record<string, unknown> | undefined): string[] {
  if (!mcpServers || typeof mcpServers !== 'object') {
    return [];
  }
  return Object.keys(mcpServers);
}

// ============================================================================
// MCP Detection
// ============================================================================

/**
 * Read MCP servers from a single config source
 *
 * @param source - MCP config source definition
 * @param cwd - Current working directory
 * @returns Array of server names
 */
async function readMCPFromSource(
  source: MCPConfigSource | undefined,
  cwd: string
): Promise<string[]> {
  if (!source) {
    return [];
  }

  const filePath = resolveConfigPath(source.path, cwd);
  const config = await readJsonFile(filePath);

  if (!config) {
    return [];
  }

  const mcpServers = navigateJsonPath(config, source.jsonPath, cwd);
  return extractServerNames(mcpServers);
}

/**
 * Get MCP configuration summary for an agent
 *
 * Main entry point for metrics integration.
 * Reads all configured scopes and returns counts and server names.
 *
 * @param mcpConfig - Agent's MCP configuration (from metadata)
 * @param cwd - Current working directory
 * @returns MCPConfigSummary with counts and server names
 */
export async function getMCPConfigSummary(
  mcpConfig: AgentMCPConfig | undefined,
  cwd: string
): Promise<MCPConfigSummary> {
  // Return empty summary if no MCP config defined
  if (!mcpConfig) {
    return {
      totalServers: 0,
      localServers: 0,
      projectServers: 0,
      userServers: 0,
      serverNames: [],
      localServerNames: [],
      projectServerNames: [],
      userServerNames: []
    };
  }

  try {
    // Read all scopes in parallel
    const [local, project, user] = await Promise.all([
      readMCPFromSource(mcpConfig.local, cwd),
      readMCPFromSource(mcpConfig.project, cwd),
      readMCPFromSource(mcpConfig.user, cwd)
    ]);

    // Calculate counts
    const localServers = local.length;
    const projectServers = project.length;
    const userServers = user.length;
    const totalServers = localServers + projectServers + userServers;

    // Combine all server names (unique)
    const allNames = new Set([...local, ...project, ...user]);
    const serverNames = Array.from(allNames).sort();

    return {
      totalServers,
      localServers,
      projectServers,
      userServers,
      serverNames,
      localServerNames: local.sort(),
      projectServerNames: project.sort(),
      userServerNames: user.sort()
    };
  } catch (error) {
    logger.debug('[mcp-config] Unexpected error in getMCPConfigSummary:', error);
    return {
      totalServers: 0,
      localServers: 0,
      projectServers: 0,
      userServers: 0,
      serverNames: [],
      localServerNames: [],
      projectServerNames: [],
      userServerNames: []
    };
  }
}
