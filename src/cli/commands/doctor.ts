import { Command } from 'commander';
import { tipDisplay } from '../../utils/tips';
import { exec } from '../../utils/exec';
import chalk from 'chalk';
import ora from 'ora';
import { AgentRegistry } from '../../agents/registry';
import { ConfigLoader } from '../../utils/config-loader.js';
import { ChatOpenAI } from '@langchain/openai';

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
        const spinner = ora('Testing connection...').start();

        try {
          const llm = new ChatOpenAI({
            modelName: config.model,
            configuration: {
              baseURL: config.baseUrl,
              apiKey: config.apiKey
            },
            timeout: (config.timeout || 300) * 1000,
            maxRetries: 1
          });

          const startTime = Date.now();
          const response = await llm.invoke('Say "test successful"');
          const duration = Date.now() - startTime;

          if (!response || !response.content) {
            throw new Error('Empty response from model');
          }

          spinner.succeed(chalk.green(`Connection successful`));
          console.log(`  ${chalk.dim('Response time:')} ${duration}ms`);
          console.log(`  ${chalk.dim('Model response:')} ${response.content}`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          spinner.fail(chalk.red('Connection test failed'));
          console.log(`  ${chalk.dim('Error:')} ${errorMessage}`);
          hasIssues = true;
        }

        console.log();
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
