import type { CodeMieClient, LLMModel } from "codemie-sdk";

export async function listLlmModels(
  client: CodeMieClient,
): Promise<LLMModel[]> {
  return client.llms.list();
}

export async function listEmbeddingModels(
  client: CodeMieClient,
): Promise<LLMModel[]> {
  return client.llms.listEmbeddings();
}
