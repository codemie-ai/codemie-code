import type { Assistant, AssistantBase } from 'codemie-sdk';

/**
 * Filter assistants by simple substring search
 * Returns top 5 matches
 *
 * Searches in: name, description, project, slug
 * Case-insensitive substring matching
 */
export function filterAssistants(
  assistants: (Assistant | AssistantBase)[],
  query: string
): (Assistant | AssistantBase)[] {
  if (!query.trim()) {
    return assistants.slice(0, 5); // No search, return first 5
  }

  const lowerQuery = query.toLowerCase();

  const matches = assistants.filter(assistant => {
    // Type guard for Assistant vs AssistantBase
    const project = 'project' in assistant ? assistant.project : undefined;
    const slug = 'slug' in assistant ? assistant.slug : undefined;

    return (
      assistant.name.toLowerCase().includes(lowerQuery) ||
      assistant.description?.toLowerCase().includes(lowerQuery) ||
      project?.toLowerCase().includes(lowerQuery) ||
      slug?.toLowerCase().includes(lowerQuery)
    );
  });

  return matches.slice(0, 5); // Limit to 5
}
