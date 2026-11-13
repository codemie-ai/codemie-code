import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

// Initialize provider plugins (triggers auto-registration)
import '../providers/index.js';

// Initialize framework plugins (triggers auto-registration)
import '../frameworks/plugins/index.js';

import { createListCommand } from './commands/list.js';
import { createInstallCommand } from './commands/install.js';
import { createUninstallCommand } from './commands/uninstall.js';
import { createUpdateCommand } from './commands/update.js';
import { createSelfUpdateCommand } from './commands/self-update.js';
import { createDoctorCommand } from './commands/doctor/index.js';
import { createVersionCommand } from './commands/version.js';
import { createSetupCommand } from './commands/setup.js';
import { createWorkflowCommand } from './commands/workflow.js';
import { createProfileCommand } from './commands/profile/index.js';
import { createAnalyticsCommand } from './commands/analytics/index.js';
import { createLogCommand } from './commands/log/index.js';
import { createHookCommand } from './commands/hook.js';
import { createSoundCommand } from './commands/sound.js';
import { createSkillCommand } from './commands/skill.js';
import { createSkillsCommand } from './commands/skills/index.js';
import { createPluginCommand } from './commands/plugin.js';
import { createOpencodeMetricsCommand } from './commands/opencode-metrics.js';
import { createTestMetricsCommand } from './commands/test-metrics.js';
import { createModelsCommand } from './commands/models.js';
import { createAssistantsCommand } from './commands/assistants/index.js';
import { createSdkCommand } from './commands/sdk/index.js';
import { createMcpCommand } from './commands/mcp/index.js';
import { createMcpProxyCommand } from './commands/mcp-proxy.js';
import { createProxyCommand } from './commands/proxy/index.js';
import { createCodebaseCommand } from './commands/codebase/index.js';
import { createDocsCommand } from './commands/docs.js';
import { createTipsCommand } from './commands/tips.js';
import { createWhatsnewCommand } from './commands/whatsnew.js';
import { getDirname } from '../utils/paths.js';

export function createProgram(): Command {
  const program = new Command();
  // Read version from package.json
  let version = '1.0.0';
  try {
    const packageJsonPath = join(getDirname(import.meta.url), '../../package.json');
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent) as { version: string };
    version = packageJson.version;
  } catch {
    // Use default version if unable to read
  }

  program
    .name('codemie')
    .description('AI/Run CodeMie CLI - Professional CLI wrapper for managing multiple AI coding agents')
    .version(version)
    .option('--task <task>', 'Execute a single task using the built-in agent and exit');

  program.addHelpText('after', `
Claude Desktop 3P:
  codemie proxy connect --claude-desktop      Connect Claude Desktop through CodeMie proxy
  codemie proxy inspect desktop               Inspect Desktop proxy state, sessions, and sync
  codemie proxy stop                          Stop the local proxy daemon
  codemie codebase ui                         Start and open Codebase Memory graph UI

VS Code BYOK:
  codemie proxy connect --vscode              Configure stable VS Code through CodeMie proxy
  codemie proxy connect --vscode --insiders   Configure VS Code Insiders through CodeMie proxy

Profile selection:
  Uses the active CodeMie profile by default.
  Override for one run with: codemie proxy connect <--claude-desktop|--vscode> --profile <name>
`);

  // Add commands
  program.addCommand(createSetupCommand());
  program.addCommand(createProfileCommand());
  program.addCommand(createAssistantsCommand());
  program.addCommand(createListCommand());
  program.addCommand(createInstallCommand());
  program.addCommand(createUninstallCommand());
  program.addCommand(createUpdateCommand());
  program.addCommand(createSelfUpdateCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createVersionCommand());
  program.addCommand(createWorkflowCommand());
  program.addCommand(createAnalyticsCommand());
  program.addCommand(createLogCommand());
  program.addCommand(createHookCommand());
  program.addCommand(createSoundCommand());
  program.addCommand(createSkillCommand());
  program.addCommand(createSkillsCommand());
  program.addCommand(createPluginCommand());
  program.addCommand(createOpencodeMetricsCommand());
  program.addCommand(createTestMetricsCommand());
  program.addCommand(createModelsCommand());
  program.addCommand(createSdkCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createMcpProxyCommand());
  program.addCommand(createProxyCommand());
  program.addCommand(createCodebaseCommand());
  program.addCommand(createDocsCommand());
  program.addCommand(createTipsCommand());
  program.addCommand(createWhatsnewCommand());
  return program;
}
