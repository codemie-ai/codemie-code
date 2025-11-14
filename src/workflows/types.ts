/**
 * Workflow management types
 */

export type VCSProvider = 'github' | 'gitlab';

export type WorkflowTriggerType =
  | 'pull_request'
  | 'issue_comment'
  | 'pull_request_review_comment'
  | 'pull_request_review'
  | 'issues'
  | 'workflow_dispatch'
  | 'push'
  | 'schedule';

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  config?: Record<string, unknown>;
}

export type PermissionLevel = 'trusted-only' | 'all' | 'collaborators';

export interface WorkflowPermissions {
  level: PermissionLevel;
  contents?: 'read' | 'write';
  pullRequests?: 'read' | 'write';
  issues?: 'read' | 'write';
  idToken?: 'write';
  actions?: 'read';
  statuses?: 'write';
}

export interface WorkflowConfig {
  timeout?: number;
  maxTurns?: number;
  model?: string;
  environment?: string;
  envVars?: Record<string, string>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  provider: VCSProvider;
  version: string;
  triggers: WorkflowTrigger[];
  permissions: WorkflowPermissions;
  config: WorkflowConfig;
  templatePath: string;
  dependencies: WorkflowDependencies;
  category: WorkflowCategory;
}

export interface WorkflowDependencies {
  secrets: string[];
  tools: string[];
  optionalSecrets?: string[];
}

export type WorkflowCategory = 'code-review' | 'automation' | 'ci-cd' | 'security';

export interface InstalledWorkflow {
  id: string;
  provider: VCSProvider;
  filePath: string;
  installedAt: Date;
  version: string;
  config: WorkflowConfig;
}

export interface WorkflowInstallOptions {
  interactive?: boolean;
  dryRun?: boolean;
  force?: boolean;
  provider?: VCSProvider;
  triggers?: WorkflowTriggerType[];
  permissions?: PermissionLevel;
  timeout?: number;
  maxTurns?: number;
  environment?: string;
}

export interface VCSDetectionResult {
  provider: VCSProvider | null;
  remoteUrl: string | null;
  isGitRepo: boolean;
  workflowDir: string | null;
}
