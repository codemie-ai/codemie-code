import chalk from 'chalk';
import { ConfigLoader } from './config-loader.js';
import { AgentRegistry, BUILTIN_AGENT_NAME } from '../agents/registry.js';
import type { AgentAdapter } from '../agents/core/types.js';

/**
 * First-time user experience utilities
 */
export class FirstTimeExperience {

  /**
   * Get all agents split into built-in and external
   */
  private static getAgents(): { builtIn: AgentAdapter | undefined; external: AgentAdapter[] } {
    const allAgents = AgentRegistry.getAllAgents();
    return {
      builtIn: allAgents.find(agent => agent.name === BUILTIN_AGENT_NAME),
      external: allAgents.filter(agent => agent.name !== BUILTIN_AGENT_NAME)
    };
  }
  /**
   * Check if this is a first-time run (no configuration exists)
   */
  static async isFirstTime(): Promise<boolean> {
    const hasGlobalConfig = await ConfigLoader.hasGlobalConfig();

    // Also check if essential environment variables are set
    const hasEnvVars = !!(
      process.env.CODEMIE_BASE_URL &&
      process.env.CODEMIE_API_KEY &&
      process.env.CODEMIE_MODEL
    );

    return !hasGlobalConfig && !hasEnvVars;
  }

  /**
   * Show first-time user welcome message with recommendations
   */
  static async showWelcomeMessage(): Promise<void> {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║                                                       ║'));
    console.log(chalk.bold.cyan('║        Welcome to CodeMie Code! 🎉                    ║'));
    console.log(chalk.bold.cyan('║                                                       ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════╝\n'));

    console.log(chalk.white("It looks like this is your first time using CodeMie Code."));
    console.log(chalk.white("Let's get you set up!\n"));

    this.showRecommendations();
  }

  /**
   * Show recommendations and next steps
   */
  static showRecommendations(): void {
    console.log(chalk.bold('📋 Getting Started:\n'));

    console.log(chalk.cyan('Step 1: Choose Your Setup Method\n'));

    console.log(chalk.white('  $ ') + chalk.green('codemie setup'));
    console.log(chalk.white('  → Guided configuration for all providers'));
    console.log(chalk.white('  → Tests connection before saving'));
    console.log(chalk.white('  → Supports: AI/Run CodeMie, AWS Bedrock, Azure\n'));

    console.log(chalk.cyan('Step 2: Verify Configuration\n'));
    console.log(chalk.white('  $ ') + chalk.green('codemie doctor'));
    console.log(chalk.white('  → Checks system health'));
    console.log(chalk.white('  → Tests AI provider connection'));
    console.log(chalk.white('  → Shows installed agents\n'));

    console.log(chalk.cyan('Step 3: Install and Run Agents\n'));
    console.log(chalk.white('  $ ') + chalk.green('codemie list') + chalk.white('             # See all available agents'));

    const { external } = this.getAgents();

    external.forEach(agent => {
      const installCmd = `codemie install ${agent.name}`.padEnd(30);
      console.log(chalk.white('  $ ') + chalk.green(installCmd) + chalk.white(`# Install ${agent.displayName}`));
    });

    external.forEach(agent => {
      // Handle special case where agent name already includes 'codemie-' prefix
      const command = agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`;
      const runCmd = command.padEnd(30);
      console.log(chalk.white('  $ ') + chalk.green(runCmd) + chalk.white(`# Run ${agent.displayName}`));
    });

    console.log();

    console.log(chalk.bold('CI/CD Workflows:'));
    console.log(chalk.white('  $ ') + chalk.green('codemie workflow') + chalk.white('        # Manage CI/CD workflows\n'));

    console.log(chalk.bold('📚 Additional Resources:\n'));
    console.log(chalk.white('   • Documentation: ') + chalk.blue('README.md'));

    const allAgents = AgentRegistry.getAllAgents();
    const agentShortcuts = allAgents.map(agent =>
      agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`
    ).join(', ');
    console.log(chalk.white('   • Agent shortcuts: ') + chalk.green(agentShortcuts));

    console.log(chalk.white('   • Configuration: ') + chalk.green('codemie config --help'));
    console.log(chalk.white('   • Workflows: ') + chalk.green('codemie workflow --help\n'));
  }

  /**
   * Show quick start guide for users who have configuration
   */
  static showQuickStart(): void {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║         CodeMie CLI Wrapper           ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

    console.log(chalk.bold('Quick Start:\n'));

    console.log(chalk.bold('Setup & Configuration:'));
    console.log(chalk.cyan('  codemie setup') + chalk.white('             # Interactive setup wizard'));
    console.log(chalk.cyan('  codemie config') + chalk.white('            # Manage configuration'));

    console.log(chalk.bold('Verify:'));
    console.log(chalk.cyan('  codemie doctor') + chalk.white('            # Check configuration\n'));

    this.showAgentSections();

    console.log(chalk.bold('CI/CD Workflows:'));
    console.log(chalk.cyan('  codemie workflow') + chalk.white('        # Manage CI/CD workflows\n'));

    console.log(chalk.white('For detailed help, run: ') + chalk.green('codemie --help\n'));
  }

  /**
   * Dynamically generate agent sections from registry
   */
  private static showAgentSections(): void {
    const { external } = this.getAgents();

    if (external.length > 0) {
      console.log(chalk.bold('Manage Agents:'));
      console.log(chalk.cyan('  codemie list') + chalk.white('              # List available agents'));

      external.forEach(agent => {
        const paddedCommand = `codemie install ${agent.name}`.padEnd(28);
        console.log(chalk.cyan(`  ${paddedCommand}`) + chalk.white(`# Install ${agent.displayName}`));
      });

