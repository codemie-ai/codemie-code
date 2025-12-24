# Workflow Management System

This guide provides documentation for the CI/CD workflow management system in the CodeMie CLI.

**Context**: This file is loaded automatically when working in `src/workflows/**`. It contains guidance for workflow template development and installation patterns.

---

## Overview

The Workflow Management System provides **CI/CD workflow installation and management**:
- Auto-detect VCS provider (GitHub/GitLab) from git remote
- Template-based workflow installation
- Customizable configurations (timeout, max-turns, environment)
- Dependency validation
- Interactive and non-interactive modes

---

## Architecture

### Core Components

- **Registry** (`registry.ts`): Manages workflow templates
- **Detector** (`detector.ts`): Auto-detects VCS provider from git remote
- **Installer** (`installer.ts`): Installs and customizes workflow templates
- **Templates** (`templates/`): Pre-built workflow templates
  - `github/`: GitHub Actions workflows
  - `gitlab/`: GitLab CI workflows
- **Types** (`types.ts`): TypeScript definitions for workflows

---

## Available Commands

```bash
# List available workflows
codemie workflow list

# Show only installed workflows
codemie workflow list --installed

# Install a workflow
codemie workflow install pr-review

# Interactive installation
codemie workflow install --interactive

# Uninstall a workflow
codemie workflow uninstall pr-review

# Dry run (preview changes without installing)
codemie workflow install pr-review --dry-run
```

---

## Available Workflows

### pr-review
**Automated code review on pull requests**
- Runs on PR opened/updated events
- Analyzes changes and provides feedback
- Posts review comments directly on PR

### inline-fix
**Quick code fixes from PR comments**
- Triggered by PR comments with `/fix` command
- Applies AI-suggested fixes inline
- Commits and pushes changes automatically

### code-ci
**Full feature implementation from issues**
- Triggered by issue labels or comments
- Implements complete features from issue description
- Creates PR with implementation

---

## Adding New Workflows (4 Steps)

### Step 1: Create Template File

**GitHub**: `src/workflows/templates/github/your-workflow.yml`

```yaml
name: Your Workflow Name

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  your-job:
    runs-on: ubuntu-latest
    timeout-minutes: {{timeout-minutes}}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run Your Task
        run: |
          # Your workflow logic here
          echo "MAX_TURNS={{MAX_TURNS}}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**GitLab**: `src/workflows/templates/gitlab/your-workflow.yml`

```yaml
your-workflow:
  stage: review
  timeout: {{timeout-minutes}}m
  script:
    - echo "Running workflow"
    - echo "MAX_TURNS={{MAX_TURNS}}"
  only:
    - merge_requests
```

### Step 2: Register Template

**File**: `src/workflows/templates/github/metadata.ts` (or `gitlab/metadata.ts`)

```typescript
import path from 'path';
import type { WorkflowTemplate } from '../../types.js';

export const yourWorkflowTemplate: WorkflowTemplate = {
  id: 'your-workflow',
  name: 'Your Workflow Name',
  description: 'Brief description of what this workflow does',
  provider: 'github',  // or 'gitlab'
  version: '1.0.0',
  category: 'code-review',  // or 'automation', 'ci-cd', 'security'

  // Trigger conditions
  triggers: [
    {
      event: 'pull_request',
      types: ['opened', 'synchronize']
    }
  ],

  // Required permissions
  permissions: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'read'
  },

  // Configurable variables
  config: {
    timeoutMinutes: {
      default: 10,
      description: 'Workflow timeout in minutes'
    },
    maxTurns: {
      default: 15,
      description: 'Maximum AI conversation turns'
    },
    environment: {
      default: '',
      description: 'GitHub environment name (optional)'
    }
  },

  // Template file path
  templatePath: path.join(__dirname, 'your-workflow.yml'),

  // Dependencies (other workflows, secrets, etc.)
  dependencies: {
    secrets: ['OPENAI_API_KEY'],  // Optional: required secrets
    workflows: []  // Optional: dependent workflows
  }
};

// Add to existing workflow templates array
export const githubWorkflowTemplates: WorkflowTemplate[] = [
  // ... existing templates ...
  yourWorkflowTemplate
];
```

### Step 3: Template Variables

Templates support customizable variables using `{{variable-name}}` syntax:

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `timeout-minutes` | Workflow timeout | `10` |
| `MAX_TURNS` | Maximum AI turns | `15` |
| `environment` | GitHub environment | `production` |

Variables are replaced during installation based on user configuration or defaults.

### Step 4: Test Installation

```bash
# Build and link for local development
npm run build && npm link

# Dry run to preview changes
codemie workflow install your-workflow --dry-run

# Install workflow
codemie workflow install your-workflow

# Verify installation
codemie workflow list --installed
```

---

## VCS Detection

The workflow system automatically detects your VCS provider:

### Automatic Detection

Reads `.git/config` remote URL to determine provider:
- `github.com` → GitHub Actions
- `gitlab.com` or self-hosted GitLab → GitLab CI

### Manual Override

```bash
# Force GitHub provider
codemie workflow install pr-review --github

