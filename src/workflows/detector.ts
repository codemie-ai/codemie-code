/**
 * VCS provider detection utilities
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { VCSProvider, VCSDetectionResult } from './types.js';

/**
 * Detect VCS provider from git remote URL
 */
export function detectVCSProvider(cwd: string = process.cwd()): VCSDetectionResult {
  const result: VCSDetectionResult = {
    provider: null,
    remoteUrl: null,
    isGitRepo: false,
    workflowDir: null,
  };

  try {
    // Check if this is a git repository
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    result.isGitRepo = true;
  } catch {
    return result;
  }

  try {
    // Get remote URL
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    result.remoteUrl = remoteUrl;

    // Detect provider from URL
    if (remoteUrl.includes('github.com')) {
      result.provider = 'github';
      result.workflowDir = path.join(cwd, '.github', 'workflows');
    } else if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) {
      result.provider = 'gitlab';
      result.workflowDir = path.join(cwd, '.gitlab');
    }
  } catch {
    // No remote configured
  }

  return result;
}

/**
 * Get workflow directory for a specific provider
 */
export function getWorkflowDir(provider: VCSProvider, cwd: string = process.cwd()): string {
  if (provider === 'github') {
    return path.join(cwd, '.github', 'workflows');
  }
  return path.join(cwd, '.gitlab');
}

/**
 * Check if workflow directory exists
 */
export function workflowDirExists(provider: VCSProvider, cwd: string = process.cwd()): boolean {
  const dir = getWorkflowDir(provider, cwd);
  return fs.existsSync(dir);
}

/**
 * Create workflow directory if it doesn't exist
 */
export function ensureWorkflowDir(provider: VCSProvider, cwd: string = process.cwd()): string {
  const dir = getWorkflowDir(provider, cwd);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return dir;
}

/**
 * List installed workflows
 */
export function listInstalledWorkflows(provider: VCSProvider, cwd: string = process.cwd()): string[] {
  const dir = getWorkflowDir(provider, cwd);

  if (!fs.existsSync(dir)) {
    return [];
  }

  if (provider === 'github') {
    // List .yml and .yaml files in .github/workflows
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
      .map(file => path.join(dir, file));
  } else {
    // GitLab uses .gitlab-ci.yml
    const ciFile = path.join(dir, '.gitlab-ci.yml');
    return fs.existsSync(ciFile) ? [ciFile] : [];
  }
}

/**
 * Check if a specific workflow is installed
 */
export function isWorkflowInstalled(
  workflowId: string,
  provider: VCSProvider,
  cwd: string = process.cwd()
): boolean {
  const dir = getWorkflowDir(provider, cwd);

  if (provider === 'github') {
    const possibleFiles = [
      path.join(dir, `codemie-${workflowId}.yml`),
      path.join(dir, `codemie-${workflowId}.yaml`),
    ];
    return possibleFiles.some(file => fs.existsSync(file));
  } else {
    // For GitLab, check if the workflow is in .gitlab-ci.yml
    const ciFile = path.join(dir, '.gitlab-ci.yml');
    if (!fs.existsSync(ciFile)) {
      return false;
    }
    const content = fs.readFileSync(ciFile, 'utf-8');
    // Check if workflow ID appears in the CI file
    return content.includes(`codemie-${workflowId}`);
  }
}

/**
 * Get git repository information
 */
export function getGitRepoInfo(cwd: string = process.cwd()): {
  owner: string | null;
  repo: string | null;
  url: string | null;
} {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    // Parse owner and repo from URL
    // Support both HTTPS and SSH formats
    // HTTPS: https://github.com/owner/repo.git
    // SSH: git@github.com:owner/repo.git
    let match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) {
      match = remoteUrl.match(/gitlab\.com[:/]([^/]+)\/([^/.]+)/);
    }

    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        url: remoteUrl,
      };
    }

    return {
      owner: null,
      repo: null,
      url: remoteUrl,
    };
  } catch {
    return {
      owner: null,
      repo: null,
      url: null,
    };
  }
}
