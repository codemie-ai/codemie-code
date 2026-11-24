/**
 * The CodeMie project a work-consent folder is granted for: an explicit override, else the one the profile or
 * workspace resolves for the folder. Shared by `consent grant` and `proxy connect`.
 */

import { ConfigurationError } from '@/utils/errors.js';
import { rawProjectHeader } from '@/utils/header-value.js';
import { canonicalizePath } from '@/agents/core/project-allowlist.js';
import { resolveSessionProject } from '@/agents/core/event-fields/identity-fields.js';

/**
 * Resolves and validates the project for a consent folder. The project may come from the profile or workspace
 * configuration; that only proposes it, never grants consent. Throws `ConfigurationError` when none resolves or its
 * name cannot be sent (the analytics protocol carries Latin-1 text only).
 */
export async function resolveConsentProject(folder: string, override?: string): Promise<string> {
  const canonical = await canonicalizePath(folder);
  const project = (override ?? (await resolveSessionProject(canonical, undefined))).trim();
  if (!project) {
    throw new ConfigurationError('No CodeMie project resolved for this folder. Pass --project <name>.');
  }
  if (rawProjectHeader(project) === undefined) {
    throw new ConfigurationError(`Project "${project}" cannot be used for a connected work folder: its name has characters the analytics protocol cannot send (only Latin-1 text is supported). Use a project with a supported name.`);
  }
  return project;
}
