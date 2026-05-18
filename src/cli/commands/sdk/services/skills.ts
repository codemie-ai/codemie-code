import type {
  CodeMieClient,
  SkillListItem,
  SkillDetail,
  SkillCreateParams,
  SkillUpdateParams,
  SkillImportParams,
  SkillCategoryItem,
  SkillListPaginatedResponse,
  AnyJson,
} from "codemie-sdk";

type SkillListParams = Parameters<CodeMieClient["skills"]["list"]>[0];

export async function listSkills(
  client: CodeMieClient,
  params?: SkillListParams,
): Promise<SkillListItem[]> {
  return client.skills.list(params);
}

export async function listSkillsPaginated(
  client: CodeMieClient,
  params?: SkillListParams,
): Promise<SkillListPaginatedResponse> {
  return client.skills.listPaginated(params);
}

export async function getSkill(
  client: CodeMieClient,
  skillId: string,
): Promise<SkillDetail> {
  return client.skills.get(skillId);
}

export async function createSkill(
  client: CodeMieClient,
  params: SkillCreateParams,
): Promise<SkillDetail> {
  return client.skills.create(params);
}

export async function updateSkill(
  client: CodeMieClient,
  skillId: string,
  params: SkillUpdateParams,
): Promise<SkillDetail> {
  const existing = await client.skills.get(skillId);

  const mergedParams: SkillUpdateParams = {
    name: params.name ?? existing.name,
    description: params.description ?? existing.description,
    content: params.content ?? existing.content,
    project: params.project ?? existing.project,
    visibility: params.visibility ?? existing.visibility,
    categories: params.categories ?? existing.categories ?? [],
    toolkits: params.toolkits ?? existing.toolkits ?? [],
    mcp_servers: params.mcp_servers ?? existing.mcp_servers ?? [],
  };

  return client.skills.update(skillId, mergedParams);
}

export async function deleteSkill(
  client: CodeMieClient,
  skillId: string,
): Promise<AnyJson> {
  return client.skills.delete(skillId);
}

export async function importSkill(
  client: CodeMieClient,
  params: SkillImportParams,
): Promise<SkillDetail> {
  return client.skills.importSkill(params);
}

export async function exportSkill(
  client: CodeMieClient,
  skillId: string,
): Promise<string> {
  return client.skills.export(skillId);
}

export async function attachSkillToAssistant(
  client: CodeMieClient,
  assistantId: string,
  skillId: string,
): Promise<AnyJson> {
  return client.skills.attachToAssistant(assistantId, skillId);
}

export async function detachSkillFromAssistant(
  client: CodeMieClient,
  assistantId: string,
  skillId: string,
): Promise<AnyJson> {
  return client.skills.detachFromAssistant(assistantId, skillId);
}

export async function getAssistantSkills(
  client: CodeMieClient,
  assistantId: string,
): Promise<SkillListItem[]> {
  return client.skills.getAssistantSkills(assistantId);
}

export async function bulkAttachSkillToAssistants(
  client: CodeMieClient,
  skillId: string,
  assistantIds: string[],
): Promise<AnyJson> {
  return client.skills.bulkAttachToAssistants(skillId, assistantIds);
}

export async function getSkillAssistants(
  client: CodeMieClient,
  skillId: string,
): Promise<AnyJson[]> {
  return client.skills.getSkillAssistants(skillId);
}

export async function publishSkill(
  client: CodeMieClient,
  skillId: string,
  categories?: string[],
): Promise<AnyJson> {
  return client.skills.publish(skillId, categories);
}

export async function unpublishSkill(
  client: CodeMieClient,
  skillId: string,
): Promise<AnyJson> {
  return client.skills.unpublish(skillId);
}

export async function listSkillCategories(
  client: CodeMieClient,
): Promise<SkillCategoryItem[]> {
  return client.skills.listCategories();
}

export async function getSkillUsers(
  client: CodeMieClient,
): Promise<AnyJson[]> {
  return client.skills.getUsers();
}

export async function reactToSkill(
  client: CodeMieClient,
  skillId: string,
  reaction: "like" | "dislike",
): Promise<AnyJson> {
  return client.skills.react(skillId, reaction);
}

export async function removeSkillReactions(
  client: CodeMieClient,
  skillId: string,
): Promise<AnyJson> {
  return client.skills.removeReactions(skillId);
}
