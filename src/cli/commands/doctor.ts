import { Command } from 'commander';
import { tipDisplay } from '../../utils/tips.js';
import { exec } from '../../utils/exec.js';
import chalk from 'chalk';
import ora from 'ora';
import { AgentRegistry } from '../../agents/registry.js';
import { ConfigLoader } from '../../utils/config-loader.js';
import { checkProviderHealth } from '../../utils/health-checker.js';
import { fetchAvailableModels } from '../../utils/model-fetcher.js';

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

      // Check git
      console.log(chalk.bold('git:'));
      try {
        const result = await exec('git', ['--version']);
        console.log(`  ${chalk.green('✓')} ${result.stdout}`);
      } catch {
        console.log(`  ${chalk.yellow('⚠')} git not found (optional)`);
      }
      console.log();

      // Check AI Configuration
      console.log(chalk.bold('AI Configuration:'));

      let config;
      try {
        config = await ConfigLoader.load();

        if (config.provider) {
          console.log(`  ${chalk.green('✓')} Provider: ${config.provider}`);
        }
        if (config.baseUrl) {
          console.log(`  ${chalk.green('✓')} Base URL: ${config.baseUrl}`);
        }
        if (config.apiKey) {
          const masked = config.apiKey.substring(0, 8) + '***' + config.apiKey.substring(config.apiKey.length - 4);
          console.log(`  ${chalk.green('✓')} API Key: ${masked}`);
        }
        if (config.model) {
          console.log(`  ${chalk.green('✓')} Model: ${config.model}`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`  ${chalk.red('✗')} Configuration error: ${errorMessage}`);
        console.log(`      ${chalk.dim('Run: codemie setup')}`);
        hasIssues = true;
      }

      console.log();

      // Test connectivity if config is valid
      if (config && config.baseUrl && config.apiKey && config.model) {
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
