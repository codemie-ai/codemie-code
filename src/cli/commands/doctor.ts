import { Command } from 'commander';
import { tipDisplay } from '../../utils/tips.js';
import { exec } from '../../utils/exec.js';
import chalk from 'chalk';
import ora from 'ora';
import { AgentRegistry } from '../../agents/registry.js';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { checkProviderHealth } from '../../utils/health-checker.js';
import { fetchAvailableModels } from '../../utils/model-fetcher.js';
import { CodeMieSSO } from '../../utils/sso-auth.js';
import { fetchCodeMieModelsFromConfig, validateCodeMieConnectivity } from '../../utils/codemie-model-fetcher.js';
import { checkAllTools } from '../../tools/index.js';
import { detectVCSProvider, listInstalledWorkflows } from '../../workflows/index.js';

export function createDoctorCommand(): Command {
  const command = new Command('doctor');

  command
    .description('Check system health and configuration')
    .action(async () => {
      console.log(chalk.bold('\n🔍 CodeMie Code Health Check\n'));

      let hasIssues = false;

      // Check Node.js version
      console.log(chalk.bold('Node.js:'));
      try {
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

        if (majorVersion >= 18) {
          console.log(`  ${chalk.green('✓')} Version ${nodeVersion}`);
        } else {
          console.log(`  ${chalk.yellow('⚠')} Version ${nodeVersion} (recommended: >= 18.0.0)`);
          hasIssues = true;
        }
      } catch {
        console.log(`  ${chalk.red('✗')} Failed to check version`);
        hasIssues = true;
      }
      console.log();

      // Check npm
      console.log(chalk.bold('npm:'));
      try {
        const result = await exec('npm', ['--version']);
        console.log(`  ${chalk.green('✓')} Version ${result.stdout}`);
      } catch {
        console.log(`  ${chalk.red('✗')} npm not found`);
        hasIssues = true;
      }
      console.log();

      // Check AI Configuration
      console.log(chalk.bold('AI Configuration:'));

      let config;
      try {
        config = await ConfigLoader.load();

        // Check if config is empty or missing required fields
        const hasProvider = !!config.provider;
        const hasBaseUrl = !!config.baseUrl;
        const hasApiKey = !!config.apiKey;
        const hasModel = !!config.model;

        if (hasProvider) {
          console.log(`  ${chalk.green('✓')} Provider: ${config.provider}`);
        } else {
          console.log(`  ${chalk.red('✗')} Provider not configured`);
          hasIssues = true;
        }

        if (hasBaseUrl) {
          console.log(`  ${chalk.green('✓')} Base URL: ${config.baseUrl}`);
        } else {
          console.log(`  ${chalk.red('✗')} Base URL not configured`);
          hasIssues = true;
        }

        if (hasApiKey) {
          const masked = config.apiKey.substring(0, 8) + '***' + config.apiKey.substring(config.apiKey.length - 4);
          console.log(`  ${chalk.green('✓')} API Key: ${masked}`);
        } else {
          console.log(`  ${chalk.red('✗')} API Key not configured`);
          hasIssues = true;
        }

        if (hasModel) {
          console.log(`  ${chalk.green('✓')} Model: ${config.model}`);
        } else {
          console.log(`  ${chalk.red('✗')} Model not configured`);
          hasIssues = true;
        }

        // Show setup instructions if config is incomplete
        if (!hasProvider || !hasBaseUrl || !hasApiKey || !hasModel) {
          console.log(`      ${chalk.dim('Run: codemie setup')}`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`  ${chalk.red('✗')} Configuration error: ${errorMessage}`);
        console.log(`      ${chalk.dim('Run: codemie setup')}`);
        hasIssues = true;
      }

      console.log();

      // Check SSO Configuration if provider is ai-run-sso
      if (config && config.provider === 'ai-run-sso') {
        await checkSSOConfiguration(config);
      }

      // Test connectivity if config is valid (skip for ai-run-sso as it has its own validation)
      if (config && config.baseUrl && config.apiKey && config.model && config.provider !== 'ai-run-sso') {
        console.log(chalk.bold('Connectivity Test:'));
        const healthSpinner = ora('Validating credentials and endpoint...').start();

        try {
          const startTime = Date.now();
          const result = await checkProviderHealth(config.baseUrl, config.apiKey);
          const duration = Date.now() - startTime;

          if (!result.success) {
            throw new Error(result.message);
          }

          healthSpinner.succeed(chalk.green(`Credentials validated`));
          console.log(`  ${chalk.dim('Response time:')} ${duration}ms`);
          console.log(`  ${chalk.dim('Status:')} ${result.message}`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          healthSpinner.fail(chalk.red('Connection test failed'));
          console.log(`  ${chalk.dim('Error:')} ${errorMessage}`);
          hasIssues = true;
        }

        console.log();

        // Fetch and verify models
        if (config.provider !== 'bedrock') {
          console.log(chalk.bold('Model Verification:'));
          const modelsSpinner = ora('Fetching available models...').start();

          try {
            const availableModels = await fetchAvailableModels({
              provider: config.provider,
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              model: config.model,
              timeout: config.timeout || 300
            });

            if (availableModels.length > 0) {
              modelsSpinner.succeed(chalk.green(`Found ${availableModels.length} available models`));

              // Check if configured model exists
              const configuredModel = config.model;
              const modelExists = availableModels.includes(configuredModel);

              if (modelExists) {
                console.log(`  ${chalk.green('✓')} Configured model '${configuredModel}' is available`);
              } else {
                console.log(`  ${chalk.yellow('⚠')} Configured model '${configuredModel}' not found in available models`);
                console.log(`  ${chalk.dim('Available models:')} ${availableModels.slice(0, 5).join(', ')}${availableModels.length > 5 ? '...' : ''}`);
                hasIssues = true;
              }
            } else {
              modelsSpinner.warn(chalk.yellow('Could not fetch models from provider'));
              console.log(`  ${chalk.dim('Using configured model:')} ${config.model}`);
            }
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            modelsSpinner.warn(chalk.yellow('Model verification skipped'));
            console.log(`  ${chalk.dim('Error:')} ${errorMessage}`);
          }

          console.log();
        }
      }

      // Check installed agents
      console.log(chalk.bold('Installed Agents:'));
      const installedAgents = await AgentRegistry.getInstalledAgents();

      if (installedAgents.length > 0) {
        for (const agent of installedAgents) {
          const version = await agent.getVersion();
          const versionStr = version ? ` (${version})` : '';
          console.log(`  ${chalk.green('✓')} ${agent.displayName}${versionStr}`);
        }
      } else {
        console.log(`  ${chalk.yellow('⚠')} No agents installed (CodeMie Code is built-in)`);
      }
      console.log();

      // Check VCS Tools
      console.log(chalk.bold('VCS Tools:'));
      const toolsStatus = checkAllTools();

      // Show git first
      if (toolsStatus.git.installed) {
        console.log(`  ${chalk.green('✓')} Git v${toolsStatus.git.version}`);
      } else {
        console.log(`  ${chalk.yellow('⚠')} Git not installed`);
      }

      if (toolsStatus.gh.installed) {
        const authStatus = toolsStatus.gh.authenticated
          ? chalk.green(`authenticated as ${toolsStatus.gh.authUser}`)
          : chalk.yellow('not authenticated');
        console.log(`  ${chalk.green('✓')} GitHub CLI (gh) v${toolsStatus.gh.version} - ${authStatus}`);
      } else {
        console.log(`  ${chalk.dim('○')} GitHub CLI (gh) not installed`);
        console.log(`      ${chalk.dim('Install with: codemie tools install gh')}`);
      }

      if (toolsStatus.glab.installed) {
        const authStatus = toolsStatus.glab.authenticated
          ? chalk.green(`authenticated as ${toolsStatus.glab.authUser}`)
          : chalk.yellow('not authenticated');
        console.log(`  ${chalk.green('✓')} GitLab CLI (glab) v${toolsStatus.glab.version} - ${authStatus}`);
      } else {
        console.log(`  ${chalk.dim('○')} GitLab CLI (glab) not installed`);
        console.log(`      ${chalk.dim('Install with: codemie tools install glab')}`);
      }
      console.log();

      // Check VCS and Workflows
      console.log(chalk.bold('Repository & Workflows:'));
      const vcsDetection = detectVCSProvider();

      if (vcsDetection.isGitRepo) {
        console.log(`  ${chalk.green('✓')} Git repository detected`);

        if (vcsDetection.provider) {
          console.log(`  ${chalk.green('✓')} Provider: ${vcsDetection.provider}`);
          console.log(`      ${chalk.dim(`Remote: ${vcsDetection.remoteUrl}`)}`);

          // List installed workflows
          const installedWorkflows = listInstalledWorkflows(vcsDetection.provider);
          if (installedWorkflows.length > 0) {
            console.log(`  ${chalk.green('✓')} ${installedWorkflows.length} workflow(s) installed:`);
            installedWorkflows.forEach(workflow => {
              const fileName = workflow.split('/').pop();
              console.log(`      ${chalk.dim('•')} ${fileName}`);
            });
          } else {
            console.log(`  ${chalk.dim('○')} No workflows installed`);
            console.log(`      ${chalk.dim('Install workflows with: codemie workflow install <workflow-id>')}`);
          }
        } else {
          console.log(`  ${chalk.yellow('⚠')} VCS provider not detected`);
          console.log(`      ${chalk.dim('Remote URL:')} ${vcsDetection.remoteUrl || 'none'}`);
        }
      } else {
        console.log(`  ${chalk.dim('○')} Not a git repository`);
      }
      console.log();

      // Summary
      if (hasIssues) {
        console.log(chalk.yellow('⚠ Some issues detected. Please resolve them for optimal performance.\n'));
        process.exit(1);
      } else {
        console.log(chalk.green('✓ All checks passed!\n'));
        // Show a helpful tip after successful health check (unless in assistant context)
        if (!process.env.CODEMIE_IN_ASSISTANT) {
          tipDisplay.showRandomTip();
        }
      }
    });

  return command;
}

async function checkSSOConfiguration(config: CodeMieConfigOptions): Promise<void> {
  console.log(chalk.bold('🔐 SSO Configuration:'));

  // Check CodeMie URL
  if (config.codeMieUrl) {
    console.log(`  ${chalk.green('✓')} CodeMie URL: ${config.codeMieUrl}`);

    const connectivitySpinner = ora('Checking CodeMie server connectivity...').start();
    try {
      await validateCodeMieConnectivity();
      connectivitySpinner.succeed(chalk.green('CodeMie server accessible'));
    } catch (error) {
      connectivitySpinner.fail(chalk.red('CodeMie server not accessible'));
      console.log(`  ${chalk.dim('Error:')} ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log(`  ${chalk.red('✗')} CodeMie URL not configured`);
  }

  // Check SSO credentials
  try {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials();

    if (credentials) {
      console.log(`  ${chalk.green('✓')} SSO credentials stored`);

      // Check expiration
      if (credentials.expiresAt) {
        const expiresIn = Math.max(0, credentials.expiresAt - Date.now());
        if (expiresIn > 0) {
          const hours = Math.floor(expiresIn / (1000 * 60 * 60));
          console.log(`  ${chalk.green('✓')} Session expires in: ${hours} hours`);
        } else {
          console.log(`  ${chalk.red('✗')} SSO session expired`);
          console.log(`      ${chalk.dim('Run: codemie auth refresh')}`);
        }
      }

      // Test API access
      const apiSpinner = ora('Testing API access...').start();
      try {
        const models = await fetchCodeMieModelsFromConfig();
        apiSpinner.succeed(chalk.green(`API access working (${models.length} models available)`));
      } catch (error) {
        apiSpinner.fail(chalk.red('API access failed'));
        console.log(`  ${chalk.dim('Error:')} ${error instanceof Error ? error.message : String(error)}`);

        if (error instanceof Error && error.message.includes('expired')) {
          console.log(`      ${chalk.dim('Run: codemie auth refresh')}`);
        }
      }

    } else {
      console.log(`  ${chalk.red('✗')} SSO credentials not found`);
      console.log(`      ${chalk.dim('Run: codemie auth login')}`);
    }
  } catch (error) {
    console.log(`  ${chalk.red('✗')} Error checking SSO credentials`);
    console.log(`  ${chalk.dim('Error:')} ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log();
}
