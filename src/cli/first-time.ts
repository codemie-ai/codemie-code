import chalk from 'chalk';
import { ConfigLoader } from '../utils/config.js';
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
    console.log(chalk.white('   • Workflows: ') + chalk.green('codemie workflow --help\n'));
  }

  /**
   * Show quick start guide for users who have configuration
   */
  static async showQuickStart(): Promise<void> {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║         CodeMie CLI Wrapper           ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝\n'));

    console.log(chalk.bold('Quick Start:\n'));

    console.log(chalk.bold('Setup & Configuration:'));
    console.log(chalk.cyan('  codemie setup') + chalk.white('             # Interactive setup wizard'));
    console.log(chalk.cyan('  codemie profile') + chalk.white('           # Manage profiles (list, switch, delete)'));
    console.log(chalk.cyan('  codemie profile') + chalk.white('      # Manage SSO authentication\n'));

    console.log(chalk.bold('Verify:'));
    console.log(chalk.cyan('  codemie doctor') + chalk.white('            # Check configuration\n'));

    await this.showAgentSectionsAsync();

    console.log(chalk.bold('Analytics:'));
    console.log(chalk.cyan('  codemie analytics') + chalk.white('         # View usage statistics\n'));

    console.log(chalk.bold('CI/CD Workflows:'));
    console.log(chalk.cyan('  codemie workflow') + chalk.white('          # Manage CI/CD workflows\n'));

    console.log(chalk.white('For detailed help, run: ') + chalk.green('codemie --help\n'));
  }

  /**
   * Dynamically generate agent and framework sections from registries
   */
  private static async showAgentSectionsAsync(): Promise<void> {
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

    // Show frameworks section
    try {
      const { FrameworkRegistry } = await import('../frameworks/index.js');
      const frameworks = FrameworkRegistry.getAllFrameworks();

      if (frameworks.length > 0) {
        console.log(chalk.bold('Manage Frameworks:'));
        console.log(chalk.cyan('  codemie list') + chalk.white('              # List available frameworks'));

        frameworks.forEach(framework => {
          const paddedCommand = `codemie install ${framework.metadata.name}`.padEnd(28);
          console.log(chalk.cyan(`  ${paddedCommand}`) + chalk.white(`# Install ${framework.metadata.displayName}`));
        });

        console.log();
      }
    } catch {
      // Framework registry not available, skip
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

}
