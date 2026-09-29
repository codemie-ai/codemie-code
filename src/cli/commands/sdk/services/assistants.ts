import type {
  CodeMieClient,
  Assistant,
  AssistantBase,
  AssistantCreateParams,
  AssistantUpdateParams,
  AssistantListParams,
  AssistantVersion,
  BaseModelResponse,
  ToolKitDetails,
} from "codemie-sdk";
import { CodeMieError, ConfigurationError } from "@/utils/errors.js";
import { listLlmModels } from "./llm.js";
import type { HistoryEntry } from "../assistant-builder/types.js";

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
    // The read model types MCP config more loosely than the update schema; values round-trip unchanged.
    mcp_servers:
      params.mcp_servers ??
      ((existing.mcp_servers ?? []) as unknown as AssistantUpdateParams["mcp_servers"]),
  };

  if (params.temperature !== undefined) mergedParams.temperature = params.temperature;
  else if (existing.temperature === null) delete mergedParams.temperature;

  if (params.top_p !== undefined) mergedParams.top_p = params.top_p;
  else if (existing.top_p === null) delete mergedParams.top_p;

  const result = await client.assistants.update(
    assistantId,
    mergedParams as AssistantUpdateParams,
  );
  await verifyUntouchedFields(client, assistantId, existing, params);
  return result;
}

const GUARDED_FIELDS = ["mcp_servers", "toolkits"] as const;

export class AssistantIntegrityError extends CodeMieError {
  constructor(assistantId: string, fields: string[]) {
    super(
      `Update of assistant ${assistantId} changed ${fields.join(", ")} although they were not part of the update. ` +
        `Restore with: codemie sdk assistants versions ${assistantId}, then codemie sdk assistants rollback ${assistantId} <previous-version>`,
    );
    this.name = "AssistantIntegrityError";
  }
}

/** Fields the caller did not send must round-trip unchanged; the platform/SDK has silently reset them before. */
async function verifyUntouchedFields(
  client: CodeMieClient,
  assistantId: string,
  before: Assistant,
  params: Partial<AssistantUpdateParams>,
): Promise<void> {
  const untouched = GUARDED_FIELDS.filter((field) => params[field] === undefined);
  if (untouched.length === 0) return;
  const after = await client.assistants.get(assistantId);
  const changed = untouched.filter(
    (field) => JSON.stringify(before[field] ?? []) !== JSON.stringify(after[field] ?? []),
  );
  if (changed.length > 0) throw new AssistantIntegrityError(assistantId, changed);
}

export async function deleteAssistant(
  client: CodeMieClient,
  assistantId: string,
): Promise<void> {
  await client.assistants.delete(assistantId);
}

export interface ChatTurnInput {
  message: string;
  history: HistoryEntry[];
  version?: number;
}

export async function chatWithAssistant(
  client: CodeMieClient,
  assistantId: string,
  input: ChatTurnInput,
): Promise<BaseModelResponse> {
  const params = {
    text: input.message,
    content_raw: input.message,
    history: input.history,
    stream: false,
    save_history: false,
  };
  if (input.version !== undefined) {
    return client.assistants.chatWithVersion(assistantId, input.version, params);
  }
  return client.assistants.chat(assistantId, params);
}

export function normalizeVersions(value: unknown): AssistantVersion[] {
  if (Array.isArray(value)) return value as AssistantVersion[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["data", "versions", "items"]) {
      if (Array.isArray(record[key])) return record[key] as AssistantVersion[];
    }
  }
  return [];
}

const VERSIONS_PAGE_SIZE = 100;

export async function listAssistantVersions(
  client: CodeMieClient,
  assistantId: string,
): Promise<AssistantVersion[]> {
  const versions: AssistantVersion[] = [];
  for (let page = 0; ; page++) {
    const response: unknown = await client.assistants.listVersions(assistantId, { page, per_page: VERSIONS_PAGE_SIZE });
    const batch = normalizeVersions(response);
    versions.push(...batch);
    if (batch.length < VERSIONS_PAGE_SIZE) break;
  }
  return versions.sort((a, b) => a.version_number - b.version_number);
}

export async function rollbackAssistant(
  client: CodeMieClient,
  assistantId: string,
  version: number,
): Promise<unknown> {
  return client.assistants.rollbackToVersion(assistantId, version);
}

/**
 * The version currently in effect: the highest version whose system_prompt matches the active one.
 * Correct whether a rollback creates a new version or only moves the active pointer.
 */
export async function resolveCurrentVersion(
  client: CodeMieClient,
  assistantId: string,
): Promise<number | null> {
  const [assistant, versions] = await Promise.all([
    client.assistants.get(assistantId),
    listAssistantVersions(client, assistantId),
  ]);
  if (versions.length === 0) return null;
  const matching = versions.filter((v) => v.system_prompt === assistant.system_prompt);
  const pool = matching.length > 0 ? matching : versions;
  return Math.max(...pool.map((v) => v.version_number));
}
