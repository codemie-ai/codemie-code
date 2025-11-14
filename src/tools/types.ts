/**
 * VCS Tools management types
 */

export type VCSTool = 'gh' | 'glab';

export interface ToolInfo {
  name: VCSTool;
  displayName: string;
  packageName: string;
  description: string;
  npmPackage: string;
  checkCommand: string;
  versionCommand: string;
  authCheckCommand: string;
  authCommand: string;
  docsUrl: string;
}

export interface ToolStatus {
  tool: VCSTool;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authUser: string | null;
  installationMethod: 'npm' | 'system' | null;
}

export interface ToolInstallOptions {
  global?: boolean;
  force?: boolean;
}

export interface ToolAuthOptions {
  token?: string;
  interactive?: boolean;
}

export interface ToolsCheckResult {
  git: {
    installed: boolean;
    version: string | null;
  };
  gh: ToolStatus;
  glab: ToolStatus;
}
