/**
 * Workflow installation logic
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VCSProvider, WorkflowInstallOptions, WorkflowTemplate } from './types.js';
import { getTemplate } from './registry.js';
import { ensureWorkflowDir, isWorkflowInstalled } from './detector.js';

/**
 * Install a workflow from template
 */
export async function installWorkflow(
  workflowId: string,
  provider: VCSProvider,
  options: WorkflowInstallOptions = {},
  cwd: string = process.cwd()
): Promise<{ path: string; action: 'installed' | 'skipped' }> {
  const { dryRun = false, force = false } = options;

  // Get template
  const template = getTemplate(workflowId, provider);
  if (!template) {
    throw new Error(`Workflow template '${workflowId}' not found for ${provider}`);
  }

  // Get destination path
  const workflowDir = ensureWorkflowDir(provider, cwd);
  const fileName = `codemie-${workflowId}.yml`;
  const destPath = path.join(workflowDir, fileName);

  // Check if already installed
  if (isWorkflowInstalled(workflowId, provider, cwd) && !force) {
    return { path: destPath, action: 'skipped' };
  }

  // Read template content
  const templateContent = fs.readFileSync(template.templatePath, 'utf-8');

  // Apply customizations
  const customizedContent = applyCustomizations(templateContent, template, options);

  // Dry run: just show what would be installed
  if (dryRun) {
    console.log(`\nDry run: Would install workflow to: ${destPath}\n`);
    console.log('--- Preview ---');
    console.log(customizedContent);
    console.log('---------------\n');
    return { path: destPath, action: 'installed' };
  }

  // Write workflow file
  fs.writeFileSync(destPath, customizedContent, 'utf-8');

  return { path: destPath, action: 'installed' };
}

/**
 * Uninstall a workflow
 */
export async function uninstallWorkflow(
  workflowId: string,
  provider: VCSProvider,
  cwd: string = process.cwd()
): Promise<void> {
  if (!isWorkflowInstalled(workflowId, provider, cwd)) {
    throw new Error(`Workflow '${workflowId}' is not installed`);
  }

  const workflowDir = ensureWorkflowDir(provider, cwd);
  const fileName = `codemie-${workflowId}.yml`;
  const filePath = path.join(workflowDir, fileName);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Apply customizations to template content
 */
function applyCustomizations(
  content: string,
  template: WorkflowTemplate,
  options: WorkflowInstallOptions
): string {
  let result = content;

  // Apply timeout customization
  if (options.timeout !== undefined) {
    result = result.replaceAll(
      /timeout-minutes:\s*\d+/,
      `timeout-minutes: ${options.timeout}`
    );
  }

  // Apply max-turns customization
  if (options.maxTurns !== undefined) {
    result = result.replaceAll(
      /MAX_TURNS:\s*\$\{\{\s*vars\.CODEMIE_MAX_TURNS\s*\|\|\s*['"](\d+)['"]\s*}}/,
      `MAX_TURNS: \${{ vars.CODEMIE_MAX_TURNS || '${options.maxTurns}' }}`
    );
  }

  // Apply environment customization
  if (options.environment) {
    result = result.replaceAll(
      /environment:\s*\w+/,
      `environment: ${options.environment}`
    );
  }

  return result;
}

/**
 * Validate workflow dependencies
 */
export function validateDependencies(template: WorkflowTemplate): {
  valid: boolean;
  missing: string[];
  warnings: string[];
} {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Check required secrets (this is informational - can't actually check secrets)
  if (template.dependencies.secrets.length > 0) {
    warnings.push(
      `This workflow requires the following secrets to be configured:\n  - ${template.dependencies.secrets.join('\n  - ')}`
    );
  }

  // Check optional secrets
  if (template.dependencies.optionalSecrets && template.dependencies.optionalSecrets.length > 0) {
    warnings.push(
      `Optional secrets for enhanced functionality:\n  - ${template.dependencies.optionalSecrets.join('\n  - ')}`
    );
  }

  // Note required tools in warnings
  if (template.dependencies.tools.length > 0) {
    warnings.push(
      `This workflow requires the following CLI tools:\n  - ${template.dependencies.tools.join('\n  - ')}\nPlease install them manually.`
    );
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}
