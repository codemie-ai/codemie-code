import type {
  CodeMieClient,
  Workflow,
  WorkflowCreateParams,
  WorkflowUpdateParams,
  WorkflowListParams,
} from "codemie-sdk";
import { NotFoundError } from "codemie-sdk";

interface WorkflowServiceTransport {
  api: {
    put<T>(path: string, data: { user_input: string }): Promise<T>;
  };
}

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

export async function findWorkflowByExactName(
  client: CodeMieClient,
  workflowName: string,
): Promise<Workflow> {
  const workflows = await listWorkflows(client, { search: workflowName });
  const matches = workflows.filter(
    (workflow) => workflow.name.toLowerCase() === workflowName.toLowerCase(),
  );

  if (matches.length === 0) {
    throw new Error(`Workflow with name "${workflowName}" was not found`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple workflows matched the name "${workflowName}"`);
  }

  return matches[0];
}

export async function resolveWorkflowIdFromIdOrName(
  client: CodeMieClient,
  idOrName: string,
): Promise<string> {
  try {
    const workflow = await getWorkflow(client, idOrName);
    return workflow.id;
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }

  const workflow = await findWorkflowByExactName(client, idOrName);
  return workflow.id;
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

export async function runWorkflow(
  client: CodeMieClient,
  workflowId: string,
  userInput?: string | Record<string, unknown> | unknown[] | number | boolean,
  fileName?: string,
  sessionId?: string,
): Promise<unknown> {
  return client.workflows.run(workflowId, userInput, fileName, sessionId);
}

export async function resumeWorkflowExecution(
  client: CodeMieClient,
  workflowId: string,
  executionId: string,
  editedInput?: string,
): Promise<void> {
  if (editedInput === undefined) {
    await client.workflows.executions(workflowId).resume(executionId);
    return;
  }

  const workflowService = client.workflows as unknown as WorkflowServiceTransport;
  await workflowService.api.put(
    `/v1/workflows/${workflowId}/executions/${executionId}/resume`,
    { user_input: editedInput },
  );
}
