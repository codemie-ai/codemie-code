/**
 * Console output formatter for analytics
 */

import chalk from 'chalk';
import type {
  RootAnalytics,
  ProjectAnalytics,
  BranchAnalytics,
  SessionAnalytics,
  TokenBreakdown,
  ModelStats,
  ToolStats,
  LanguageStats
} from './types.js';

export class AnalyticsFormatter {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Format and display root analytics
   */
  displayRoot(analytics: RootAnalytics): void {
    console.log(chalk.bold.cyan('\n' + '='.repeat(60)));
    console.log(chalk.bold.cyan('ANALYTICS SUMMARY'));
    console.log(chalk.bold.cyan('='.repeat(60)));

    this.displayStats(analytics);

    // Display model distribution
    if (analytics.models.length > 0) {
      console.log(chalk.bold.yellow('\nModels:'));
      this.displayModels(analytics.models);
    }

    // Display tool usage
    if (analytics.tools.length > 0) {
      console.log(chalk.bold.yellow('\nTool Usage:'));
      this.displayTools(analytics.tools);
    }

    // Display language breakdown
    if (this.verbose && analytics.languages.length > 0) {
      console.log(chalk.bold.yellow('\nBy Language:'));
      this.displayLanguages(analytics.languages);
    }

    // Display format breakdown
    if (this.verbose && analytics.formats.length > 0) {
      console.log(chalk.bold.yellow('\nBy Format:'));
      this.displayLanguages(analytics.formats);
    }
  }

  /**
   * Display projects
   */
  displayProjects(projects: ProjectAnalytics[]): void {
    console.log(chalk.bold.cyan('\n' + '-'.repeat(60)));
    console.log(chalk.bold.cyan('PROJECTS'));
    console.log(chalk.bold.cyan('-'.repeat(60)));

    for (const project of projects) {
      this.displayProject(project);
    }
  }

  /**
   * Display a single project
   */
  private displayProject(project: ProjectAnalytics): void {
    console.log(chalk.bold.green(`\n${'='.repeat(60)}`));
    console.log(chalk.bold.green(`PROJECT: ${project.projectPath}`));
    console.log(chalk.bold.green(`${'='.repeat(60)}`));

    this.displayStats(project, '  ');

    // Display model distribution
    if (project.models.length > 0 && !this.verbose) {
      console.log(chalk.yellow('\n  Models:'));
      this.displayModels(project.models, '    ');
    }

    // Display tool usage
    if (project.tools.length > 0 && !this.verbose) {
      console.log(chalk.yellow('\n  Tool Usage:'));
      this.displayTools(project.tools, '    ');
    }

    // Display language breakdown
    if (!this.verbose && project.languages.length > 0) {
      console.log(chalk.yellow('\n  By Language:'));
      this.displayLanguages(project.languages, '    ');
    }

    // Display format breakdown
    if (!this.verbose && project.formats.length > 0) {
      console.log(chalk.yellow('\n  By Format:'));
      this.displayLanguages(project.formats, '    ');
    }

    // Display branches
    if (this.verbose || project.branches.length > 1) {
      for (const branch of project.branches) {
        // Skip "Unknown" branches unless verbose
        if (branch.branchName === 'Unknown' && !this.verbose) {
          continue;
        }
        this.displayBranch(branch);
      }
    }
  }

  /**
   * Display a single branch
   */
  private displayBranch(branch: BranchAnalytics): void {
    console.log(chalk.bold.magenta(`\n  ${'+'.repeat(56)}`));
    console.log(chalk.bold.magenta(`  BRANCH: ${branch.branchName}`));
    console.log(chalk.bold.magenta(`  ${'+'.repeat(56)}`));

    this.displayStats(branch, '    ');

    // Display model distribution
    if (branch.models.length > 0 && !this.verbose) {
      console.log(chalk.yellow('\n    Models:'));
      this.displayModels(branch.models, '      ');
    }

    // Display tool usage
    if (branch.tools.length > 0 && !this.verbose) {
      console.log(chalk.yellow('\n    Tool Usage:'));
      this.displayTools(branch.tools, '      ');
    }

    // Display language breakdown
    if (!this.verbose && branch.languages.length > 0) {
      console.log(chalk.yellow('\n    By Language:'));
      this.displayLanguages(branch.languages, '      ');
    }

    // Display sessions in verbose mode
    if (this.verbose) {
      for (const session of branch.sessions) {
        this.displaySession(session);
      }
    }
  }

