/**
 * VCS tools installation and management
 */

import { execSync } from 'node:child_process';
import type { VCSTool, ToolInstallOptions } from './types.js';
import { getToolInfo } from './registry.js';
import { isToolInstalled } from './detector.js';

/**
 * Install a tool via npm
 */
export async function installTool(tool: VCSTool, options: ToolInstallOptions = {}): Promise<void> {
  const toolInfo = getToolInfo(tool);
  const { global = true, force = false } = options;

  // Check if already installed
  if (isToolInstalled(tool) && !force) {
    throw new Error(`${toolInfo.displayName} is already installed. Use --force to reinstall.`);
  }

  try {
    const globalFlag = global ? '-g' : '';
    const forceFlag = force ? '--force' : '';

    console.log(`Installing ${toolInfo.displayName} via npm...`);

    // Install via npm
    execSync(`npm install ${globalFlag} ${forceFlag} ${toolInfo.npmPackage}`, {
      stdio: 'inherit',
    });

    console.log(`✅ ${toolInfo.displayName} installed successfully`);
  } catch (error) {
    throw new Error(
      `Failed to install ${toolInfo.displayName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Uninstall a tool
 */
export async function uninstallTool(tool: VCSTool): Promise<void> {
  const toolInfo = getToolInfo(tool);

  if (!isToolInstalled(tool)) {
    throw new Error(`${toolInfo.displayName} is not installed`);
  }

  try {
    console.log(`Uninstalling ${toolInfo.displayName}...`);

    execSync(`npm uninstall -g ${toolInfo.npmPackage}`, {
      stdio: 'inherit',
    });

    console.log(`✅ ${toolInfo.displayName} uninstalled successfully`);
  } catch (error) {
    throw new Error(
      `Failed to uninstall ${toolInfo.displayName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update a tool
 */
export async function updateTool(tool: VCSTool): Promise<void> {
  const toolInfo = getToolInfo(tool);

  if (!isToolInstalled(tool)) {
    throw new Error(`${toolInfo.displayName} is not installed. Install it first with: codemie tools install ${tool}`);
  }

  try {
    console.log(`Updating ${toolInfo.displayName}...`);

    execSync(`npm update -g ${toolInfo.npmPackage}`, {
      stdio: 'inherit',
    });

    console.log(`✅ ${toolInfo.displayName} updated successfully`);
  } catch (error) {
    throw new Error(
      `Failed to update ${toolInfo.displayName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Authenticate a tool
 */
export async function authenticateTool(tool: VCSTool, token?: string): Promise<void> {
  const toolInfo = getToolInfo(tool);

  if (!isToolInstalled(tool)) {
    throw new Error(`${toolInfo.displayName} is not installed. Install it first with: codemie tools install ${tool}`);
  }

  try {
    console.log(`Authenticating ${toolInfo.displayName}...`);

    if (token) {
      // Authenticate with token
      if (tool === 'gh') {
        execSync(`echo ${token} | gh auth login --with-token`, {
          stdio: 'inherit',
        });
      } else if (tool === 'glab') {
        execSync(`glab auth login --token ${token}`, {
          stdio: 'inherit',
        });
      }
    } else {
      // Interactive authentication
      execSync(toolInfo.authCommand, {
        stdio: 'inherit',
      });
    }

    console.log(`✅ ${toolInfo.displayName} authenticated successfully`);
  } catch (error) {
    throw new Error(
      `Failed to authenticate ${toolInfo.displayName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