      console.log(chalk.cyan('  codemie uninstall <agent>') + chalk.white('  # Remove an agent\n'));
    }

    console.log(chalk.bold('Run Agents:'));

    const allAgents = AgentRegistry.getAllAgents();
    allAgents.forEach(agent => {
      // Handle special case where agent name already includes 'codemie-' prefix
      const command = agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`;
      const paddedCommand = command.padEnd(28);
      console.log(chalk.cyan(`  ${paddedCommand}`) + chalk.white(`# Run ${agent.displayName}`));
    });

    console.log();
  }

  /**
   * Show a friendly reminder to complete setup
   */
  static showSetupReminder(): void {
    console.log(chalk.yellow('\n⚠️  Configuration needed!'));
    console.log(chalk.white('   Run ') + chalk.green('codemie setup') + chalk.white(' to configure your AI provider\n'));
  }

  /**
   * Show post-setup success message
   */
  static showPostSetupMessage(): void {
    console.log(chalk.bold.green('\n✅ You\'re all set!\n'));
    console.log(chalk.bold('Next Steps:\n'));

    const { builtIn, external } = this.getAgents();

    if (builtIn) {
      console.log(chalk.cyan('1. Try the built-in agent:'));
      console.log(chalk.white('   $ ') + chalk.green('codemie-code --task "explore current repository"'));
      console.log(chalk.white('   Or start interactive mode:'));
      console.log(chalk.white('   $ ') + chalk.green('codemie-code') + chalk.white('               # Interactive session\n'));
    }

    console.log(chalk.cyan('2. Verify your configuration:'));
    console.log(chalk.white('   $ ') + chalk.green('codemie doctor') + chalk.white('              # Check system health\n'));

    if (external.length > 0) {
      console.log(chalk.cyan('3. Install additional agents:'));

      external.forEach(agent => {
        const installCmd = `codemie install ${agent.name}`.padEnd(35);
        // Handle special case where agent name already includes 'codemie-' prefix
        const command = agent.name.startsWith('codemie-') ? agent.name : `codemie-${agent.name}`;
        const runCmd = command.padEnd(35);

        console.log(chalk.white('   $ ') + chalk.green(installCmd) + chalk.white(`# Install ${agent.displayName}`));
        console.log(chalk.white('   $ ') + chalk.green(runCmd) + chalk.white(`# Run ${agent.displayName}`));
      });

      console.log();
    }
  }

  /**
   * Show manual setup guide with all required environment variables
   */
  static showManualSetup(provider: 'litellm' | 'bedrock' | 'azure' = 'litellm'): void {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║          Manual Configuration Guide                   ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════╝\n'));

    console.log(chalk.bold('Required Environment Variables:\n'));

    switch (provider) {
      case 'litellm':
        console.log(chalk.white('CODEMIE_BASE_URL') + chalk.white('      = ') + chalk.cyan('"https://litellm.example.com"'));
        console.log(chalk.white('CODEMIE_API_KEY') + chalk.white('       = ') + chalk.cyan('"your-litellm-api-key"'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.white('         = ') + chalk.cyan('"claude-4-5-sonnet"'));
        console.log();
        console.log(chalk.bold('Optional Environment Variables:\n'));
        console.log(chalk.white('CODEMIE_PROVIDER') + chalk.white('      = ') + chalk.cyan('"litellm"'));
        console.log(chalk.white('  Controls which environment variables are passed to agents'));
        console.log(chalk.white('  Options: litellm (default), azure, bedrock, openai\n'));
        break;

      case 'bedrock':
        console.log(chalk.bold.white('Step 1: AWS Credentials (choose one method):\n'));
        console.log(chalk.white('Method A: AWS CLI (Recommended)'));
        console.log(chalk.white('  $ ') + chalk.green('aws configure'));
        console.log(chalk.white('  Enter AWS Access Key ID: ') + chalk.cyan('AKIAIOSFODNN7EXAMPLE'));
        console.log(chalk.white('  Enter AWS Secret Access Key: ') + chalk.cyan('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
        console.log(chalk.white('  Enter Default region: ') + chalk.cyan('us-west-2\n'));

        console.log(chalk.white('Method B: Environment Variables'));
        console.log(chalk.white('AWS_ACCESS_KEY_ID') + chalk.white('         = ') + chalk.cyan('"AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.white('AWS_SECRET_ACCESS_KEY') + chalk.white('     = ') + chalk.cyan('"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.white('AWS_REGION') + chalk.white('                = ') + chalk.cyan('"us-west-2"\n'));

        console.log(chalk.bold.white('Step 2: Bedrock Configuration:\n'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.white('           = ') + chalk.cyan('"us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.white('CLAUDE_CODE_USE_BEDROCK') + chalk.white('   = ') + chalk.cyan('1'));
        console.log(chalk.white('AWS_PROFILE') + chalk.white('               = ') + chalk.cyan('"default"') + chalk.white(' (optional if using CLI)\n'));
        break;

      case 'azure':
        console.log(chalk.white('CODEMIE_BASE_URL') + chalk.white('      = ') + chalk.cyan('"https://your-resource.openai.azure.com"'));
        console.log(chalk.white('CODEMIE_API_KEY') + chalk.white('       = ') + chalk.cyan('"your-azure-api-key"'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.white('         = ') + chalk.cyan('"gpt-4"') + chalk.white(' or ') + chalk.cyan('"codex"'));
        console.log();
        console.log(chalk.bold('Optional Environment Variables:\n'));
        console.log(chalk.white('CODEMIE_PROVIDER') + chalk.white('      = ') + chalk.cyan('"azure"'));
        console.log(chalk.white('  Controls which environment variables are passed to agents'));
        console.log(chalk.white('  Options: litellm (default), azure, bedrock, openai\n'));
        break;
    }

    console.log(chalk.bold('Setup Commands:\n'));
    console.log(chalk.white('# Export variables (current session only)'));

    switch (provider) {
      case 'litellm':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://litellm.example.com"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-litellm-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-4-5-sonnet"'));
        break;

      case 'bedrock':
        console.log(chalk.green('export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.green('export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.green('export AWS_REGION="us-west-2"'));
        console.log(chalk.green('export CODEMIE_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.green('export CLAUDE_CODE_USE_BEDROCK=1'));
        break;

      case 'azure':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://your-resource.openai.azure.com"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-azure-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="gpt-4"'));
        break;
    }

    console.log();
    console.log(chalk.white('# Add to shell profile for persistence (choose your shell)'));
    console.log(chalk.green('# For Bash:'));
    console.log(chalk.green('cat >> ~/.bashrc << EOF'));

    switch (provider) {
      case 'litellm':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://litellm.example.com"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-litellm-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-4-5-sonnet"'));
        break;

      case 'bedrock':
        console.log(chalk.green('export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.green('export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.green('export AWS_REGION="us-west-2"'));
        console.log(chalk.green('export CODEMIE_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.green('export CLAUDE_CODE_USE_BEDROCK=1'));
        break;

      case 'azure':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://your-resource.openai.azure.com"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-azure-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="gpt-4"'));
        break;
    }

    console.log(chalk.green('EOF'));
    console.log(chalk.green('source ~/.bashrc'));
    console.log();
    console.log(chalk.green('# For Zsh:'));
    console.log(chalk.green('# Replace ~/.bashrc with ~/.zshrc in commands above\n'));

    console.log(chalk.bold('Verification:\n'));
    console.log(chalk.white('  $ ') + chalk.green('codemie doctor') + chalk.white('              # Check configuration and test connection'));

    const { builtIn, external } = this.getAgents();

    if (builtIn) {
      console.log(chalk.white('  $ ') + chalk.green('codemie-code --task "explore current repository"'));
      console.log(chalk.white('     Or start interactive:'));
      console.log(chalk.white('  $ ') + chalk.green('codemie-code') + chalk.white('                # Run built-in agent'));
    }

    if (external.length > 0) {
      const firstExternal = external[0];
      const installCmd = `codemie install ${firstExternal.name}`.padEnd(35);
      // Handle special case where agent name already includes 'codemie-' prefix
      const command = firstExternal.name.startsWith('codemie-') ? firstExternal.name : `codemie-${firstExternal.name}`;
      const runCmd = command.padEnd(35);

      console.log(chalk.white('  $ ') + chalk.green(installCmd) + chalk.white(`# Install ${firstExternal.displayName}`));
      console.log(chalk.white('  $ ') + chalk.green(runCmd) + chalk.white(`# Run ${firstExternal.displayName}\n`));
    }

    console.log(chalk.white('Need help? Run: ') + chalk.green('codemie --help\n'));
  }
}
