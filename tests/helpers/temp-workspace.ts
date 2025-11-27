/**
 * Temporary Workspace - Helper for creating isolated test environments
 *
 * Creates temporary directories with helper methods for file operations
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export class TempWorkspace {
  public readonly path: string;

  constructor(prefix: string = 'codemie-test-') {
    this.path = mkdtempSync(join(tmpdir(), prefix));
  }

  /**
   * Write a file to the workspace
   */
  writeFile(relativePath: string, content: string): string {
    const fullPath = join(this.path, relativePath);

    // Create parent directories if needed
    const dir = join(fullPath, '..');
    mkdirSync(dir, { recursive: true });

    writeFileSync(fullPath, content, 'utf-8');
    return fullPath;
  }

  /**
   * Read a file from the workspace
   */
  readFile(relativePath: string): string {
    const fullPath = join(this.path, relativePath);
    return readFileSync(fullPath, 'utf-8');
  }

  /**
   * Write a JSON file to the workspace
   */
  writeJSON(relativePath: string, data: any): string {
    return this.writeFile(relativePath, JSON.stringify(data, null, 2));
  }

  /**
   * Read a JSON file from the workspace
   */
  readJSON(relativePath: string): any {
    return JSON.parse(this.readFile(relativePath));
  }

  /**
   * Write a CodeMie config file
   */
  writeConfig(config: any): string {
    return this.writeJSON('.codemie/config.json', config);
  }

  /**
   * Write a package.json file
   */
  writePackageJSON(data: any): string {
    return this.writeJSON('package.json', data);
  }

  /**
   * Create a git repository structure
   */
  createGitRepo(remoteUrl?: string): void {
    mkdirSync(join(this.path, '.git'), { recursive: true });

    if (remoteUrl) {
      const gitConfig = `[remote "origin"]
\turl = ${remoteUrl}
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
      this.writeFile('.git/config', gitConfig);
    }
  }

  /**
   * Get the full path for a relative path in the workspace
   */
  resolve(relativePath: string): string {
    return join(this.path, relativePath);
  }

  /**
   * Clean up the workspace (remove all files)
   */
  cleanup(): void {
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
      console.warn(`Failed to cleanup workspace: ${this.path}`, error);
    }
  }

  /**
   * Create a directory in the workspace
   */
  mkdir(relativePath: string): string {
    const fullPath = join(this.path, relativePath);
    mkdirSync(fullPath, { recursive: true });
    return fullPath;
  }
}

/**
 * Create a temporary workspace for testing
 */
export function createTempWorkspace(prefix?: string): TempWorkspace {
  return new TempWorkspace(prefix);
}
