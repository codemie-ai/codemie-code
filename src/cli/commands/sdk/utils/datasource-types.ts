export interface DatasourceTypeConfig {
  command: string;
  serviceKey?: string; // Override for service function name when command contains invalid identifier chars
  type: string; // SDK type value
  description: string;
  example?: string;
}

export const DATASOURCE_TYPES: DatasourceTypeConfig[] = [
  {
    command: "confluence",
    type: "knowledge_base_confluence",
    description: "Confluence datasource",
    example:
      '{"name":"Wiki","project_name":"Docs","cql":"space=TEAM","description":"Company wiki","shared_with_project":true}',
  },
  {
    command: "jira",
    type: "knowledge_base_jira",
    description: "Jira datasource",
  },
  {
    command: "file",
    type: "knowledge_base_file",
    description: "File datasource (use --file flags for local files)",
  },
  {
    command: "code",
    type: "code",
    description: "Code repository datasource",
  },
  {
    command: "google",
    type: "llm_routing_google",
    description: "Google Docs datasource",
  },
  {
    command: "provider",
    type: "provider",
    description: "Provider datasource",
  },
  {
    command: "azure-devops-wiki",
    serviceKey: "azureDevOpsWiki",
    type: "knowledge_base_azure_devops_wiki",
    description: "Azure DevOps Wiki datasource",
  },
  {
    command: "azure-devops-work-item",
    serviceKey: "azureDevOpsWorkItem",
    type: "knowledge_base_azure_devops_work_item",
    description: "Azure DevOps Work Item datasource",
  },
  {
    command: "xray",
    type: "knowledge_base_xray",
    description: "Xray test management datasource",
  },
  {
    command: "sharepoint",
    type: "knowledge_base_sharepoint",
    description: "SharePoint datasource",
  },
  {
    command: "platform",
    type: "platform_marketplace_assistant",
    description: "Platform marketplace assistant datasource",
  },
];
