/**
 * Workflow templates registry
 */

import type { VCSProvider, WorkflowTemplate } from './types.js';
import { GITHUB_TEMPLATES } from './templates/github/metadata.js';
import { GITLAB_TEMPLATES } from './templates/gitlab/metadata.js';

/**
 * Get all workflow templates
 */
export function getAllTemplates(): WorkflowTemplate[] {
  return [...GITHUB_TEMPLATES, ...GITLAB_TEMPLATES];
}

/**
 * Get templates for a specific provider
 */
export function getTemplatesByProvider(provider: VCSProvider): WorkflowTemplate[] {
  return getAllTemplates().filter(template => template.provider === provider);
}

/**
 * Get a specific template by ID and provider
 */
export function getTemplate(id: string, provider: VCSProvider): WorkflowTemplate | null {
  const templates = getTemplatesByProvider(provider);
  return templates.find(template => template.id === id) || null;
}

/**
 * Check if a template exists
 */
export function templateExists(id: string, provider: VCSProvider): boolean {
  return getTemplate(id, provider) !== null;
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(
  category: WorkflowTemplate['category'],
  provider?: VCSProvider
): WorkflowTemplate[] {
  let templates = getAllTemplates();

  if (provider) {
    templates = templates.filter(template => template.provider === provider);
  }

  return templates.filter(template => template.category === category);
}

/**
 * Search templates by name or description
 */
export function searchTemplates(query: string, provider?: VCSProvider): WorkflowTemplate[] {
  let templates = getAllTemplates();

  if (provider) {
    templates = templates.filter(template => template.provider === provider);
  }

  const lowerQuery = query.toLowerCase();
  return templates.filter(
    template =>
      template.name.toLowerCase().includes(lowerQuery) ||
      template.description.toLowerCase().includes(lowerQuery) ||
      template.id.toLowerCase().includes(lowerQuery)
  );
}
