import type {
  CodeMieClient,
  Workflow,
  WorkflowCreateParams,
  WorkflowUpdateParams,
  WorkflowListParams,
} from "codemie-sdk";

export async function listWorkflows(
  client: CodeMieClient,
  params?: WorkflowListParams,
): Promise<Workflow[]> {
  return client.workflows.list(params);
}

export async function getWorkflow(
  client: CodeMieClient,
  workflowId: string,
): Promise<Workflow> {
  return client.workflows.get(workflowId);
}

export async function createWorkflow(
  client: CodeMieClient,
  params: WorkflowCreateParams,
  yamlConfig?: string,
): Promise<unknown> {
  const paramsWithDefaults: WorkflowCreateParams = {
    ...(params as Partial<WorkflowCreateParams>),
    mode: "Sequential",
    description: params.description ?? "",
    shared: params.shared ?? false,
  } as WorkflowCreateParams;

  if (yamlConfig) {
    (paramsWithDefaults as Record<string, unknown>).yaml_config = yamlConfig;
  }

  return client.workflows.create(paramsWithDefaults);
}

export async function updateWorkflow(
  client: CodeMieClient,
  workflowId: string,
  params: WorkflowUpdateParams,
  yamlConfig?: string,
): Promise<unknown> {
  const existing = await client.workflows.get(workflowId);

  const mergedParams: WorkflowUpdateParams = {
    ...existing,
    ...params,
    icon_url: params.icon_url ?? existing.icon_url ?? "",
  };

  if (yamlConfig) {
    (mergedParams as Record<string, unknown>).yaml_config = yamlConfig;
  }

  return client.workflows.update(workflowId, mergedParams);
}

export async function deleteWorkflow(
  client: CodeMieClient,
  workflowId: string,
): Promise<void> {
  await client.workflows.delete(workflowId);
}
