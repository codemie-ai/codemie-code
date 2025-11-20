export interface SSOAuthConfig {
  codeMieUrl: string;
  timeout?: number;
}

export interface SSOAuthResult {
  success: boolean;
  apiUrl?: string;
  cookies?: Record<string, string>;
  error?: string;
}

export interface CodeMieModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
  label?: string;
  name?: string;
  description?: string;
  context_length?: number;
  provider?: string;
  multimodal?: boolean;
  react_agent?: boolean;
  enabled?: boolean;
  default?: boolean;
}

export interface SSOCredentials {
  cookies: Record<string, string>;
  apiUrl: string;
  expiresAt?: number;
}

export interface CodeMieIntegration {
  id: string;
  alias: string;
  project_name: string;
  credential_type: string;
  created_at?: string;
  updated_at?: string;
}

export interface CodeMieIntegrationsResponse {
  integrations?: CodeMieIntegration[];
  // Allow for flexible response structure
  [key: string]: any;
}