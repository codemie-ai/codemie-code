/**
 * GitLab workflow templates metadata
 */

import type { WorkflowTemplate } from '../../types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template files are always in src/workflows/templates/gitlab relative to package root
// From dist/workflows/templates/gitlab, go up 4 levels to package root, then to src/workflows/templates/gitlab
// templateDir will be used when GitLab templates are implemented

// GitLab templates coming soon!
// Currently only GitHub Actions workflows are available.
export const GITLAB_TEMPLATES: WorkflowTemplate[] = [];
