import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadAnalyticsConfig } from '../../analytics/config.js';
import { logger } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/registry.js';
import { ConfigLoader } from '../../utils/config-loader.js';
import { CodemieAnalyticsAggregator } from '../../analytics/aggregation/index.js';

export function createAnalyticsCommand(): Command {
  const command = new Command('analytics');

  command
    .description('Analytics management and insights')
    .action(async () => {
      try {
        const config = loadAnalyticsConfig();

        // Show configuration
        console.log(chalk.bold.cyan('\n📊 Analytics Configuration\n'));

        console.log(chalk.cyan('Status:          ') + (config.enabled ? chalk.green('Enabled') : chalk.red('Disabled')));
        console.log(chalk.cyan('Target:          ') + chalk.white(config.target));
        console.log(chalk.cyan('Local Path:      ') + chalk.white(config.localPath));

        if (config.remoteEndpoint) {
          console.log(chalk.cyan('Remote Endpoint: ') + chalk.white(config.remoteEndpoint));
        }

        console.log(chalk.cyan('Flush Interval:  ') + chalk.white(`${config.flushInterval}ms`));
        console.log(chalk.cyan('Buffer Size:     ') + chalk.white(`${config.maxBufferSize} events`));

        // Show help
        console.log(chalk.bold.cyan('\n📋 Available Commands\n'));
        console.log(chalk.white('  codemie analytics enable       ') + chalk.gray('Enable analytics collection'));
        console.log(chalk.white('  codemie analytics disable      ') + chalk.gray('Disable analytics collection'));
        console.log(chalk.white('  codemie analytics show         ') + chalk.gray('Show analytics from all agents'));
        console.log();
      } catch (error: unknown) {
        logger.error('Failed to show analytics configuration:', error);
        process.exit(1);
      }
    })
    .addCommand(createEnableCommand())
    .addCommand(createDisableCommand())
    .addCommand(createShowCommand());

  return command;
}

function createEnableCommand(): Command {
  const command = new Command('enable');

  command
    .description('Enable analytics collection')
    .action(async () => {
      try {
        await updateAnalyticsEnabled(true);
        logger.success('Analytics enabled');
        console.log(chalk.white('Analytics data will be collected to:'));
        console.log(chalk.cyan('  ~/.codemie/analytics/'));
        console.log();
      } catch (error: unknown) {
        logger.error('Failed to enable analytics:', error);
        process.exit(1);
      }
    });

  return command;
}

function createDisableCommand(): Command {
  const command = new Command('disable');

  command
    .description('Disable analytics collection')
    .action(async () => {
      try {
        await updateAnalyticsEnabled(false);
        logger.success('Analytics disabled');
        console.log(chalk.white('No analytics data will be collected.'));
        console.log();
      } catch (error: unknown) {
        logger.error('Failed to disable analytics:', error);
        process.exit(1);
      }
    });

  return command;
}



