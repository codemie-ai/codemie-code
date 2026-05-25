import type {
  CodeMieClient,
  AzureDevOpsWikiDataSourceCreateParams,
  AzureDevOpsWikiDataSourceUpdateParams,
  AzureDevOpsWorkItemDataSourceCreateParams,
  AzureDevOpsWorkItemDataSourceUpdateParams,
  CodeDataSourceCreateParams,
  CodeDataSourceUpdateParams,
  ConfluenceDataSourceCreateParams,
  ConfluenceDataSourceUpdateParams,
  DataSource,
  DataSourceListParams,
  FileDataSourceCreateParams,
  FileDataSourceUpdateDto,
  GoogleDataSourceCreateParams,
  GoogleDataSourceUpdateParams,
  JiraDataSourceCreateParams,
  JiraDataSourceUpdateParams,
  OtherDataSourceCreateParams,
  OtherDataSourceUpdateParams,
  SharePointDataSourceCreateParams,
  SharePointDataSourceUpdateParams,
  XrayDataSourceCreateParams,
  XrayDataSourceUpdateParams,
} from "codemie-sdk";
import { readFilesFromPaths } from "../utils/file-utils.js";

export async function listDatasources(
  client: CodeMieClient,
  params?: DataSourceListParams,
): Promise<DataSource[]> {
  return client.datasources.list(params);
}

export async function getDatasource(
  client: CodeMieClient,
  datasourceId: string,
): Promise<DataSource> {
  return client.datasources.get(datasourceId);
}

// CONFLUENCE
export async function createConfluenceDatasource(
  client: CodeMieClient,
  data: ConfluenceDataSourceCreateParams,
): Promise<unknown> {
  const params: ConfluenceDataSourceCreateParams = {
    type: "knowledge_base_confluence",
    cql: data.cql,
    description: data.description,
    name: data.name,
    project_name: data.project_name,
    setting_id: data.setting_id,
    shared_with_project: data.shared_with_project,
  };

  return client.datasources.create(params);
}

export async function updateConfluenceDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<ConfluenceDataSourceUpdateParams>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);

  const params: ConfluenceDataSourceUpdateParams = {
    type: "knowledge_base_confluence",
    cql: data.cql ?? existing.confluence?.cql,
    description: data.description ?? existing.description,
    name: existing.name,
    project_name: data.project_name ?? existing.project_name,
    setting_id: data.setting_id ?? existing.setting_id,
    shared_with_project: data.shared_with_project ?? existing.shared_with_project,
  };

  return client.datasources.update(params);
}

// JIRA
export async function createJiraDatasource(
  client: CodeMieClient,
  data: JiraDataSourceCreateParams,
): Promise<unknown> {
  const params: JiraDataSourceCreateParams = {
    ...data,
    type: "knowledge_base_jira",
    name: data.name,
    description: data.description,
    jql: data.jql,
    project_name: data.project_name,
    setting_id: data.setting_id,
    shared_with_project: data.shared_with_project,
  };

  return client.datasources.create(params);
}

export async function updateJiraDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<JiraDataSourceUpdateParams>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);

  const params: JiraDataSourceUpdateParams = {
    type: "knowledge_base_jira",
    name: existing.name,
    project_name: data.project_name ?? existing.project_name,
    description: data.description ?? existing.description,
    jql: data.jql ?? existing.jira?.jql,
    setting_id: data.setting_id ?? existing.setting_id,
    shared_with_project:
      data.shared_with_project ?? existing.shared_with_project,
  };

  return client.datasources.update(params);
}

// FILE
export async function createFileDatasource(
  client: CodeMieClient,
  data: FileDataSourceCreateParams,
  filePaths: string[],
): Promise<unknown> {
  const files = await readFilesFromPaths(filePaths);

  return client.datasources.create({
    ...data,
    type: "knowledge_base_file",
    files,
  });
}

export async function updateFileDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<FileDataSourceUpdateDto>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);

  const updateParams: FileDataSourceUpdateDto = {
    type: "knowledge_base_file",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };

  return client.datasources.update(updateParams);
}

