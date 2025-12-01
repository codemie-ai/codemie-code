/**
 * Project Path Mapping Utilities
 *
 * Manages the mapping between project hashes and actual file paths.
 * Each agent (Gemini, Claude, etc.) stores their mappings in separate files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Project mapping entry
 */
export interface ProjectMapping {
  hash: string;
  path: string;
  lastUpdated: string;
}

/**
 * Project mapping file structure
 */
export interface ProjectMappingFile {
  version: string;
  mappings: Record<string, ProjectMapping>;
}

/**
 * Get the path to the project mapping file for a specific agent
 */
function getMappingFilePath(agent: string): string {
  const codemieDir = join(homedir(), '.codemie');
  return join(codemieDir, `${agent}-project-mappings.json`);
}

/**
 * Ensure the .codemie directory exists
 */
function ensureCodemieDir(): void {
  const codemieDir = join(homedir(), '.codemie');
  if (!existsSync(codemieDir)) {
    mkdirSync(codemieDir, { recursive: true });
  }
}

/**
 * Load project mappings for an agent
 */
export function loadProjectMappings(agent: string): ProjectMappingFile {
  const filePath = getMappingFilePath(agent);

  if (!existsSync(filePath)) {
    return {
      version: '1.0.0',
      mappings: {}
    };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load project mappings for ${agent}:`, error);
    return {
      version: '1.0.0',
      mappings: {}
    };
  }
}

/**
 * Save project mappings for an agent
 */
export function saveProjectMappings(agent: string, mappings: ProjectMappingFile): void {
  ensureCodemieDir();
  const filePath = getMappingFilePath(agent);

  try {
    writeFileSync(filePath, JSON.stringify(mappings, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save project mappings for ${agent}:`, error);
  }
}

/**
 * Add or update a project mapping
 */
export function setProjectMapping(agent: string, hash: string, path: string): void {
  const mappings = loadProjectMappings(agent);

  mappings.mappings[hash] = {
    hash,
    path,
    lastUpdated: new Date().toISOString()
  };

  saveProjectMappings(agent, mappings);
}

/**
 * Get the project path for a hash
 */
export function getProjectPath(agent: string, hash: string): string | undefined {
  const mappings = loadProjectMappings(agent);
  return mappings.mappings[hash]?.path;
}

/**
 * Resolve project path from hash, returning hash if not found
 */
export function resolveProjectPath(agent: string, hash: string): string {
  const path = getProjectPath(agent, hash);
  return path || hash;
}

/**
 * Generate SHA-256 hash of a path
 */
export function hashProjectPath(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

/**
 * Register current working directory (helper for agent lifecycle hooks)
 */
export function registerCurrentProject(agent: string, workingDir: string): void {
  const hash = hashProjectPath(workingDir);
  setProjectMapping(agent, hash, workingDir);
}