  /**
   * Display a single session (verbose mode)
   */
  private displaySession(session: SessionAnalytics): void {
    console.log(chalk.dim(`\n      ${'-'.repeat(54)}`));
    console.log(chalk.white(`      Session: ${session.sessionId}`));
    console.log(chalk.dim(`      ${'-'.repeat(54)}`));

    console.log(chalk.gray(`      Agent:     ${session.agentName}`));
    console.log(chalk.gray(`      Provider:  ${session.provider}`));
    console.log(chalk.gray(`      Duration:  ${this.formatDuration(session.duration)}`));
    console.log(chalk.gray(`      Turns:     ${session.totalTurns}`));

    // Token breakdown
    console.log(chalk.yellow('\n      Token Breakdown:'));
    console.log(chalk.gray(`        Input:          ${session.tokens.input.toLocaleString()}`));
    console.log(chalk.gray(`        Cache Creation: ${session.tokens.cacheCreation.toLocaleString()}`));
    console.log(chalk.gray(`        Cache Read:     ${session.tokens.cacheRead.toLocaleString()}`));
    console.log(chalk.gray(`        Output:         ${session.tokens.output.toLocaleString()}`));
    console.log(chalk.gray(`        Total:          ${session.tokens.total.toLocaleString()}`));
    console.log(chalk.gray(`        Cache Hit Rate: ${(session.tokens.cacheHitRate * 100).toFixed(1)}%`));

    // Models
    if (session.models.length > 0) {
      console.log(chalk.yellow('\n      Models:'));
      this.displayModels(session.models, '        ');
    }

    // Tools
    if (session.tools.length > 0) {
      console.log(chalk.yellow('\n      Tools:'));
      this.displayTools(session.tools, '        ');
    }

    // Files
    if (session.files.length > 0) {
      console.log(chalk.yellow(`\n      Files Changed (${session.files.length}):`));
      for (const file of session.files.slice(0, 10)) {
        const filename = file.filePath.split('/').pop() || file.filePath;
        console.log(chalk.gray(`        ${filename}`));
        console.log(chalk.gray(`          Operations: ${file.operationCount}`));
        console.log(chalk.gray(`          Lines Added: ${file.linesAdded}`));
        console.log(chalk.gray(`          Lines Removed: ${file.linesRemoved}`));
        console.log(chalk.gray(`          Net Changed: ${file.netLinesChanged}`));
      }
      if (session.files.length > 10) {
        console.log(chalk.gray(`        ... and ${session.files.length - 10} more`));
      }
    }

    // Languages
    if (session.languages.length > 0) {
      console.log(chalk.yellow('\n      By Language:'));
      this.displayLanguages(session.languages, '        ');
    }
  }

  /**
   * Display core statistics in simple list format
   */
  private displayStats(
    stats: {
      totalSessions: number;
      totalDuration: number;
      totalTokens: TokenBreakdown;
      totalTurns: number;
      totalFileOperations: number;
      totalLinesAdded: number;
      totalLinesRemoved: number;
      totalLinesModified: number;
      netLinesChanged: number;
      totalToolCalls: number;
      successfulToolCalls: number;
      failedToolCalls: number;
      toolSuccessRate: number;
    },
    indent = ''
  ): void {
    console.log(`${indent}${chalk.cyan('Sessions:')} ${stats.totalSessions}`);
    console.log(`${indent}${chalk.cyan('Duration:')} ${this.formatDuration(stats.totalDuration)}`);
    console.log(`${indent}${chalk.cyan('Turns:')} ${stats.totalTurns}`);
    console.log(`${indent}${chalk.cyan('Tokens:')} ${stats.totalTokens.total.toLocaleString()}`);
    console.log(`${indent}${chalk.cyan('File Operations:')} ${stats.totalFileOperations}`);
    console.log(`${indent}${chalk.cyan('Lines:')} ${chalk.green(`+${stats.totalLinesAdded}`)} ${chalk.red(`-${stats.totalLinesRemoved}`)} ${chalk.yellow(`~${stats.totalLinesModified}`)} ${chalk.white(`(${stats.netLinesChanged >= 0 ? '+' : ''}${stats.netLinesChanged})`)}`);

    // Color code success rate
    let rateColor;
    if (stats.toolSuccessRate < 20) {
      rateColor = chalk.red;
    } else if (stats.toolSuccessRate < 75) {
      rateColor = chalk.white;
    } else {
      rateColor = chalk.green;
    }

    console.log(`${indent}${chalk.cyan('Tool Calls:')} ${stats.totalToolCalls} (${chalk.green('✓' + stats.successfulToolCalls)}, ${chalk.red('✗' + stats.failedToolCalls)}, ${rateColor(stats.toolSuccessRate.toFixed(1) + '%')})`);
  }

