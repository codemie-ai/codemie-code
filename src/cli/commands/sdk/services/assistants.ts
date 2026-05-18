import type {
  CodeMieClient,
  Assistant,
  AssistantBase,
  AssistantCreateParams,
  AssistantUpdateParams,
  AssistantListParams,
  ToolKitDetails,
} from "codemie-sdk";
import { ConfigurationError } from "@/utils/errors.js";
import { listLlmModels } from "./llm.js";

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export async function getAssistantTools(
  client: CodeMieClient,
): Promise<ToolKitDetails[]> {
  return client.assistants.getTools();
}

export async function listAssistants(
  client: CodeMieClient,
  params?: AssistantListParams,
): Promise<(Assistant | AssistantBase)[]> {
  return client.assistants.list(params);
}

export async function getAssistant(
  client: CodeMieClient,
  assistantId: string,
): Promise<Assistant> {
  return client.assistants.get(assistantId);
}

export async function createAssistant(
  client: CodeMieClient,
  params: Partial<AssistantCreateParams>,
): Promise<{ message: string; assistant_id?: string }> {
  const llmModels = await listLlmModels(client);
  if (llmModels.length === 0) {
    throw new ConfigurationError("No LLM models are available. Contact your administrator.");
  }
  const defaultLlmModel =
    llmModels.find((m) => m.default)?.base_name ?? llmModels[0].base_name;

  const mergedParams: Partial<AssistantCreateParams> = {
    context: [],
    toolkits: [],
    conversation_starters: [],
    mcp_servers: [],
    assistant_ids: [],
    llm_model_type: defaultLlmModel,
    ...params,
  };

  return client.assistants.create(mergedParams as AssistantCreateParams);
}

export async function updateAssistant(
  client: CodeMieClient,
  assistantId: string,
  params: Partial<AssistantUpdateParams>,
): Promise<{ message: string }> {
  const [existing, llmModels] = await Promise.all([
    client.assistants.get(assistantId),
    listLlmModels(client),
  ]);
  if (llmModels.length === 0) {
    throw new ConfigurationError("No LLM models are available. Contact your administrator.");
  }
  const defaultLlmModel =
    llmModels.find((m) => m.default)?.base_name ?? llmModels[0].base_name;

  const mergedParams: Writeable<Partial<AssistantUpdateParams>> = {
    ...existing,
    ...params,
    icon_url: existing.icon_url ?? "",
    slug: existing.slug ?? "",
    llm_model_type:
      params.llm_model_type ?? existing.llm_model_type ?? defaultLlmModel,
    categories:
      params.categories ?? existing.categories?.map((c) => c.id) ?? [],
    toolkits: params.toolkits ?? existing.toolkits ?? [],
  };

  if (params.temperature !== undefined) mergedParams.temperature = params.temperature;
  else if (existing.temperature === null) delete mergedParams.temperature;

  if (params.top_p !== undefined) mergedParams.top_p = params.top_p;
  else if (existing.top_p === null) delete mergedParams.top_p;

  return client.assistants.update(
    assistantId,
    mergedParams as AssistantUpdateParams,
  );
}

export async function deleteAssistant(
  client: CodeMieClient,
  assistantId: string,
): Promise<void> {
  await client.assistants.delete(assistantId);
}
