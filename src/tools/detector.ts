/**
 * VCS tools detection utilities
 */

import { execSync } from 'node:child_process';
import type { VCSTool, ToolStatus, ToolsCheckResult } from './types.js';
import { getToolInfo } from './registry.js';

/**
 * Check if a tool is installed
 */
export function isToolInstalled(tool: VCSTool): boolean {
  try {
    const toolInfo = getToolInfo(tool);
    execSync(toolInfo.checkCommand, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get tool version
 */
export function getToolVersion(tool: VCSTool): string | null {
  try {
    const toolInfo = getToolInfo(tool);
    const output = execSync(toolInfo.versionCommand, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    // Extract version number from output
    // gh version 2.40.0 (2024-01-15)
    // glab version 1.36.0 (2024-01-10)
    const match = output.match(/version\s+(\d+\.\d+\.\d+)/i);
    return match ? match[1] : output;
  } catch {
    return null;
  }
}

/**
 * Check if tool is authenticated
 */
export function isToolAuthenticated(tool: VCSTool): boolean {
  try {
    const toolInfo = getToolInfo(tool);
    execSync(toolInfo.authCheckCommand, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get authenticated user for a tool
 */
export function getAuthUser(tool: VCSTool): string | null {
  try {
    const toolInfo = getToolInfo(tool);
    const output = execSync(toolInfo.authCheckCommand, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    // Parse username from auth status output
    if (tool === 'gh') {
      // GitHub: "Logged in to github.com account USERNAME"
      const match = output.match(/account\s+(\S+)/i);
      return match ? match[1] : null;
    } else if (tool === 'glab') {
      // GitLab: "Logged in to gitlab.com as USERNAME" or "Logged in to domain.com as USERNAME"
      const match = output.match(/Logged in to \S+ as (\S+)/i);
      return match ? match[1] : null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect installation method for a tool
 */
export function detectInstallationMethod(tool: VCSTool): 'npm' | 'system' | null {
  if (!isToolInstalled(tool)) {
    return null;
  }

  try {
    // Try to find tool path
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const toolPath = execSync(`${whichCmd} ${tool}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    // Check if installed via npm (usually in node_modules/.bin or npm global)
    if (toolPath.includes('node_modules') || toolPath.includes('npm')) {
      return 'npm';
    }

    return 'system';
  } catch {
    return null;
  }
}

/**
 * Get full status for a tool
 */
export function getToolStatus(tool: VCSTool): ToolStatus {
  const installed = isToolInstalled(tool);

  return {
    tool,
    installed,
    version: installed ? getToolVersion(tool) : null,
    authenticated: installed ? isToolAuthenticated(tool) : false,
    authUser: installed ? getAuthUser(tool) : null,
    installationMethod: installed ? detectInstallationMethod(tool) : null,
  };
}

/**
 * Check status of all tools including git
 */
export function checkAllTools(): ToolsCheckResult {
  // Check git
  let gitInstalled = false;
  let gitVersion: string | null = null;

  try {
    const output = execSync('git --version', {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    gitInstalled = true;
    const match = output.match(/git version (\d+\.\d+\.\d+)/);
    gitVersion = match ? match[1] : output;
  } catch {
    // Git not installed
  }

  return {
    git: {
      installed: gitInstalled,
      version: gitVersion,
    },
    gh: getToolStatus('gh'),
    glab: getToolStatus('glab'),
  };
}
