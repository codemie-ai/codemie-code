/**
 * Test Metrics CLI Command
 *
 * Send a single test metric to the CodeMie API to verify the metrics endpoint
 * is operational and accepts data for a given agent/model.
 *
 * Usage:
 *   codemie test-metrics                              # Send with defaults
 *   codemie test-metrics --agent codemie-code          # Specify agent
 *   codemie test-metrics --model anthropic/claude-4    # Specify model
 *   codemie test-metrics --client-type custom          # Override clientType header
 *   codemie test-metrics --project my-project          # Specify project name
 *   codemie test-metrics --dry-run --verbose           # Show payload + curl
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { basename, dirname } from 'path';
import type { SessionMetric } from '../../providers/plugins/sso/session/processors/metrics/metrics-types.js';
import { CODEMIE_ENDPOINTS } from '../../providers/plugins/sso/sso.http-client.js';
import { detectGitBranch } from '../../utils/processes.js';

export function createTestMetricsCommand(): Command {
  const command = new Command('test-metrics');

  command
    .description('Send a test metric to the CodeMie API to verify endpoint connectivity')
    .option('-a, --agent <name>', 'Agent name in the metric', 'codemie-code')
    .option('-m, --model <id>', 'Model name in the metric', 'test-model')
    .option('--client-type <type>', 'Override X-CodeMie-Client header (auto-detected from agent if not provided)')
    .option('--project <name>', 'SSO project name (optional)')
    .option('--dry-run', 'Show payload and curl command without sending')
    .option('-v, --verbose', 'Show full request/response details')
    .action(async (options: { agent: string; model: string; clientType?: string; project?: string; dryRun?: boolean; verbose?: boolean }) => {
      try {
        await runTestMetrics(options);
      } catch (error) {
        console.error(chalk.red('Failed to send test metric'));
        if (error instanceof Error) {
          console.error(chalk.dim(error.message));
        }
        process.exit(1);
      }
    });

  return command;
}

async function runTestMetrics(options: {
  agent: string;
  model: string;
  clientType?: string;
  project?: string;
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<void> {
  // 1. Load agent configuration to extract clientType
  const { AgentRegistry } = await import('../../agents/registry.js');
  let clientType = options.clientType || 'codemie-cli';

  try {
    const agent = AgentRegistry.getAgent(options.agent);
    // Extract clientType from agent metadata (pattern from install.ts:193, hook.ts:522)
    const agentClientType = (agent as any)?.metadata?.ssoConfig?.clientType;
    if (agentClientType && !options.clientType) {
      clientType = agentClientType;
    }
  } catch {
    // Agent not found or error loading - use fallback clientType
    if (options.verbose) {
      console.log(chalk.dim(`Could not load agent '${options.agent}', using clientType: ${clientType}`));
    }
  }

  // 2. Load active profile to get SSO URL and project name
  const { ConfigLoader } = await import('../../utils/config.js');
  const config = await ConfigLoader.load();

  const ssoUrl = config.codeMieUrl || process.env.CODEMIE_URL;
  if (!ssoUrl) {
    throw new Error('No CodeMie URL configured. Run: codemie setup');
  }

  const projectName = options.project || config.codeMieProject;

  if (options.verbose) {
    console.log(chalk.dim(`SSO URL: ${ssoUrl}`));
    console.log(chalk.dim(`Agent: ${options.agent}  ClientType: ${clientType}`));
    if (projectName) {
      console.log(chalk.dim(`Project: ${projectName}`));
    }
  }

  // 3. Retrieve SSO credentials
  const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
  const sso = new CodeMieSSO();
  const credentials = await sso.getStoredCredentials(ssoUrl);

  if (!credentials?.cookies) {
    throw new Error('No SSO credentials found. Run: codemie setup');
  }

  const apiUrl = credentials.apiUrl;
  if (!apiUrl) {
    throw new Error('No API URL in stored credentials');
  }

  const cookieHeader = Object.entries(credentials.cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');

  if (options.verbose) {
    console.log(chalk.dim(`API URL: ${apiUrl}`));
    console.log(chalk.dim(`Cookies: ${cookieHeader.substring(0, 40)}...`));
  }

  // 4. Build test metric payload
  const cwd = process.cwd();
  const branch = await detectGitBranch(cwd) || 'unknown';
  const repository = `${basename(dirname(cwd))}/${basename(cwd)}`;
  const sessionId = `test_${Date.now()}`;
  const cliVersion = process.env.CODEMIE_CLI_VERSION || '1.0.0';

  const metric: SessionMetric = {
    name: 'codemie_cli_usage_total',
    attributes: {
      agent: options.agent,
      agent_version: cliVersion,
      llm_model: options.model,
      repository,
      session_id: sessionId,
      branch,
      ...(projectName && { project: projectName }), // Conditional inclusion

      total_user_prompts: 1,
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_input_tokens: 0,
      total_cache_creation_tokens: 0,
      total_tool_calls: 1,
      successful_tool_calls: 1,
      failed_tool_calls: 0,
      files_created: 0,
      files_modified: 0,
      files_deleted: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      session_duration_ms: 1000,
      had_errors: false,
      count: 1
    }
  };

  // 5. Dry-run: show payload and curl
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.METRICS}`;

  if (options.dryRun || options.verbose) {
    console.log(chalk.bold('\nPayload:'));
    console.log(JSON.stringify(metric, null, 2));
  }

  if (options.dryRun) {
    console.log(chalk.bold('\nEquivalent curl:'));
    const curlCookie = cookieHeader.substring(0, 20) + '...';
    console.log(`curl -X POST '${url}' \\`);
    console.log(`  -H 'Content-Type: application/json' \\`);
    console.log(`  -H 'Cookie: ${curlCookie}' \\`);
    console.log(`  -H 'User-Agent: codemie-cli/${cliVersion}' \\`);
    console.log(`  -H 'X-CodeMie-CLI: codemie-cli/${cliVersion}' \\`);
    console.log(`  -H 'X-CodeMie-Client: ${clientType}' \\`);
    console.log(`  -d '${JSON.stringify(metric)}'`);
    return;
  }

  // 6. Send the metric
  console.log(chalk.blue(`Sending test metric to ${url}...`));
  console.log(chalk.dim(`  agent=${options.agent}  model=${options.model}  clientType=${clientType}  session=${sessionId}`));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `codemie-cli/${cliVersion}`,
    'X-CodeMie-CLI': `codemie-cli/${cliVersion}`,
    'X-CodeMie-Client': clientType,
    'Cookie': cookieHeader
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(metric)
  });

  const responseText = await response.text();

  // 7. Print result
  if (options.verbose) {
    console.log(chalk.bold('\nResponse:'));
    console.log(chalk.dim(`  Status: ${response.status} ${response.statusText}`));
    console.log(chalk.dim(`  Body: ${responseText}`));
  }

  if (response.ok) {
    console.log(chalk.green(`\n✓ Metric sent successfully (HTTP ${response.status})`));
    try {
      const data = JSON.parse(responseText);
      if (data.message) {
        console.log(chalk.dim(`  ${data.message}`));
      }
    } catch {
      // response may not be JSON
    }
  } else {
    console.error(chalk.red(`\n✗ Metric send failed (HTTP ${response.status})`));
    try {
      const data = JSON.parse(responseText);
      if (data.message) console.error(chalk.dim(`  Message: ${data.message}`));
      if (data.details) console.error(chalk.dim(`  Details: ${data.details}`));
      if (data.help) console.error(chalk.dim(`  Help: ${data.help}`));
    } catch {
      console.error(chalk.dim(`  ${responseText}`));
    }
    process.exit(1);
  }
}
