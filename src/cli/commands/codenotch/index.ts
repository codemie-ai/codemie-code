import { Command } from 'commander';
import { getBudgetRows } from './budget.js';
import { buildSnapshot, CODENOTCH_PROVIDER_IDS, type CodenotchProviderId } from './snapshot.js';

/**
 * The Codenotch plugin bridge — an internal command, not a user feature.
 * Codenotch spawns `codemie codenotch snapshot --provider <id>` on its polling
 * cadence and renders the JSON on stdout; exit codes follow
 * docs/design/plugin-protocol.md (0 ok · 3 auth · 4 rate-limited · 5 nothing
 * metered · 1 failure). stdout carries only the payload.
 *
 * Registration is `codemie install codenotch --budget-plugin`.
 */
export function createCodenotchCommand(): Command {
  // Hidden from --help: plumbing for Codenotch's exec protocol, not a user command.
  const command = new Command('codenotch') as Command & { hidden: boolean };
  command.hidden = true;

  command
    .description('Internal: Codenotch plugin bridge (see `codemie install codenotch`)')
    .command('snapshot')
    .requiredOption('--provider <id>', `provider id (${CODENOTCH_PROVIDER_IDS.join(', ')})`)
    .action(async (options: { provider: string }) => {
      const code = await runSnapshot(options.provider as CodenotchProviderId);
      process.exitCode = code;
    });

  return command;
}

const EXIT = { ok: 0, needsAuth: 3, rateLimited: 4, nothingMetered: 5, failed: 1 } as const;

async function runSnapshot(provider: CodenotchProviderId): Promise<number> {
  if (!CODENOTCH_PROVIDER_IDS.includes(provider)) {
    process.stderr.write(`codemie codenotch: unknown provider "${provider}"\n`);
    return EXIT.failed;
  }

  const outcome = await getBudgetRows();
  switch (outcome.kind) {
    case 'not-configured':
    case 'not-authenticated':
      process.stderr.write(`codemie codenotch: ${outcome.reason}\n`);
      return EXIT.needsAuth;
    case 'rate-limited':
      process.stdout.write(JSON.stringify({ retryAfterSeconds: outcome.retryAfterSeconds }) + '\n');
      return EXIT.rateLimited;
    case 'failed':
      process.stderr.write(`codemie codenotch: ${outcome.reason}\n`);
      return EXIT.failed;
    case 'ok': {
      const payload = buildSnapshot(outcome.rows, outcome.profile);
      if (!payload) {
        process.stderr.write(
          `codemie codenotch: no budget rows for ${outcome.profile.userEmail}\n`
        );
        return EXIT.nothingMetered;
      }
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return EXIT.ok;
    }
  }
}
