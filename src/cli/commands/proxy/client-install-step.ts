/**
 * Install step for `proxy connect --install-client`: makes sure the client apps
 * the requested targets need are present (macOS), asking before any download,
 * and prepares VS Code so its targets can be configured right away.
 */
import { mkdir } from 'node:fs/promises';
import { ConfigurationError } from '@/utils/errors.js';
import { exec } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import {
  CLIENT_SPECS,
  ClientInstallError,
  findInstalledClient,
  installClient,
  type ClientApp,
  type ClientDownload,
  type ClientSpec,
} from './client-install.js';
import { getVsCodeProductDir } from './connectors/vscode.js';
import type { ConnectTargets } from './connect-orchestrator.js';

export interface InstallClientOptions {
  yes?: boolean;
  insiders?: boolean;
}

const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';
/** Bound on the extension install (it downloads from the marketplace). */
const EXTENSION_TIMEOUT_MS = 5 * 60_000;

/** Throws ConfigurationError for unsupported platform / --insiders. Call before any network work. */
export function assertInstallClientSupported(
  opts: InstallClientOptions,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') {
    throw new ConfigurationError('--install-client is only supported on macOS.');
  }
  if (opts.insiders) {
    throw new ConfigurationError('--install-client does not support --insiders (VS Code Insiders is not installed by the CLI).');
  }
}

function neededApps(targets: ConnectTargets): ClientApp[] {
  const apps = new Set<ClientApp>();
  if (targets.claudeDesktop) apps.add('claude-desktop');
  if (targets.codexDesktop) apps.add('codex-desktop');
  if (targets.vscode || targets.vscodeClaudeCode) apps.add('vscode');
  return [...apps];
}

async function resolveDownload(spec: ClientSpec): Promise<ClientDownload> {
  try {
    return await spec.resolve(fetch);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ClientInstallError(
      `Couldn't reach the ${spec.label} download (${reason}). Check your connection and try again.`,
      spec.downloadPage
    );
  }
}

async function confirmInstall(spec: ClientSpec, download: ClientDownload): Promise<boolean> {
  const size = download.size === undefined ? '' : ` (${(download.size / (1024 * 1024)).toFixed(1)} MB)`;
  const inquirer = (await import('inquirer')).default;
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Download ${spec.label}${size} and install it for your account?`,
      default: false,
    },
  ]);
  return Boolean(confirm);
}

/** Returns 'proceed' or 'cancelled' (user answered no). Throws ClientInstallError / ConfigurationError. */
export async function ensureClientsInstalled(
  targets: ConnectTargets,
  opts: InstallClientOptions
): Promise<'proceed' | 'cancelled'> {
  const paths = new Map<ClientApp, string>();
  const pending: Array<{ spec: ClientSpec; download: ClientDownload }> = [];

  for (const app of neededApps(targets)) {
    const spec = CLIENT_SPECS[app];
    const found = findInstalledClient(spec);
    if (found) {
      paths.set(app, found);
      continue;
    }
    if (!process.stdin.isTTY && !opts.yes) {
      throw new ConfigurationError(
        `${spec.label} is not installed. Re-run with --yes to install it without a prompt.`
      );
    }
    const download = await resolveDownload(spec);
    if (!opts.yes && !(await confirmInstall(spec, download))) {
      console.log('Install cancelled');
      return 'cancelled';
    }
    pending.push({ spec, download });
  }

  for (const { spec, download } of pending) {
    paths.set(spec.app, await installClient(spec, { download }));
  }

  const vscodePath = paths.get('vscode');
  if (vscodePath) {
    const codeDir = getVsCodeProductDir(false);
    await mkdir(codeDir, { recursive: true }).catch((e: unknown) => {
      throw new ClientInstallError(
        `Couldn't create ${codeDir} (${e instanceof Error ? e.message : String(e)}).`,
        CLIENT_SPECS.vscode.downloadPage
      );
    });
  }

  if (targets.vscodeClaudeCode && vscodePath) {
    const cli = `${vscodePath}/Contents/Resources/app/bin/code`;
    const result = await exec(cli, ['--install-extension', CLAUDE_CODE_EXTENSION], { timeout: EXTENSION_TIMEOUT_MS })
      .catch((e: unknown) => ({ code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
    if (result.code !== 0) {
      logger.debug('VS Code extension install failed', result.stderr);
      const firstLine = result.stderr.trim().split('\n')[0] ?? '';
      throw new ClientInstallError(
        `Could not install the Claude Code extension in VS Code: ${firstLine}`,
        CLIENT_SPECS.vscode.downloadPage
      );
    }
  }

  return 'proceed';
}
