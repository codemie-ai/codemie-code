/**
 * `codemie proxy doctor`: the full proxy diagnosis, rendered from `composeProxyDoctor`.
 * Exits non-zero on an error section only (`process.exitCode`); warnings and an unconnected proxy exit 0.
 * The gateway key is never printed.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { HealthCheckFormatter } from '../../doctor/formatter.js';
import { printNext } from '../../../related-commands.js';
import { composeProxyDoctor, type ProxyDoctorReport, type ProxyDoctorVerbose } from './compose.js';
import { PROXY_DOCTOR_GROUPS } from './groups.js';

interface ProxyDoctorCliOptions {
  verbose?: boolean;
  json?: boolean;
}

function formatVerbose(verbose: ProxyDoctorVerbose): string[] {
  const lines: string[] = [chalk.bold('Details:')];
  const desktop = verbose.desktop;
  if (desktop) {
    lines.push('  Claude Desktop:');
    lines.push(`    Base directory:   ${desktop.directories.base}`);
    lines.push(`    Local sessions:   ${desktop.directories.localSessions}`);
    lines.push(`    Code sessions:    ${desktop.directories.codeSessions}`);
    lines.push(`    Credentials:      ${desktop.hasCredentials ? `present${desktop.credentialsUrl ? ` (${desktop.credentialsUrl})` : ''}` : 'missing'}`);
    if (desktop.sessions.length === 0) {
      lines.push('    Sessions:         none');
    } else {
      lines.push('    Sessions:');
      for (const s of desktop.sessions) {
        const reasons = s.reasons.length > 0 ? ` — ${s.reasons.join('; ')}` : '';
        lines.push(`      ${s.externalSessionId}  ${s.sessionStatus}  ${s.ingested ? 'ingested' : 'not ingested'}  ${s.workingDirectory}${reasons}`);
      }
    }
  }
  lines.push('  Config files:');
  lines.push(`    Claude settings:      ${verbose.configPaths.claudeSettings}`);
  lines.push(`    Copilot connectors:   ${verbose.configPaths.copilotConnectors}`);
  for (const [name, path] of Object.entries(verbose.configPaths.preferences)) {
    lines.push(`    Preferences (${name}): ${path}`);
  }
  return lines;
}

/** One heading per display group that has sections, in the fixed group order. */
function displaySections(report: ProxyDoctorReport): void {
  const formatter = new HealthCheckFormatter();
  for (const group of PROXY_DOCTOR_GROUPS) {
    const details = report.sections.filter((section) => group.ids.includes(section.id));
    if (details.length === 0) continue;
    formatter.displayCheck({
      name: group.title,
      success: !details.some((section) => section.status === 'error'),
      details: details.map(({ status, message, hint }) => ({ status, message, ...(hint !== undefined && { hint }) })),
    });
  }
}

/** The closing count line, e.g. `2 warnings, 0 errors`. */
export function summaryLine(report: ProxyDoctorReport): string {
  const count = (status: string): number => report.sections.filter((section) => section.status === status).length;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(count('warn'), 'warning')}, ${plural(count('error'), 'error')}`;
}

export function createProxyDoctorCommand(): Command {
  const command = new Command('doctor');
  command
    .description('Diagnose the proxy, its clients and analytics delivery')
    .option('-v, --verbose', 'Include Claude Desktop directories and sessions, and config file paths')
    .option('--json', 'Emit the diagnosis as one JSON document')
    .action(async (opts: ProxyDoctorCliOptions) => {
      const report = await composeProxyDoctor({ authProbe: true, verbose: Boolean(opts.verbose) });
      const hasError = report.sections.some((s) => s.status === 'error');

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        displaySections(report);
        if (report.verbose) {
          for (const line of formatVerbose(report.verbose)) console.log(line);
          console.log();
        }
        const summary = summaryLine(report);
        console.log(hasError ? chalk.red(summary) : summary);
      }

      if (hasError) process.exitCode = 1;
      else printNext('proxy doctor', undefined, { json: opts.json });
    });
  return command;
}
