import type { CodeMieClient } from "codemie-sdk";
import type {
  Integration,
  IntegrationListParams,
  IntegrationGetParams,
  IntegrationGetByAliasParams,
  IntegrationCreateParams,
  IntegrationUpdateParams,
  IntegrationTypeType,
} from "codemie-sdk";

/**
 * List integrations with pagination and filters
 */
export async function listIntegrations(
  client: CodeMieClient,
  params: IntegrationListParams = {},
): Promise<Integration[]> {
  return client.integrations.list(params);
}

/**
 * Get integration by ID
 */
export async function getIntegration(
  client: CodeMieClient,
  params: IntegrationGetParams,
): Promise<Integration> {
  return client.integrations.get(params);
}

/**
 * Get integration by alias
 */
export async function getIntegrationByAlias(
  client: CodeMieClient,
  params: IntegrationGetByAliasParams,
): Promise<Integration> {
  return client.integrations.getByAlias(params);
}

/**
 * Create a new integration
 */
export async function createIntegration(
  client: CodeMieClient,
  params: IntegrationCreateParams,
): Promise<unknown> {
  return client.integrations.create(params);
}

function mergeCredentialValues(
  existing: { key: string }[],
  params: { key: string }[],
) {
  const map = new Map();
  existing.forEach((item) => {
    map.set(item.key, item);
  });

  params.forEach((item) => {
    map.set(item.key, item);
  });

  return Array.from(map.values());
}

/**
 * Update an existing integration
 */
export async function updateIntegration(
  client: CodeMieClient,
  settingId: string,
  settingType: "user" | "project",
  params: Partial<IntegrationUpdateParams>,
): Promise<unknown> {
  const existing = await client.integrations.get({
    integration_id: settingId,
    setting_type: settingType,
  });

  const data: IntegrationUpdateParams = {
    project_name: existing.project_name,
    credential_type: existing.credential_type,
    alias: params.alias ?? existing.alias,
    credential_values: mergeCredentialValues(
      existing.credential_values,
      params.credential_values ?? [],
    ),
    setting_type: existing.setting_type,
    default: params.default ?? existing.default,
  };

  return client.integrations.update(settingId, data);
}

/**
 * Delete an integration
 */
export async function deleteIntegration(
  client: CodeMieClient,
  settingId: string,
  settingType?: IntegrationTypeType,
): Promise<unknown> {
  return client.integrations.delete(settingId, settingType);
}