  /**
   * Display model distribution in wide table format
   */
  private displayModels(models: ModelStats[], indent = '  '): void {
    if (models.length === 0) return;

    const displayModels = models.slice(0, 10);

    // Calculate max width for model names
    const maxModelWidth = 60;
    const modelWidth = Math.min(
      Math.max(...displayModels.map(m => m.model.length), 'Model'.length),
      maxModelWidth
    );
    const callsWidth = 8;
    const shareWidth = 10;

    // Header
    console.log(`${indent}${chalk.dim('┌─' + '─'.repeat(modelWidth) + '─┬─' + '─'.repeat(callsWidth) + '─┬─' + '─'.repeat(shareWidth) + '─┐')}`);
    console.log(`${indent}${chalk.dim('│')} ${chalk.bold.cyan('Model'.padEnd(modelWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Calls'.padStart(callsWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Share'.padStart(shareWidth))} ${chalk.dim('│')}`);
    console.log(`${indent}${chalk.dim('├─' + '─'.repeat(modelWidth) + '─┼─' + '─'.repeat(callsWidth) + '─┼─' + '─'.repeat(shareWidth) + '─┤')}`);

    // Data rows
    for (const model of displayModels) {
      const modelName = model.model.length > modelWidth
        ? model.model.substring(0, modelWidth - 3) + '...'
        : model.model;
      console.log(`${indent}${chalk.dim('│')} ${chalk.white(modelName.padEnd(modelWidth))} ${chalk.dim('│')} ${chalk.white(model.calls.toString().padStart(callsWidth))} ${chalk.dim('│')} ${chalk.white((model.percentage.toFixed(1) + '%').padStart(shareWidth))} ${chalk.dim('│')}`);
    }

    console.log(`${indent}${chalk.dim('└─' + '─'.repeat(modelWidth) + '─┴─' + '─'.repeat(callsWidth) + '─┴─' + '─'.repeat(shareWidth) + '─┘')}`);

    if (models.length > 10) {
      console.log(`${indent}${chalk.dim(`... and ${models.length - 10} more`)}`);
    }
  }

