/**
 * Health check result formatter
 */

import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { HealthCheckResult, HealthCheckDetail, HealthStatus } from './types.js';

export class HealthCheckFormatter {
  private currentSpinner: Ora | null = null;
  private checkName: string = '';

  /**
   * Display header
   */
  displayHeader(): void {
    console.log(chalk.bold('\n🔍 CodeMie Code Health Check\n'));
  }

  /**
   * Get section header (for item-wise checks)
   */
  getCheckHeader(name: string): string {
    return chalk.bold(`${name}:`);
  }

  /**
   * Start a check with progress indicator
   */
  startCheck(name: string): void {
    this.checkName = name;
    this.currentSpinner = ora(`Checking ${name}...`).start();
  }

  /**
   * Update progress for current check
   */
  updateProgress(message: string): void {
    if (this.currentSpinner) {
      this.currentSpinner.text = `${this.checkName}: ${message}`;
    }
  }

  /**
   * Start checking an individual item
   */
  startItem(message: string): void {
    if (this.currentSpinner) {
      this.currentSpinner.stop();
    }
    this.currentSpinner = ora(message).start();
  }

  /**
   * Display a single item result
   */
  displayItem(detail: HealthCheckDetail): void {
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }

    this.printDetail(detail, 0);
  }

  /** One detail, its hint, then its children indented one level deeper. */
  private printDetail(detail: HealthCheckDetail, depth: number): void {
    const indent = '  ' + '    '.repeat(depth);
    const icon = this.getIcon(detail.status);
    const colorFn = this.getColorFunction(detail.status);

    console.log(`${indent}${icon} ${colorFn(detail.message)}`);

    if (detail.hint) {
      console.log(`${indent}    ${chalk.white(detail.hint)}`);
    }

    for (const child of detail.children ?? []) {
      this.printDetail(child, depth + 1);
    }
  }

  /**
   * Display a single health check result
   */
  displayCheck(result: HealthCheckResult): void {
    // Stop the spinner if one is running
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }

    console.log(chalk.bold(`${result.name}:`));

    for (const detail of result.details) {
      this.printDetail(detail, 0);
    }

    console.log();
  }

  /**
   * Display check result with header (stops spinner first, then shows header and details)
   */
  displayCheckWithHeader(result: HealthCheckResult): void {
    // Stop the spinner if one is running
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }

    console.log(chalk.bold(`${result.name}:`));

    for (const detail of result.details) {
      this.printDetail(detail, 0);
    }

    console.log();
  }

  /**
   * Display summary
   */
  displaySummary(results: HealthCheckResult[]): void {
    const hasIssues = results.some(r => !r.success);

    if (hasIssues) {
      console.log(chalk.yellow('⚠ Some issues detected. Please resolve them for optimal performance.\n'));
      process.exit(1);
    } else {
      console.log(chalk.green('✓ All checks passed!\n'));
    }
  }

  /**
   * Get icon for status
   */
  private getIcon(status: HealthStatus): string {
    switch (status) {
      case 'ok':
        return chalk.green('✓');
      case 'warn':
        return chalk.yellow('⚠');
      case 'error':
        return chalk.red('✗');
      case 'info':
        return chalk.white('○');
      default:
        return '•';
    }
  }

  /**
   * Get color function for status
   */
  private getColorFunction(status: HealthStatus): (text: string) => string {
    switch (status) {
      case 'ok':
        return chalk.green;
      case 'warn':
        return chalk.yellow;
      case 'error':
        return chalk.red;
      case 'info':
        return chalk.white;
      default:
        return chalk.white;
    }
  }
}