// CODE
export async function createCodeDatasource(
  client: CodeMieClient,
  data: Omit<CodeDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "code",
  });
}

export async function updateCodeDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<CodeDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  return client.datasources.update({
    type: "code",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  });
}

// GOOGLE
export async function createGoogleDatasource(
  client: CodeMieClient,
  data: GoogleDataSourceCreateParams,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "llm_routing_google",
  });
}

export async function updateGoogleDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<GoogleDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  return client.datasources.update({
    type: "llm_routing_google",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  });
}

// JSON
export async function createJsonDatasource(
  client: CodeMieClient,
  data: Omit<OtherDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "knowledge_base_json",
  });
}

export async function updateJsonDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<OtherDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: OtherDataSourceUpdateParams = {
    type: "knowledge_base_json",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// PROVIDER
export async function createProviderDatasource(
  client: CodeMieClient,
  data: Omit<OtherDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "provider",
  });
}

export async function updateProviderDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<OtherDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: OtherDataSourceUpdateParams = {
    type: "provider",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// SUMMARY
export async function createSummaryDatasource(
  client: CodeMieClient,
  data: Omit<OtherDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "summary",
  });
}

export async function updateSummaryDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<OtherDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: OtherDataSourceUpdateParams = {
    type: "summary",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// CHUNK SUMMARY
export async function createChunkSummaryDatasource(
  client: CodeMieClient,
  data: Omit<OtherDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "chunk-summary",
  });
}

export async function updateChunkSummaryDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<OtherDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: OtherDataSourceUpdateParams = {
    type: "chunk-summary",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// AZURE DEVOPS WIKI
export async function createAzureDevOpsWikiDatasource(
  client: CodeMieClient,
  data: Omit<AzureDevOpsWikiDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "knowledge_base_azure_devops_wiki",
  });
}

export async function updateAzureDevOpsWikiDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<AzureDevOpsWikiDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: AzureDevOpsWikiDataSourceUpdateParams = {
    type: "knowledge_base_azure_devops_wiki",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// AZURE DEVOPS WORK ITEM
export async function createAzureDevOpsWorkItemDatasource(
  client: CodeMieClient,
  data: Omit<AzureDevOpsWorkItemDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "knowledge_base_azure_devops_work_item",
  });
}

export async function updateAzureDevOpsWorkItemDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<AzureDevOpsWorkItemDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: AzureDevOpsWorkItemDataSourceUpdateParams = {
    type: "knowledge_base_azure_devops_work_item",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// XRAY
export async function createXrayDatasource(
  client: CodeMieClient,
  data: Omit<XrayDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "knowledge_base_xray",
  });
}

export async function updateXrayDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<XrayDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: XrayDataSourceUpdateParams = {
    type: "knowledge_base_xray",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// SHAREPOINT
export async function createSharepointDatasource(
  client: CodeMieClient,
  data: Omit<SharePointDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "knowledge_base_sharepoint",
  });
}

export async function updateSharepointDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<SharePointDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: SharePointDataSourceUpdateParams = {
    type: "knowledge_base_sharepoint",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

// PLATFORM
export async function createPlatformDatasource(
  client: CodeMieClient,
  data: Omit<OtherDataSourceCreateParams, "type">,
): Promise<unknown> {
  return client.datasources.create({
    ...data,
    type: "platform_marketplace_assistant",
  });
}

export async function updatePlatformDatasource(
  client: CodeMieClient,
  id: string,
  data: Partial<Omit<OtherDataSourceUpdateParams, "type">>,
): Promise<unknown> {
  const existing = await client.datasources.get(id);
  const params: OtherDataSourceUpdateParams = {
    type: "platform_marketplace_assistant",
    name: existing.name,
    project_name: existing.project_name,
    ...data,
  };
  return client.datasources.update(params);
}

export async function deleteDatasource(
  client: CodeMieClient,
  datasourceId: string,
): Promise<void> {
  await client.datasources.delete(datasourceId);
}