# Force GitLab provider
codemie workflow install pr-review --gitlab
```

### Validation

- Checks if workflow directory exists (`.github/workflows/` or `.gitlab-ci.yml`)
- Creates directory if missing (with user confirmation)
- Validates file permissions before writing

---

## Development Patterns

### Pattern 1: Interactive Installation

Prompt users for configuration values:

```typescript
import * as clack from '@clack/prompts';

async function installWithPrompts() {
  const timeout = await clack.text({
    message: 'Workflow timeout (minutes):',
    initialValue: '10',
    validate: (value) => {
      const num = parseInt(value);
      return num > 0 ? undefined : 'Must be positive number';
    }
  });

  const maxTurns = await clack.text({
    message: 'Maximum AI turns:',
    initialValue: '15'
  });

  return { timeout, maxTurns };
}
```

### Pattern 2: Template Validation

Validate templates before installation:

```typescript
function validateTemplate(template: WorkflowTemplate): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (!template.id) errors.push('Template ID is required');
  if (!template.templatePath) errors.push('Template path is required');

  // Validate file exists
  if (!fs.existsSync(template.templatePath)) {
    errors.push(`Template file not found: ${template.templatePath}`);
  }

  // Validate VCS provider
  if (!['github', 'gitlab'].includes(template.provider)) {
    errors.push(`Invalid provider: ${template.provider}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
```

### Pattern 3: Variable Substitution

Replace template variables with actual values:

```typescript
function substituteVariables(
  template: string,
  config: Record<string, string | number>
): string {
  let result = template;

  for (const [key, value] of Object.entries(config)) {
    const pattern = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(pattern, String(value));
  }

  return result;
}
```

### Pattern 4: Dependency Checking

Verify dependencies before installation:

```typescript
async function checkDependencies(
  template: WorkflowTemplate
): Promise<DependencyCheckResult> {
  const missing: string[] = [];

  // Check required secrets
  if (template.dependencies?.secrets) {
    for (const secret of template.dependencies.secrets) {
      if (!await secretExists(secret)) {
        missing.push(`Secret: ${secret}`);
      }
    }
  }

  // Check dependent workflows
  if (template.dependencies?.workflows) {
    for (const workflow of template.dependencies.workflows) {
      if (!await workflowInstalled(workflow)) {
        missing.push(`Workflow: ${workflow}`);
      }
    }
  }

  return {
    satisfied: missing.length === 0,
    missing
  };
}
```

---

## Testing

### Unit Testing

Test template processing:

```typescript
import { describe, it, expect } from 'vitest';
import { substituteVariables } from './installer.js';

describe('Variable Substitution', () => {
  it('should replace template variables', () => {
    const template = 'timeout: {{timeout-minutes}}m';
    const config = { 'timeout-minutes': 10 };

    const result = substituteVariables(template, config);
    expect(result).toBe('timeout: 10m');
  });
});
```

### Integration Testing

Test workflow installation:

```typescript
import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('workflow install', () => {
  it('should install workflow', async () => {
    const { stdout } = await execAsync(
      'codemie workflow install pr-review --dry-run'
    );
    expect(stdout).toContain('pr-review');
  });
});
```

---

## Best Practices

### Template Design

- Keep workflows focused on single responsibility
- Use clear, descriptive names
- Document all configuration variables
- Provide sensible defaults
- Validate inputs before execution

### Error Handling

- Check for existing workflow files before installing
- Validate VCS provider compatibility
- Provide clear error messages with actionable suggestions
- Use dry-run mode for safe previews

### Security

- Never hardcode secrets in templates
- Use environment variables for sensitive data
- Validate file permissions before writing
- Follow principle of least privilege for permissions

### Documentation

- Document workflow purpose and triggers
- List all required secrets and dependencies
- Provide usage examples in template description
- Include troubleshooting tips

---

## Validation Checklist

Before submitting a new workflow template:

- ✅ Template file follows VCS naming conventions
- ✅ Registered in metadata file (github or gitlab)
- ✅ All variables documented with defaults
- ✅ Required permissions specified
- ✅ Dependencies listed (if any)
- ✅ Template tested with dry-run
- ✅ Installation works end-to-end
- ✅ ESLint passes (`npm run lint`)
- ✅ Builds successfully (`npm run build`)

---

## Reference Implementations

Study these workflows for examples:
- **`pr-review`**: Automated PR code review with AI feedback
- **`inline-fix`**: Quick fixes from PR comments
- **`code-ci`**: Full feature implementation from issues

---

## Architecture Benefits

✅ **VCS Agnostic**: Works with GitHub and GitLab
✅ **Template-Based**: Easy to add new workflows
✅ **Customizable**: Variables for flexible configuration
✅ **Safe**: Dry-run mode and validation before installation
✅ **Type-Safe**: Full TypeScript support with proper interfaces
