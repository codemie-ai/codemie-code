import chalk from 'chalk';
import { ConfigLoader } from './config-loader.js';

/**
 * First-time user experience utilities
 */
export class FirstTimeExperience {
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

    console.log(chalk.dim("It looks like this is your first time using CodeMie Code."));
    console.log(chalk.dim("Let's get you set up!\n"));

    this.showRecommendations();
  }

  /**
   * Show recommendations and next steps
   */
  static showRecommendations(): void {
    console.log(chalk.bold('📋 Getting Started:\n'));

    console.log(chalk.cyan('Step 1: Choose Your Setup Method\n'));

    console.log(chalk.bold('  Option A: Interactive Setup Wizard (Recommended)'));
    console.log(chalk.white('  $ ') + chalk.green('codemie setup'));
    console.log(chalk.dim('  → Guided configuration for all providers'));
    console.log(chalk.dim('  → Tests connection before saving'));
    console.log(chalk.dim('  → Supports: AI/Run CodeMie, AWS Bedrock, Anthropic, Azure\n'));

    console.log(chalk.bold('  Option B: Manual Configuration Guide'));
    console.log(chalk.white('  $ ') + chalk.green('codemie env [provider]') + chalk.dim('  # Show all required env vars'));
    console.log(chalk.dim('  → Complete environment variable list'));
    console.log(chalk.dim('  → Copy-paste ready commands'));
    console.log(chalk.dim('  → Providers: ai-run (default), bedrock, anthropic, azure\n'));

    console.log(chalk.cyan('Step 2: Verify Configuration\n'));
    console.log(chalk.white('  $ ') + chalk.green('codemie doctor'));
    console.log(chalk.dim('  → Checks system health'));
    console.log(chalk.dim('  → Tests AI provider connection'));
    console.log(chalk.dim('  → Shows installed agents\n'));

    console.log(chalk.cyan('Step 3: Start Using CodeMie\n'));
    console.log(chalk.bold('  Built-in Assistant (Ready to use):'));
    console.log(chalk.white('  $ ') + chalk.green('codemie-code') + chalk.dim('              # Start interactive AI assistant'));
    console.log(chalk.white('  $ ') + chalk.green('codemie run codemie-code') + chalk.dim(' # Alternative way to run\n'));

    console.log(chalk.bold('  External Agents (Optional):'));
    console.log(chalk.white('  $ ') + chalk.green('codemie list') + chalk.dim('             # See all available agents'));
    console.log(chalk.white('  $ ') + chalk.green('codemie install claude') + chalk.dim('      # Install Anthropic Claude Code'));
    console.log(chalk.white('  $ ') + chalk.green('codemie install codex') + chalk.dim('       # Install OpenAI Codex'));
    console.log(chalk.white('  $ ') + chalk.green('codemie run <agent>') + chalk.dim('        # Run installed agent\n'));

    console.log(chalk.bold('📚 Additional Resources:\n'));
    console.log(chalk.dim('   • Documentation: ') + chalk.blue('README.md'));
    console.log(chalk.dim('   • Agent management: ') + chalk.green('codemie list, install, uninstall, run'));
    console.log(chalk.dim('   • Configuration help: ') + chalk.green('codemie config --help'));
    console.log(chalk.dim('   • MCP servers: ') + chalk.green('codemie-code mcp --help\n'));
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
    console.log(chalk.cyan('  codemie setup') + chalk.dim('             # Interactive setup wizard'));
    console.log(chalk.cyan('  codemie env [provider]') + chalk.dim('    # Show manual setup guide'));
    console.log(chalk.cyan('  codemie config show') + chalk.dim('        # View current configuration'));
    console.log(chalk.cyan('  codemie config edit <key>') + chalk.dim('  # Update a config value\n'));

    console.log(chalk.bold('Verify:'));
    console.log(chalk.cyan('  codemie doctor') + chalk.dim('            # Check configuration\n'));

    console.log(chalk.bold('Use Built-in Assistant:'));
    console.log(chalk.cyan('  codemie-code') + chalk.dim('              # Start CodeMie Code assistant\n'));

    console.log(chalk.bold('Manage External Agents:'));
    console.log(chalk.cyan('  codemie list') + chalk.dim('              # List available agents'));
    console.log(chalk.cyan('  codemie install <agent>') + chalk.dim('   # Install: claude, codex'));
    console.log(chalk.cyan('  codemie uninstall <agent>') + chalk.dim(' # Uninstall: claude, codex'));
    console.log(chalk.cyan('  codemie run <agent>') + chalk.dim('       # Run an agent\n'));

    console.log(chalk.dim('For detailed help, run: ') + chalk.green('codemie --help\n'));
  }

  /**
   * Show a friendly reminder to complete setup
   */
  static showSetupReminder(): void {
    console.log(chalk.yellow('\n⚠️  Configuration needed!'));
    console.log(chalk.dim('   Run ') + chalk.green('codemie setup') + chalk.dim(' to configure your AI provider\n'));
  }

  /**
   * Show post-setup success message
   */
  static showPostSetupMessage(): void {
    console.log(chalk.bold.green('\n✅ You\'re all set!\n'));
    console.log(chalk.bold('Next Steps:\n'));

    console.log(chalk.cyan('1. Start the built-in AI assistant:'));
    console.log(chalk.white('   $ ') + chalk.green('codemie-code') + chalk.dim('         # Interactive AI coding assistant\n'));

    console.log(chalk.cyan('2. Verify your configuration:'));
    console.log(chalk.white('   $ ') + chalk.green('codemie doctor') + chalk.dim('       # Check system health\n'));

    console.log(chalk.cyan('3. (Optional) Install external agents:'));
    console.log(chalk.white('   $ ') + chalk.green('codemie list') + chalk.dim('          # See available agents'));
    console.log(chalk.white('   $ ') + chalk.green('codemie install claude') + chalk.dim('  # Install Anthropic Claude Code'));
    console.log(chalk.white('   $ ') + chalk.green('codemie install codex') + chalk.dim('   # Install OpenAI Codex\n'));

    console.log(chalk.dim('💡 Tip: You can also use ') + chalk.green('codemie run codemie-code') + chalk.dim(' to start the assistant\n'));
  }

  /**
   * Show manual setup guide with all required environment variables
   */
  static showManualSetup(provider: 'ai-run' | 'bedrock' | 'anthropic' | 'azure' = 'ai-run'): void {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║          Manual Configuration Guide                   ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════╝\n'));

    console.log(chalk.bold('Required Environment Variables:\n'));

    switch (provider) {
      case 'ai-run':
        console.log(chalk.white('CODEMIE_BASE_URL') + chalk.dim('      = ') + chalk.cyan('"https://ai.run/api/v1"'));
        console.log(chalk.white('CODEMIE_API_KEY') + chalk.dim('       = ') + chalk.cyan('"your-ai-run-api-key"'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.dim('         = ') + chalk.cyan('"claude-4-5-sonnet"'));
        console.log(chalk.white('CODEMIE_PROVIDER') + chalk.dim('      = ') + chalk.cyan('"ai-run"') + chalk.dim(' (optional)\n'));
        break;

      case 'bedrock':
        console.log(chalk.bold.white('Step 1: AWS Credentials (choose one method):\n'));
        console.log(chalk.dim('Method A: AWS CLI (Recommended)'));
        console.log(chalk.white('  $ ') + chalk.green('aws configure'));
        console.log(chalk.dim('  Enter AWS Access Key ID: ') + chalk.cyan('AKIAIOSFODNN7EXAMPLE'));
        console.log(chalk.dim('  Enter AWS Secret Access Key: ') + chalk.cyan('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
        console.log(chalk.dim('  Enter Default region: ') + chalk.cyan('us-west-2\n'));

        console.log(chalk.dim('Method B: Environment Variables'));
        console.log(chalk.white('AWS_ACCESS_KEY_ID') + chalk.dim('         = ') + chalk.cyan('"AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.white('AWS_SECRET_ACCESS_KEY') + chalk.dim('     = ') + chalk.cyan('"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.white('AWS_REGION') + chalk.dim('                = ') + chalk.cyan('"us-west-2"\n'));

        console.log(chalk.bold.white('Step 2: Bedrock Configuration:\n'));
        console.log(chalk.white('ANTHROPIC_MODEL') + chalk.dim('          = ') + chalk.cyan('"us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.white('CLAUDE_CODE_USE_BEDROCK') + chalk.dim('   = ') + chalk.cyan('1'));
        console.log(chalk.white('AWS_PROFILE') + chalk.dim('               = ') + chalk.cyan('"default"') + chalk.dim(' (optional if using CLI)\n'));
        break;

      case 'anthropic':
        console.log(chalk.white('CODEMIE_BASE_URL') + chalk.dim('      = ') + chalk.cyan('"https://api.anthropic.com/v1"'));
        console.log(chalk.white('CODEMIE_API_KEY') + chalk.dim('       = ') + chalk.cyan('"sk-ant-api03-..."'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.dim('         = ') + chalk.cyan('"claude-sonnet-4"'));
        console.log(chalk.white('CODEMIE_PROVIDER') + chalk.dim('      = ') + chalk.cyan('"anthropic"') + chalk.dim(' (optional)\n'));
        break;

      case 'azure':
        console.log(chalk.white('CODEMIE_BASE_URL') + chalk.dim('      = ') + chalk.cyan('"https://your-resource.openai.azure.com"'));
        console.log(chalk.white('CODEMIE_API_KEY') + chalk.dim('       = ') + chalk.cyan('"your-azure-api-key"'));
        console.log(chalk.white('CODEMIE_MODEL') + chalk.dim('         = ') + chalk.cyan('"gpt-4"') + chalk.dim(' or ') + chalk.cyan('"codex"'));
        console.log(chalk.white('CODEMIE_PROVIDER') + chalk.dim('      = ') + chalk.cyan('"azure"') + chalk.dim(' (optional)\n'));
        break;
    }

    console.log(chalk.bold('Setup Commands:\n'));
    console.log(chalk.dim('# Export variables (current session only)'));

    switch (provider) {
      case 'ai-run':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://ai.run/api/v1"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-ai-run-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-4-5-sonnet"'));
        break;

      case 'bedrock':
        console.log(chalk.green('export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.green('export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.green('export AWS_REGION="us-west-2"'));
        console.log(chalk.green('export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.green('export CLAUDE_CODE_USE_BEDROCK=1'));
        break;

      case 'anthropic':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://api.anthropic.com/v1"'));
        console.log(chalk.green('export CODEMIE_API_KEY="sk-ant-api03-..."'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-sonnet-4"'));
        break;

      case 'azure':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://your-resource.openai.azure.com"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-azure-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="gpt-4"'));
        break;
    }

    console.log();
    console.log(chalk.dim('# Add to shell profile for persistence (choose your shell)'));
    console.log(chalk.green('# For Bash:'));
    console.log(chalk.green('cat >> ~/.bashrc << EOF'));

    switch (provider) {
      case 'ai-run':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://ai.run/api/v1"'));
        console.log(chalk.green('export CODEMIE_API_KEY="your-ai-run-api-key"'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-4-5-sonnet"'));
        break;

      case 'bedrock':
        console.log(chalk.green('export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"'));
        console.log(chalk.green('export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'));
        console.log(chalk.green('export AWS_REGION="us-west-2"'));
        console.log(chalk.green('export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"'));
        console.log(chalk.green('export CLAUDE_CODE_USE_BEDROCK=1'));
        break;

      case 'anthropic':
        console.log(chalk.green('export CODEMIE_BASE_URL="https://api.anthropic.com/v1"'));
        console.log(chalk.green('export CODEMIE_API_KEY="sk-ant-api03-..."'));
        console.log(chalk.green('export CODEMIE_MODEL="claude-sonnet-4"'));
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
    console.log(chalk.white('  $ ') + chalk.green('codemie doctor') + chalk.dim('   # Check configuration and test connection'));
    console.log(chalk.white('  $ ') + chalk.green('codemie-code') + chalk.dim('     # Start the AI assistant\n'));

    console.log(chalk.dim('Need help? Run: ') + chalk.green('codemie --help\n'));
  }
}
