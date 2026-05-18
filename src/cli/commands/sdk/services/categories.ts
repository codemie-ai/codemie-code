import type {
  CodeMieClient,
  Category,
  CategoryResponse,
  CategoryListResponse,
  CategoryCreateParams,
  CategoryUpdateParams,
} from "codemie-sdk";

export async function getCategories(
  client: CodeMieClient,
): Promise<Category[]> {
  return client.categories.getCategories();
}

export async function listCategories(
  client: CodeMieClient,
  page?: number,
  perPage?: number,
): Promise<CategoryListResponse> {
  return client.categories.listCategories(page, perPage);
}

export async function getCategory(
  client: CodeMieClient,
  categoryId: string,
): Promise<CategoryResponse> {
  return client.categories.getCategory(categoryId);
}

export async function createCategory(
  client: CodeMieClient,
  params: CategoryCreateParams,
): Promise<CategoryResponse> {
  return client.categories.createCategory(params);
}

export async function updateCategory(
  client: CodeMieClient,
  categoryId: string,
  params: CategoryUpdateParams,
): Promise<CategoryResponse> {
  return client.categories.updateCategory(categoryId, params);
}

export async function deleteCategory(
  client: CodeMieClient,
  categoryId: string,
): Promise<void> {
  return client.categories.deleteCategory(categoryId);
}
