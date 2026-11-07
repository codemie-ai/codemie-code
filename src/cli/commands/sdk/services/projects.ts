import type {
  CodeMieClient,
  ProjectDetail,
  ProjectListItem,
  PaginatedProjectList,
  ListProjectsOptions,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectUpdateRequest,
  ProjectUpdateResponse,
  ProjectDeleteResponse,
  ProjectOwnershipUpdateResponse,
  ProjectAssignmentResponse,
  ProjectMember,
  BulkAssignmentUserItem,
  BulkAssignmentResponse,
  BulkAssignmentResultItem,
  CsvImportValidationResponse,
  CsvImportRowResult,
} from "codemie-sdk";

export type {
  ProjectDetail,
  ProjectListItem,
  PaginatedProjectList,
  ListProjectsOptions,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectUpdateRequest,
  ProjectUpdateResponse,
  ProjectDeleteResponse,
  ProjectOwnershipUpdateResponse,
  ProjectAssignmentResponse,
  ProjectMember,
  BulkAssignmentUserItem,
  BulkAssignmentResponse,
  BulkAssignmentResultItem,
  CsvImportValidationResponse,
  CsvImportRowResult,
};

export async function listProjects(
  client: CodeMieClient,
  options: ListProjectsOptions,
): Promise<PaginatedProjectList> {
  return client.projects.listProjects(options);
}

export async function getProjectDetail(
  client: CodeMieClient,
  name: string,
): Promise<ProjectDetail> {
  return client.projects.getProjectDetail(name);
}

export async function createProject(
  client: CodeMieClient,
  request: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  return client.projects.createProject(request);
}

export async function updateProject(
  client: CodeMieClient,
  name: string,
  request: ProjectUpdateRequest,
): Promise<ProjectUpdateResponse> {
  return client.projects.updateProject(name, request);
}

export async function deleteProject(
  client: CodeMieClient,
  name: string,
): Promise<ProjectDeleteResponse> {
  return client.projects.deleteProject(name);
}

export async function transferOwnership(
  client: CodeMieClient,
  name: string,
  userId: string,
): Promise<ProjectOwnershipUpdateResponse> {
  return client.projects.transferOwnership(name, userId);
}

export async function assignUserToProject(
  client: CodeMieClient,
  name: string,
  userId: string,
  isProjectAdmin: boolean,
): Promise<ProjectAssignmentResponse> {
  return client.projects.assignUserToProject(name, userId, isProjectAdmin);
}

export async function updateUserProjectAssignment(
  client: CodeMieClient,
  name: string,
  userId: string,
  isProjectAdmin: boolean,
): Promise<ProjectAssignmentResponse> {
  return client.projects.updateUserProjectAssignment(name, userId, isProjectAdmin);
}

export async function removeUserFromProject(
  client: CodeMieClient,
  name: string,
  userId: string,
): Promise<ProjectAssignmentResponse> {
  return client.projects.removeUserFromProject(name, userId);
}

export async function bulkAssignUsersToProject(
  client: CodeMieClient,
  name: string,
  users: BulkAssignmentUserItem[],
): Promise<BulkAssignmentResponse> {
  return client.projects.bulkAssignUsersToProject(name, users);
}

export async function bulkRemoveUsersFromProject(
  client: CodeMieClient,
  name: string,
  userIds: string[],
): Promise<BulkAssignmentResponse> {
  return client.projects.bulkRemoveUsersFromProject(name, userIds);
}

export async function validateUsersFromCsv(
  client: CodeMieClient,
  name: string,
  csv: Buffer,
  filename: string,
): Promise<CsvImportValidationResponse> {
  return client.projects.validateUsersFromCsv(name, csv, filename);
}

export async function importUsersFromCsv(
  client: CodeMieClient,
  name: string,
  csv: Buffer,
  filename: string,
): Promise<BulkAssignmentResponse> {
  return client.projects.importUsersFromCsv(name, csv, filename);
}
