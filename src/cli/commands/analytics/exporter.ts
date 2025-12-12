/**
 * Export functionality for analytics data
 */

import { writeFileSync } from 'fs';
import type { RootAnalytics } from './types.js';
import chalk from 'chalk';

export class AnalyticsExporter {
  /**
   * Export analytics to JSON file
   */
  static exportJSON(analytics: RootAnalytics, outputPath: string): void {
    try {
      const json = JSON.stringify(analytics, null, 2);
      writeFileSync(outputPath, json, 'utf-8');
      console.log(chalk.green(`\n✓ Exported to: ${outputPath}`));
    } catch (error) {
      console.error(chalk.red(`\n✗ Failed to export JSON: ${error instanceof Error ? error.message : String(error)}`));
      throw error;
    }
  }

  /**
   * Export analytics to CSV file
   * Exports session-level data in flat format
   */
  static exportCSV(analytics: RootAnalytics, outputPath: string): void {
    try {
      const lines: string[] = [];

      // CSV header
      lines.push([
        'Session ID',
        'Agent',
        'Provider',
        'Project',
        'Branch',
        'Start Time',
        'Duration (s)',
        'Turns',
        'Input Tokens',
        'Output Tokens',
        'Cache Read Tokens',
        'Cache Creation Tokens',
        'Total Tokens',
        'Cache Hit Rate (%)',
        'Primary Model',
        'Files Modified',
        'Lines Added',
        'Lines Removed',
        'Net Lines'
      ].join(','));

      // Session rows
      for (const project of analytics.projects) {
        for (const branch of project.branches) {
          for (const session of branch.sessions) {
            const row = [
              session.sessionId,
              session.agentName,
              session.provider,
              project.projectPath,
              branch.branchName,
              new Date(session.startTime).toISOString(),
              Math.floor(session.duration / 1000).toString(),
              session.totalTurns.toString(),
              session.tokens.input.toString(),
              session.tokens.output.toString(),
              session.tokens.cacheRead.toString(),
              session.tokens.cacheCreation.toString(),
              session.tokens.total.toString(),
              (session.tokens.cacheHitRate * 100).toFixed(2),
              session.models[0]?.model || 'N/A',
              session.files.length.toString(),
              session.files.reduce((sum, f) => sum + f.linesAdded, 0).toString(),
              session.files.reduce((sum, f) => sum + f.linesRemoved, 0).toString(),
              session.files.reduce((sum, f) => sum + f.netLinesChanged, 0).toString()
            ];

            // Escape CSV fields with commas or quotes
            const escapedRow = row.map(field => {
              if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                return `"${field.replace(/"/g, '""')}"`;
              }
              return field;
            });

            lines.push(escapedRow.join(','));
          }
        }
      }

      writeFileSync(outputPath, lines.join('\n'), 'utf-8');
      console.log(chalk.green(`\n✓ Exported to: ${outputPath}`));
    } catch (error) {
      console.error(chalk.red(`\n✗ Failed to export CSV: ${error instanceof Error ? error.message : String(error)}`));
      throw error;
    }
  }

  /**
   * Auto-determine output path based on format
   */
  static getDefaultOutputPath(format: 'json' | 'csv', cwd: string): string {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `codemie-analytics-${timestamp}.${format}`;
    return `${cwd}/${filename}`;
  }
}
