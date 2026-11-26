/**
 * CLI command: codemie mcp-auth [callback-url]
 *
 * Finishes an MCP server login when the browser cannot reach the mcp-proxy's callback server
 * (SSH, containers): shows the authorization URL, then delivers the pasted callback URL to the
 * proxy waiting on this machine.
 */

import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import chalk from 'chalk';
import { listPendingLogins, type PendingLogin } from '../../mcp/auth/pending-login.js';

/**
 * Send a pasted callback URL to the proxy waiting for it and return that proxy's MCP server URL.
 */
export async function deliverCallback(pasted: string, logins: PendingLogin[]): Promise<string> {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error('That is not a URL');
  }

  // Only forward to a callback server a proxy is waiting on, never to an arbitrary address
  const login = logins.find((candidate) => {
    const redirect = new URL(candidate.redirectUrl);
    return redirect.origin === url.origin && redirect.pathname === url.pathname;
  });
  if (!login) {
    throw new Error('No MCP server is waiting for this callback URL');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The MCP proxy rejected the callback (HTTP ${response.status})`);
  }
  return login.serverUrl;
}

export function createMcpAuthCommand(): Command {
  return new Command('mcp-auth')
    .description('Finish an MCP server login by pasting the callback URL from the browser')
    .argument('[callback-url]', 'URL the browser was redirected to after signing in')
    .action(async (callbackUrl?: string) => {
      const logins = listPendingLogins();
      if (logins.length === 0) {
        console.log('No MCP server is waiting for authorization.');
        return;
      }

      if (callbackUrl) {
        try {
          console.log(chalk.green(`Authorized ${await deliverCallback(callbackUrl, logins)}`));
        } catch (error) {
          console.error(chalk.red((error as Error).message));
          process.exitCode = 1;
        }
        return;
      }

      if (!process.stdin.isTTY) {
        console.error('No terminal to paste into: pass the callback URL as an argument.');
        process.exitCode = 1;
        return;
      }

      const reader = createInterface({ input: process.stdin, output: process.stdout });
      reader.on('SIGINT', () => {
        reader.close();
        process.exit(130);
      });
      try {
        for (const login of logins) {
          console.log(`\n${chalk.bold(login.serverUrl)}`);
          console.log(`  1. Open this URL in your browser and sign in:\n     ${login.authorizationUrl}`);
          console.log('  2. Paste the URL the browser was redirected to and press Enter');
          for (;;) {
            try {
              await deliverCallback(await reader.question('> '), [login]);
              console.log(chalk.green('  Authorized'));
              break;
            } catch (error) {
              console.log(chalk.yellow(`  ${(error as Error).message}. Paste it again:`));
            }
          }
        }
      } finally {
        reader.close();
      }
    });
}
