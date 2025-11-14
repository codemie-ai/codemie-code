/**
 * VCS tools registry
 */

import type { ToolInfo, VCSTool } from './types.js';

export const TOOLS: Record<VCSTool, ToolInfo> = {
  gh: {
    name: 'gh',
    displayName: 'GitHub CLI',
    packageName: 'gh',
    description: 'GitHub official command-line tool',
    npmPackage: '@github/gh',
    checkCommand: 'gh --version',
    versionCommand: 'gh --version',
    authCheckCommand: 'gh auth status',
    authCommand: 'gh auth login',
    docsUrl: 'https://cli.github.com/',
  },
  glab: {
    name: 'glab',
    displayName: 'GitLab CLI',
    packageName: 'glab',
    description: 'GitLab official command-line tool',
    npmPackage: 'glab-cli',
    checkCommand: 'glab --version',
    versionCommand: 'glab --version',
    authCheckCommand: 'glab auth status',
    authCommand: 'glab auth login',
    docsUrl: 'https://gitlab.com/gitlab-org/cli',
  },
};

export function getToolInfo(tool: VCSTool): ToolInfo {
  return TOOLS[tool];
}

export function getAllTools(): ToolInfo[] {
  return Object.values(TOOLS);
}