function createShowCommand(): Command {
  const command = new Command('show');

  command
    .description('Show analytics from all agents (Gemini, Claude, Codex, etc.)')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--agent <name>', 'Filter by agent (gemini|claude|codex|codemie-code)')
    .option('--project <path>', 'Filter by project path')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .option('--output <file>', 'Output file (for JSON format)')
    .action(async (options: {
      from?: string;
      to?: string;
      agent?: string;
      project?: string;
      format?: string;
      output?: string;
    }) => {
      try {
        // Check if analytics is disabled
        const config = loadAnalyticsConfig();
        if (!config.enabled) {
          console.log(chalk.yellow('\nAnalytics is disabled. No data is being collected.\n'));
          return;
        }

        console.log(chalk.bold.cyan('\n📊 CodeMie Analytics Aggregation\n'));

        // Parse dates
        const dateFrom = options.from ? new Date(options.from) : undefined;
        const dateTo = options.to ? new Date(options.to) : undefined;

        // Validate dates
        if (dateFrom && isNaN(dateFrom.getTime())) {
          logger.error('Invalid start date format. Use YYYY-MM-DD');
          process.exit(1);
        }
        if (dateTo && isNaN(dateTo.getTime())) {
          logger.error('Invalid end date format. Use YYYY-MM-DD');
          process.exit(1);
        }

        // Validate agent if specified
        if (options.agent) {
          const validAgents = AgentRegistry.getAgentNames();
          if (!validAgents.includes(options.agent)) {
            logger.error(`Invalid agent: ${options.agent}`);
            console.log(chalk.white('Available agents:'));
            validAgents.forEach(name => {
              const adapter = AgentRegistry.getAgent(name);
              console.log(`  ${chalk.cyan(name.padEnd(15))} ${chalk.white(adapter?.displayName || '')}`);
            });
            process.exit(1);
          }
        }

        // Create aggregator and fetch sessions
        const aggregator = new CodemieAnalyticsAggregator();
        const sessions = await aggregator.aggregateSessions({
          dateFrom,
          dateTo,
          agent: options.agent,
          projectPath: options.project
        });

        if (sessions.length === 0) {
          console.log(chalk.yellow('No sessions found matching the criteria.\n'));
          return;
        }

        // Output based on format
        if (options.format === 'json') {
          const output = {
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            filters: {
              dateFrom: dateFrom?.toISOString(),
              dateTo: dateTo?.toISOString(),
              agent: options.agent,
              projectPath: options.project
            },
            sessions
          };

          if (options.output) {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(options.output, JSON.stringify(output, null, 2));
            logger.success(`Exported to ${options.output}`);
          } else {
            console.log(JSON.stringify(output, null, 2));
          }
        } else {
          // Table format
          console.log(chalk.white(`Found ${chalk.cyan(sessions.length.toString())} sessions\n`));

          // Show date range of found sessions
          if (sessions.length > 0) {
            const startDates = sessions.map(s => s.startTime.getTime());
            const endDates = sessions.map(s => s.endTime?.getTime() || s.startTime.getTime());
            const earliestDate = new Date(Math.min(...startDates));
            const latestDate = new Date(Math.max(...endDates));

            console.log(chalk.bold.white('📅 Date Range\n'));
            const dateRangeTable = new Table({
              head: [chalk.cyan('Period'), chalk.cyan('Date')],
              style: {
                head: [],
                border: ['grey']
              },
              colWidths: [25, 60]
            });

            dateRangeTable.push(
              [chalk.white('From'), chalk.white(earliestDate.toLocaleString())],
              [chalk.white('To'), chalk.white(latestDate.toLocaleString())]
            );

            console.log(dateRangeTable.toString());
            console.log();
          }

          // Calculate summary statistics
          const totalMessages = sessions.reduce((sum, s) => sum + s.userMessageCount + s.assistantMessageCount, 0);
          const totalTokens = sessions.reduce((sum, s) => sum + s.tokens.total, 0);
          const totalInputTokens = sessions.reduce((sum, s) => sum + s.tokens.input, 0);
          const totalOutputTokens = sessions.reduce((sum, s) => sum + s.tokens.output, 0);
          const totalCacheRead = sessions.reduce((sum, s) => sum + s.tokens.cacheRead, 0);
          const totalCacheCreation = sessions.reduce((sum, s) => sum + s.tokens.cacheCreation, 0);
          const totalThoughts = sessions.reduce((sum, s) => sum + (s.tokens.thoughts || 0), 0);
          const totalReasoning = sessions.reduce((sum, s) => sum + (s.tokens.reasoning || 0), 0);
          const totalToolTokens = sessions.reduce((sum, s) => sum + (s.tokens.tool || 0), 0);
          const totalToolCalls = sessions.reduce((sum, s) => sum + s.toolCallCount, 0);
          const totalFileModifications = sessions.reduce((sum, s) => sum + s.fileModifications, 0);

          // 1. SUMMARY - Sessions & Messages
          console.log(chalk.bold.white('📈 Summary Statistics\n'));

          const summaryTable = new Table({
            head: [chalk.cyan('Metric'), chalk.cyan('Value')],
            style: {
              head: [],
              border: ['grey']
            },
            colWidths: [25, 60]
          });

          const totalPrompts = sessions.reduce((sum, s) => sum + s.userMessageCount, 0);
          const totalResponses = sessions.reduce((sum, s) => sum + s.assistantMessageCount, 0);

          summaryTable.push(
            [chalk.white('Sessions'), chalk.white(sessions.length.toString())],
            [chalk.white('Messages'), chalk.white(`${totalMessages.toLocaleString()} (${totalPrompts.toLocaleString()} prompts + ${totalResponses.toLocaleString()} responses)`)]
          );

          console.log(summaryTable.toString());
          console.log();

          // 2. Code Generation Statistics
          const sessionsWithFileStats = sessions.filter(s => s.fileStats);
          if (sessionsWithFileStats.length > 0) {
            const totalLinesGenerated = sessionsWithFileStats.reduce((sum, s) => sum + (s.fileStats?.totalLinesAdded || 0), 0);
            const totalLinesRemoved = sessionsWithFileStats.reduce((sum, s) => sum + (s.fileStats?.totalLinesRemoved || 0), 0);
            const totalFilesCreated = sessionsWithFileStats.reduce((sum, s) => sum + (s.fileStats?.filesCreated || 0), 0);
            const totalFilesModified = sessionsWithFileStats.reduce((sum, s) => sum + (s.fileStats?.filesModified || 0), 0);
            const netLines = totalLinesGenerated - totalLinesRemoved;

            console.log(chalk.bold.white('📝 Code Generation\n'));

            const codeGenTable = new Table({
              head: [chalk.cyan('Metric'), chalk.cyan('Value')],
              style: {
                head: [],
                border: ['grey']
              },
              colWidths: [25, 60]
            });

            codeGenTable.push(
              [chalk.white('Lines Generated'), chalk.white(totalLinesGenerated.toLocaleString())]
            );

            if (totalLinesRemoved > 0) {
              codeGenTable.push(
                [chalk.white('Lines Removed'), chalk.white(totalLinesRemoved.toLocaleString())],
                [chalk.white('Net Lines'), chalk.white(netLines.toLocaleString())]
              );
            }

            codeGenTable.push(
              [chalk.white('Files Created'), chalk.white(totalFilesCreated.toString())],
              [chalk.white('Files Modified'), chalk.white(totalFilesModified.toString())],
              [chalk.white('File Modifications'), chalk.white(totalFileModifications.toString())]
            );

            console.log(codeGenTable.toString());
            console.log();
          }

          // 3. Token Breakdown
          console.log(chalk.bold.white('💰 Token Usage\n'));

          const tokenTable = new Table({
            head: [chalk.cyan('Type'), chalk.cyan('Tokens')],
            style: {
              head: [],
              border: ['grey']
            },
            colWidths: [25, 60]
          });

          tokenTable.push(
            [chalk.white('Total'), chalk.white(totalTokens.toLocaleString())],
            [chalk.white('Input'), chalk.white(totalInputTokens.toLocaleString())],
            [chalk.white('Output'), chalk.white(totalOutputTokens.toLocaleString())],
            [chalk.white('Cache Read'), chalk.white(totalCacheRead.toLocaleString())]
          );

          if (totalCacheCreation > 0) {
            tokenTable.push([chalk.white('Cache Creation'), chalk.white(totalCacheCreation.toLocaleString())]);
          }
          if (totalThoughts > 0) {
            tokenTable.push([chalk.white('Thoughts'), chalk.white(totalThoughts.toLocaleString())]);
          }
          if (totalReasoning > 0) {
            tokenTable.push([chalk.white('Reasoning'), chalk.white(totalReasoning.toLocaleString())]);
          }
          if (totalToolTokens > 0) {
            tokenTable.push([chalk.white('Tool'), chalk.white(totalToolTokens.toLocaleString())]);
          }

          console.log(tokenTable.toString());
          console.log();

          // 4. BY AGENT - Agent breakdown
          const byAgent: Record<string, { sessions: number; tokens: number; prompts: number; apiCalls: number; displayName: string }> = {};
          for (const session of sessions) {
            if (!byAgent[session.agent]) {
              const adapter = AgentRegistry.getAgent(session.agent);
              byAgent[session.agent] = {
                sessions: 0,
                tokens: 0,
                prompts: 0,
                apiCalls: 0,
                displayName: adapter?.displayName || session.agent
              };
            }
            byAgent[session.agent].sessions++;
            byAgent[session.agent].tokens += session.tokens.total;
            byAgent[session.agent].prompts += session.userMessageCount;
            // Count API calls from model usage
            byAgent[session.agent].apiCalls += Object.values(session.modelUsage).reduce((sum, count) => sum + count, 0);
          }

          console.log(chalk.bold.white('🤖 Breakdown by Agent\n'));
          const sortedAgents = Object.entries(byAgent)
            .sort((a, b) => b[1].sessions - a[1].sessions);

          // Create table for agent breakdown
          const agentTable = new Table({
            head: [chalk.cyan('Agent'), chalk.cyan('Prompts'), chalk.cyan('Sessions'), chalk.cyan('API Calls'), chalk.cyan('Share')],
            style: {
              head: [],
              border: ['grey']
            }
          });

          for (const [, stats] of sortedAgents) {
            const percentage = ((stats.sessions / sessions.length) * 100).toFixed(1);
            agentTable.push([
              chalk.white(stats.displayName),
              chalk.white(stats.prompts.toString()),
              chalk.white(stats.sessions.toString()),
              chalk.white(stats.apiCalls.toString()),
              chalk.white(`${percentage}%`)
            ]);
          }

          console.log(agentTable.toString());
          console.log();

          // Show model usage breakdown
          const modelBreakdown: Record<string, number> = {};
          for (const session of sessions) {
            for (const [modelName, count] of Object.entries(session.modelUsage)) {
              modelBreakdown[modelName] = (modelBreakdown[modelName] || 0) + count;
            }
          }

          if (Object.keys(modelBreakdown).length > 0) {
            const totalModelCalls = Object.values(modelBreakdown).reduce((sum, count) => sum + count, 0);
            console.log(chalk.bold.white('  Models:\n'));
            const sortedModels = Object.entries(modelBreakdown)
              .sort((a, b) => b[1] - a[1]);

            // Create table for models
            const modelTable = new Table({
              head: [chalk.cyan('Model'), chalk.cyan('Calls'), chalk.cyan('Share')],
              style: {
                head: [],
                border: ['grey']
              },
              colWidths: [55, 12, 12]
            });

            for (const [modelName, count] of sortedModels) {
              const percentage = ((count / totalModelCalls) * 100).toFixed(1);
              modelTable.push([
                chalk.white(modelName),
                chalk.white(count.toString()),
                chalk.white(`${percentage}%`)
              ]);
            }

            console.log('  ' + modelTable.toString().split('\n').join('\n  '));
            console.log();
          }

          // 5. TOOL USAGE
          if (totalToolCalls > 0) {
            const toolBreakdown: Record<string, number> = {};
            const toolStatusBreakdown: Record<string, { success: number; failure: number }> = {};

            for (const session of sessions) {
              for (const [toolName, count] of Object.entries(session.toolUsage)) {
                toolBreakdown[toolName] = (toolBreakdown[toolName] || 0) + count;
              }

              for (const [toolName, status] of Object.entries(session.toolStatus)) {
                if (!toolStatusBreakdown[toolName]) {
                  toolStatusBreakdown[toolName] = { success: 0, failure: 0 };
                }
                toolStatusBreakdown[toolName].success += status.success;
                toolStatusBreakdown[toolName].failure += status.failure;
              }
            }

            if (Object.keys(toolBreakdown).length > 0) {
              console.log(chalk.bold.white('🔧 Tool Usage\n'));
              const sortedTools = Object.entries(toolBreakdown)
                .sort((a, b) => b[1] - a[1]);

              // Create table for tools
              const toolTable = new Table({
                head: [chalk.cyan('Tool'), chalk.cyan('Calls'), chalk.cyan('Share'), chalk.cyan('Status'), chalk.cyan('Success Rate')],
                style: {
                  head: [],
                  border: ['grey']
                },
                colWidths: [20, 10, 8, 20, 15]
              });

              for (const [toolName, count] of sortedTools) {
                const percentage = ((count / totalToolCalls) * 100).toFixed(1);
                const status = toolStatusBreakdown[toolName];
                const successRate = status ? ((status.success / count) * 100).toFixed(1) : '0.0';

                // Build status text with color coding
                let statusText: string;
                let successRateText: string;

                if (status && status.failure > 0 && status.success === 0) {
                  // Critical: 0% success rate with failures - RED
                  statusText = chalk.red(`(${status.success} ✓, ${status.failure} ✗)`);
                  successRateText = chalk.red(`${successRate}%`);
                } else if (status && status.failure > 0) {
                  // Warning: some failures but has successes - YELLOW
                  statusText = chalk.yellow(`(${status.success} ✓, ${status.failure} ✗)`);
                  successRateText = chalk.yellow(`${successRate}%`);
                } else {
                  // Success: no failures - GREEN
                  statusText = chalk.green(`(${status?.success || 0} ✓)`);
                  successRateText = chalk.green(`${successRate}%`);
                }

                toolTable.push([
                  chalk.white(toolName),
                  chalk.white(count.toString()),
                  chalk.white(`${percentage}%`),
                  statusText,
                  successRateText
                ]);
              }

              console.log(toolTable.toString());
              console.log();
            }
          }

          // 6. BREAKDOWN BY PROJECT
          const byProject: Record<string, {
            sessions: number;
            tokens: number;
            linesGenerated: number;
            filesCreated: number;
            filesModified: number;
            languageStats: Record<string, {
              sessionIds: Set<string>;
              tokens: number;
              lines: number;
              filesCreated: number;
              filesModified: number;
            }>;
            formatStats: Record<string, {
              sessionIds: Set<string>;
              tokens: number;
              lines: number;
              filesCreated: number;
              filesModified: number;
            }>;
          }> = {};

          for (const session of sessions) {
            const projectPath = session.projectPath || 'other';
            if (!byProject[projectPath]) {
              byProject[projectPath] = {
                sessions: 0,
                tokens: 0,
                linesGenerated: 0,
                filesCreated: 0,
                filesModified: 0,
                languageStats: {},
                formatStats: {}
              };
            }

            const project = byProject[projectPath];
            project.sessions++;
            project.tokens += session.tokens.total;
            project.linesGenerated += session.fileStats?.totalLinesAdded || 0;
            project.filesCreated += session.fileStats?.filesCreated || 0;
            project.filesModified += session.fileStats?.filesModified || 0;

            // Aggregate language stats for this project
            // We track unique sessions per language using Set
            if (session.fileStats?.byLanguage) {
              for (const [lang, stats] of Object.entries(session.fileStats.byLanguage)) {
                if (!project.languageStats[lang]) {
                  project.languageStats[lang] = {
                    sessionIds: new Set(),
                    tokens: 0,
                    lines: 0,
                    filesCreated: 0,
                    filesModified: 0
                  };
                }
                // Track unique session ID
                project.languageStats[lang].sessionIds.add(session.sessionId);
                // Attribute tokens proportionally based on lines generated
                const totalLinesInSession = session.fileStats.totalLinesAdded || 1;
                const tokenShare = (stats.linesAdded / totalLinesInSession) * session.tokens.total;
                project.languageStats[lang].tokens += tokenShare;
                project.languageStats[lang].lines += stats.linesAdded;
                project.languageStats[lang].filesCreated += stats.filesCreated;
                project.languageStats[lang].filesModified += stats.filesModified;
              }
            }

            // Aggregate format stats for this project
            if (session.fileStats?.byFormat) {
              for (const [format, stats] of Object.entries(session.fileStats.byFormat)) {
                if (!project.formatStats[format]) {
                  project.formatStats[format] = {
                    sessionIds: new Set(),
                    tokens: 0,
                    lines: 0,
                    filesCreated: 0,
                    filesModified: 0
                  };
                }
                // Track unique session ID
                project.formatStats[format].sessionIds.add(session.sessionId);
                // Attribute tokens proportionally based on lines generated
                const totalLinesInSession = session.fileStats.totalLinesAdded || 1;
                const tokenShare = (stats.linesAdded / totalLinesInSession) * session.tokens.total;
                project.formatStats[format].tokens += tokenShare;
                project.formatStats[format].lines += stats.linesAdded;
                project.formatStats[format].filesCreated += stats.filesCreated;
                project.formatStats[format].filesModified += stats.filesModified;
              }
            }
          }

          if (Object.keys(byProject).length > 0) {
            console.log(chalk.bold.white('📁 Breakdown by Project\n'));
            const sortedProjects = Object.entries(byProject)
              .sort((a, b) => b[1].linesGenerated - a[1].linesGenerated);

            for (const [projectPath, stats] of sortedProjects) {
              const totalLinesInProjects = Object.values(byProject).reduce((sum, p) => sum + p.linesGenerated, 0);
              const percentage = totalLinesInProjects > 0 ? ((stats.linesGenerated / totalLinesInProjects) * 100).toFixed(1) : '0.0';

              console.log(chalk.cyan(`\n  ${projectPath}\n`));

              // Project summary table
              const projectSummaryTable = new Table({
                head: [chalk.cyan('Sessions'), chalk.cyan('Tokens'), chalk.cyan('Lines'), chalk.cyan('Created'), chalk.cyan('Modified'), chalk.cyan('Share')],
                style: {
                  head: [],
                  border: ['grey']
                },
                colWidths: [12, 16, 10, 11, 12, 10]
              });

              projectSummaryTable.push([
                chalk.white(stats.sessions.toString()),
                chalk.white(stats.tokens.toLocaleString()),
                chalk.white(stats.linesGenerated.toLocaleString()),
                chalk.white(stats.filesCreated.toString()),
                chalk.white(stats.filesModified.toString()),
                chalk.white(`${percentage}%`)
              ]);

              console.log('  ' + projectSummaryTable.toString().split('\n').join('\n  '));

              // Show language breakdown for this project
              if (Object.keys(stats.languageStats).length > 0) {
                console.log(chalk.white('\n    By Language:\n'));
                const sortedLangs = Object.entries(stats.languageStats)
                  .sort((a, b) => b[1].lines - a[1].lines)
                  .slice(0, 10);

                const langTable = new Table({
                  head: [chalk.cyan('Language'), chalk.cyan('Sessions'), chalk.cyan('Tokens'), chalk.cyan('Lines'), chalk.cyan('Created'), chalk.cyan('Modified'), chalk.cyan('Share')],
                  style: {
                    head: [],
                    border: ['grey']
                  },
                  colWidths: [18, 12, 16, 10, 11, 12, 9]
                });

                for (const [lang, langStats] of sortedLangs) {
                  const langPercentage = stats.linesGenerated > 0 ? ((langStats.lines / stats.linesGenerated) * 100).toFixed(1) : '0.0';
                  const sessionCount = langStats.sessionIds.size;
                  langTable.push([
                    chalk.white(lang),
                    chalk.white(sessionCount.toString()),
                    chalk.white(Math.round(langStats.tokens).toLocaleString()),
                    chalk.white(langStats.lines.toLocaleString()),
                    chalk.white(langStats.filesCreated.toString()),
                    chalk.white(langStats.filesModified.toString()),
                    chalk.white(`${langPercentage}%`)
                  ]);
                }

                console.log('    ' + langTable.toString().split('\n').join('\n    '));
              }

              // Show format breakdown for this project
              if (Object.keys(stats.formatStats).length > 0) {
                console.log(chalk.white('\n    By Format:\n'));
                const sortedFormats = Object.entries(stats.formatStats)
                  .sort((a, b) => b[1].lines - a[1].lines)
                  .slice(0, 10);

                const formatTable = new Table({
                  head: [chalk.cyan('Format'), chalk.cyan('Sessions'), chalk.cyan('Tokens'), chalk.cyan('Lines'), chalk.cyan('Created'), chalk.cyan('Modified'), chalk.cyan('Share')],
                  style: {
                    head: [],
                    border: ['grey']
                  },
                  colWidths: [18, 12, 16, 10, 11, 12, 9]
                });

                for (const [format, formatStats] of sortedFormats) {
                  const formatPercentage = stats.linesGenerated > 0 ? ((formatStats.lines / stats.linesGenerated) * 100).toFixed(1) : '0.0';
                  const sessionCount = formatStats.sessionIds.size;
                  formatTable.push([
                    chalk.white(format),
                    chalk.white(sessionCount.toString()),
                    chalk.white(Math.round(formatStats.tokens).toLocaleString()),
                    chalk.white(formatStats.lines.toLocaleString()),
                    chalk.white(formatStats.filesCreated.toString()),
                    chalk.white(formatStats.filesModified.toString()),
                    chalk.white(`${formatPercentage}%`)
                  ]);
                }

                console.log('    ' + formatTable.toString().split('\n').join('\n    '));
              }

              console.log();
            }
          }
        }
      } catch (error: unknown) {
        logger.error('Failed to aggregate analytics:', error);
        process.exit(1);
      }
    });

  return command;
}

// Helper functions

async function updateAnalyticsEnabled(enabled: boolean): Promise<void> {
  // Load current multi-provider config
  const config = await ConfigLoader.loadMultiProviderConfig();

  // Update or create analytics config
  if (!config.analytics) {
    config.analytics = {
      enabled,
      target: 'local',
      localPath: '~/.codemie/analytics',
      flushInterval: 5000,
      maxBufferSize: 100
    };
  } else {
    config.analytics.enabled = enabled;
  }

  // Save updated config
  await ConfigLoader.saveMultiProviderConfig(config);
}
