/**
 * Export functionality for analytics data
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import type { RootAnalytics } from './types.js';
import type { SessionCostIndex, CostSummary } from './cost/types.js';
import chalk from 'chalk';

export class AnalyticsExporter {
  /**
   * Export analytics to JSON file. `costIndex`/`costSummary` are optional so a caller with
   * no cost data still exports the rest of the analytics — cost fields are simply omitted.
   * When present, each session gains a `cost` field ({ costUSD, priced }) and the root
   * payload gains a `costSummary` field, matching what the console path already shows
   * (Est. Cost / per-session Cost:).
   */
  static exportJSON(
    analytics: RootAnalytics,
    outputPath: string,
    costIndex?: SessionCostIndex,
    costSummary?: CostSummary
  ): void {
    try {
      const payload: Record<string, unknown> = costIndex
        ? {
            ...analytics,
            projects: analytics.projects.map((project) => ({
              ...project,
              branches: project.branches.map((branch) => ({
                ...branch,
                sessions: branch.sessions.map((session) => {
                  const cost = costIndex.get(session.sessionId);
                  return cost
                    ? { ...session, cost: { costUSD: cost.costUSD, priced: cost.priced } }
                    : session;
                }),
              })),
            })),
          }
        : { ...analytics };

      if (costSummary) {
        payload.costSummary = costSummary;
      }

      const json = JSON.stringify(payload, null, 2);
      writeFileSync(outputPath, json, 'utf-8');
      console.log(chalk.green(`\n✓ Exported to: ${outputPath}`));
    } catch (error) {
      console.error(chalk.red(`\n✗ Failed to export JSON: ${error instanceof Error ? error.message : String(error)}`));
      throw error;
    }
  }

  /**
   * Export analytics to CSV file
   * Exports session-level data in flat format. `costIndex` is optional — when supplied,
   * a "Cost (USD)" column is populated from it; "Active Duration (s)" is always emitted
   * from the session's own `activeDurationMs` (blank when the session never reported one).
   */
  static exportCSV(analytics: RootAnalytics, outputPath: string, costIndex?: SessionCostIndex): void {
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
        'Active Duration (s)',
        'Turns',
        'Primary Model',
        'Files Modified',
        'Lines Added',
        'Lines Removed',
        'Net Lines',
        'Cost (USD)'
      ].join(','));

      // Session rows
      for (const project of analytics.projects) {
        for (const branch of project.branches) {
          for (const session of branch.sessions) {
            const cost = costIndex?.get(session.sessionId);
            const row = [
              session.sessionId,
              session.agentName,
              session.provider,
              project.projectPath,
              branch.branchName,
              new Date(session.startTime).toISOString(),
              Math.floor(session.duration / 1000).toString(),
              session.activeDurationMs != null ? Math.floor(session.activeDurationMs / 1000).toString() : '',
              session.totalTurns.toString(),
              session.models[0]?.model || 'N/A',
              session.files.length.toString(),
              session.files.reduce((sum, f) => sum + f.linesAdded, 0).toString(),
              session.files.reduce((sum, f) => sum + f.linesRemoved, 0).toString(),
              session.files.reduce((sum, f) => sum + f.netLinesChanged, 0).toString(),
              cost?.priced ? cost.costUSD.toString() : ''
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
    return join(cwd, `codemie-analytics-${timestamp}.${format}`);
  }
}