  /**
   * Display tool usage in wide table format
   */
  private displayTools(tools: ToolStats[], indent = '  '): void {
    if (tools.length === 0) return;

    const displayTools = tools.slice(0, 10);

    // Fixed column widths
    const toolWidth = Math.min(
      Math.max(...displayTools.map(t => t.toolName.length), 'Tool'.length),
      30
    );
    const callsWidth = 25; // Wide enough for "10 (✓8, ✗2)" format
    const rateWidth = 12;

    // Header
    console.log(`${indent}${chalk.dim('┌─' + '─'.repeat(toolWidth) + '─┬─' + '─'.repeat(callsWidth) + '─┬─' + '─'.repeat(rateWidth) + '─┐')}`);
    console.log(`${indent}${chalk.dim('│')} ${chalk.bold.cyan('Tool'.padEnd(toolWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Calls (Success, Failed)'.padStart(callsWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Success Rate'.padStart(rateWidth))} ${chalk.dim('│')}`);
    console.log(`${indent}${chalk.dim('├─' + '─'.repeat(toolWidth) + '─┼─' + '─'.repeat(callsWidth) + '─┼─' + '─'.repeat(rateWidth) + '─┤')}`);

    // Data rows
    for (const tool of displayTools) {
      const toolName = tool.toolName.length > toolWidth
        ? tool.toolName.substring(0, toolWidth - 3) + '...'
        : tool.toolName;

      // Format calls with colored success/failed
      const callsText = `${tool.totalCalls} (${chalk.green('✓' + tool.successCount)}, ${chalk.red('✗' + tool.failureCount)})`;
      const callsPlain = `${tool.totalCalls} (✓${tool.successCount}, ✗${tool.failureCount})`;
      const padding = callsWidth - callsPlain.length;

      // Color code success rate
      let rateColor;
      if (tool.successRate < 20) {
        rateColor = chalk.red;
      } else if (tool.successRate < 75) {
        rateColor = chalk.white;
      } else {
        rateColor = chalk.green;
      }

      console.log(`${indent}${chalk.dim('│')} ${chalk.white(toolName.padEnd(toolWidth))} ${chalk.dim('│')} ${' '.repeat(padding)}${callsText} ${chalk.dim('│')} ${rateColor((tool.successRate.toFixed(1) + '%').padStart(rateWidth))} ${chalk.dim('│')}`);
    }

    console.log(`${indent}${chalk.dim('└─' + '─'.repeat(toolWidth) + '─┴─' + '─'.repeat(callsWidth) + '─┴─' + '─'.repeat(rateWidth) + '─┘')}`);

    if (tools.length > 10) {
      console.log(`${indent}${chalk.dim(`... and ${tools.length - 10} more`)}`);
    }
  }

  /**
   * Display language/format statistics in wide table format
   */
  private displayLanguages(languages: LanguageStats[], indent = '  '): void {
    if (languages.length === 0) return;

    const displayLangs = languages.slice(0, 10);

    // Fixed column widths
    const langWidth = Math.min(
      Math.max(...displayLangs.map(l => l.language.length), 'Language'.length),
      20
    );
    const linesWidth = 8;
    const createdWidth = 10;
    const modifiedWidth = 10;
    const shareWidth = 10;

    // Header
    console.log(`${indent}${chalk.dim('┌─' + '─'.repeat(langWidth) + '─┬─' + '─'.repeat(linesWidth) + '─┬─' + '─'.repeat(createdWidth) + '─┬─' + '─'.repeat(modifiedWidth) + '─┬─' + '─'.repeat(shareWidth) + '─┐')}`);
    console.log(`${indent}${chalk.dim('│')} ${chalk.bold.cyan('Language'.padEnd(langWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Lines'.padStart(linesWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Created'.padStart(createdWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Modified'.padStart(modifiedWidth))} ${chalk.dim('│')} ${chalk.bold.cyan('Share'.padStart(shareWidth))} ${chalk.dim('│')}`);
    console.log(`${indent}${chalk.dim('├─' + '─'.repeat(langWidth) + '─┼─' + '─'.repeat(linesWidth) + '─┼─' + '─'.repeat(createdWidth) + '─┼─' + '─'.repeat(modifiedWidth) + '─┼─' + '─'.repeat(shareWidth) + '─┤')}`);

    // Data rows
    for (const lang of displayLangs) {
      const langName = lang.language.length > langWidth
        ? lang.language.substring(0, langWidth - 3) + '...'
        : lang.language;
      console.log(`${indent}${chalk.dim('│')} ${chalk.white(langName.padEnd(langWidth))} ${chalk.dim('│')} ${chalk.white(lang.linesAdded.toString().padStart(linesWidth))} ${chalk.dim('│')} ${chalk.white(lang.filesCreated.toString().padStart(createdWidth))} ${chalk.dim('│')} ${chalk.white(lang.filesModified.toString().padStart(modifiedWidth))} ${chalk.dim('│')} ${chalk.white((lang.percentage.toFixed(1) + '%').padStart(shareWidth))} ${chalk.dim('│')}`);
    }

    console.log(`${indent}${chalk.dim('└─' + '─'.repeat(langWidth) + '─┴─' + '─'.repeat(linesWidth) + '─┴─' + '─'.repeat(createdWidth) + '─┴─' + '─'.repeat(modifiedWidth) + '─┴─' + '─'.repeat(shareWidth) + '─┘')}`);

    if (languages.length > 10) {
      console.log(`${indent}${chalk.dim(`... and ${languages.length - 10} more`)}`);
    }
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
