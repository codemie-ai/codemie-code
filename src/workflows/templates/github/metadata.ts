/**
 * GitHub workflow templates metadata
 */

import type { WorkflowTemplate } from '../../types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template files are always in src/workflows/templates/github relative to package root
// From dist/workflows/templates/github, go up 4 levels to package root, then to src/workflows/templates/github
const templateDir = __dirname.includes('/dist/')
  ? path.resolve(__dirname, '../../../../src/workflows/templates/github')
  : __dirname;

export const GITHUB_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'pr-review',
    name: 'CodeMie PR Review',
    description: 'Automated code review on pull requests with AI-powered suggestions',
    provider: 'github',
    version: '1.0.0',
    category: 'code-review',
    triggers: [
      { type: 'pull_request', config: { types: ['opened', 'reopened', 'synchronize'] } },
      { type: 'issue_comment', config: { types: ['created'] } },
      { type: 'pull_request_review_comment', config: { types: ['created'] } },
      { type: 'pull_request_review', config: { types: ['submitted'] } },
      { type: 'workflow_dispatch' },
    ],
    permissions: {
      level: 'trusted-only',
      contents: 'read',
      idToken: 'write',
      issues: 'write',
      pullRequests: 'write',
      statuses: 'write',
    },
    config: {
      timeout: 15,
      maxTurns: 50,
      environment: 'dev',
    },
    templatePath: path.join(templateDir, 'pr-review.yml'),
    dependencies: {
      secrets: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      tools: ['gh'],
      optionalSecrets: ['ANTHROPIC_MODEL', 'PAT_TOKEN'],
    },
  },
  {
    id: 'inline-fix',
    name: 'CodeMie Inline Fix',
    description: 'Quick code fixes from PR comments mentioning @codemie',
    provider: 'github',
    version: '1.0.0',
    category: 'automation',
    triggers: [
      { type: 'issue_comment', config: { types: ['created'] } },
      { type: 'pull_request_review_comment', config: { types: ['created'] } },
      { type: 'pull_request_review', config: { types: ['submitted'] } },
    ],
    permissions: {
      level: 'all',
      contents: 'write',
      pullRequests: 'write',
      issues: 'write',
    },
    config: {
      timeout: 10,
      maxTurns: 50,
      environment: 'dev',
    },
    templatePath: path.join(templateDir, 'inline-fix.yml'),
    dependencies: {
      secrets: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      tools: ['gh'],
      optionalSecrets: ['ANTHROPIC_MODEL'],
    },
  },
  {
    id: 'code-ci',
    name: 'CodeMie Code CI',
    description: 'Full feature implementation from issues with automated testing',
    provider: 'github',
    version: '1.0.0',
    category: 'ci-cd',
    triggers: [
      { type: 'issues', config: { types: ['opened'] } },
      { type: 'issue_comment', config: { types: ['created'] } },
      { type: 'workflow_dispatch' },
    ],
    permissions: {
      level: 'all',
      contents: 'write',
      pullRequests: 'write',
      issues: 'write',
      idToken: 'write',
      actions: 'read',
    },
    config: {
      timeout: 30,
      maxTurns: 50,
      environment: 'dev',
    },
    templatePath: path.join(templateDir, 'code-ci.yml'),
    dependencies: {
      secrets: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      tools: ['gh'],
      optionalSecrets: ['ANTHROPIC_MODEL'],
    },
  },
];
