/**
 * Prompt-free `git` runner for `codemie analytics sync`'s git-repo delivery target.
 *
 * No git library, no git host REST API — plain `git` through `exec` only. Every call runs
 * with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, ssh `BatchMode=yes` and a per-call
 * timeout, so a daily unattended sync job can never hang on a credential prompt or an unknown
 * host key. No token is ever requested or stored; every thrown message is redacted
 * (`redactSecrets`) before it reaches the caller.
 */

import { exec, type ExecResult } from '@/utils/exec.js';
import { SyncGitError, type GitFailureCause } from '@/utils/errors.js';
import { redactSecrets } from '../redact.js';

export type { GitFailureCause };

/** Timeout for a call that talks to the remote (fetch/push/ls-remote). */
export const NETWORK_TIMEOUT_MS = 120_000;

/** Timeout for a purely local call (config, status, rev-parse, …). */
export const LOCAL_TIMEOUT_MS = 15_000;

const BATCH_MODE_FLAG = '-o BatchMode=yes';

export interface GitRunner {
  (args: string[], opts: { cwd?: string; network?: boolean }): Promise<string>;
}

/**
 * Build the env a `git` subprocess should run with: always prompt-free, and an ssh wrapper
 * that keeps whatever base command is already configured (a non-empty `GIT_SSH_COMMAND`, or
 * `configuredSshCommand` — read from `core.sshCommand` by the caller — or plain `ssh`) and
 * appends `-o BatchMode=yes` unless it is already present. Git ranks `GIT_SSH_COMMAND`, then
 * `core.sshCommand`, then `GIT_SSH`: when only `GIT_SSH` is set (e.g. plink on Windows) no
 * `GIT_SSH_COMMAND` is injected, so the user's own ssh program stays in force — `BatchMode`
 * cannot be appended to a program git invokes without a shell.
 */
export function gitEnv(
  base: NodeJS.ProcessEnv,
  configuredSshCommand?: string
): Record<string, string> {
  const promptFree: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
  };

  const explicitSshCommand = base.GIT_SSH_COMMAND || configuredSshCommand || undefined;
  if (explicitSshCommand === undefined && base.GIT_SSH) {
    return promptFree;
  }

  const baseSshCommand = explicitSshCommand ?? 'ssh';
  const sshCommand = baseSshCommand.includes('BatchMode=yes')
    ? baseSshCommand
    : `${baseSshCommand} ${BATCH_MODE_FLAG}`;

  return { ...promptFree, GIT_SSH_COMMAND: sshCommand };
}

/**
 * Classify a failed git invocation's stderr into a likely cause. Order matters: a protected
 * branch push also prints `[remote rejected]`, so `protected` is checked before `rejected`.
 */
export function classifyGitError(stderr: string): GitFailureCause {
  const text = stderr.toLowerCase();

  if (/protected branch|gh006|pre-receive hook declined/.test(text)) {
    return 'protected';
  }
  if (
    /authentication failed|permission denied \(publickey\)|could not read username|\b403\b|\b401\b/.test(
      text
    )
  ) {
    return 'auth';
  }
  if (/host key verification failed/.test(text)) {
    return 'host-key';
  }
  if (
    /could not resolve host|could not read from remote repository|connection refused|repository not found|timed out/.test(
      text
    )
  ) {
    return 'unreachable';
  }
  if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) {
    return 'rejected';
  }
  return 'other';
}

/** One short line naming the likely cause and the fix, for a `SyncGitError`. */
export function gitHint(cause: GitFailureCause): string {
  switch (cause) {
    case 'auth':
      return 'Likely an authentication problem: check your git credentials or SSH key, e.g. `git ls-remote <url>`.';
    case 'host-key':
      return "Unknown SSH host key: run `ssh -T <host>` once to trust it, then retry.";
    case 'unreachable':
      return 'The git remote could not be reached: check the repository URL and your network connection.';
    case 'rejected':
      return 'The push was rejected (not a fast-forward): fetch and rebase/merge before retrying.';
    case 'protected':
      return 'The target branch is protected: pick an unprotected branch with --git-branch or ask for push access.';
    case 'timeout':
      return 'The git command timed out: check your network connection and retry.';
    case 'other':
    default:
      return 'An unexpected git error occurred: check the command output for details.';
  }
}

async function readConfiguredSshCommand(
  execFn: typeof exec,
  cwd?: string
): Promise<string | undefined> {
  const result = await execFn('git', ['config', '--get', 'core.sshCommand'], {
    cwd,
    env: gitEnv(process.env),
    timeout: LOCAL_TIMEOUT_MS,
  });
  const value = result.stdout.trim();
  return result.code === 0 && value ? value : undefined;
}

/**
 * Create a prompt-free git runner over `execFn` (defaults to `exec` from `@/utils/exec.js`).
 * Each call: resolves the ssh base command (`GIT_SSH_COMMAND` if set, else `core.sshCommand`
 * via a local, prompt-free `git config --get`), builds the prompt-free env, runs `git <args>`
 * with the timeout `opts.network` selects, and resolves trimmed stdout on exit code 0.
 * A non-zero exit or a rejection (including an `exec` timeout) throws a redacted
 * `SyncGitError` carrying its classified `gitCause`.
 */
export function createGitRunner(execFn: typeof exec = exec): GitRunner {
  return async (args: string[], opts: { cwd?: string; network?: boolean }): Promise<string> => {
    const timeout = opts.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;

    const configuredSshCommand = process.env.GIT_SSH_COMMAND
      ? undefined
      : await readConfiguredSshCommand(execFn, opts.cwd);
    const env = gitEnv(process.env, configuredSshCommand);

    let result: ExecResult;
    try {
      result = await execFn('git', args, { cwd: opts.cwd, env, timeout });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause: GitFailureCause = /timed out/i.test(message) ? 'timeout' : 'other';
      throw new SyncGitError(redactSecrets(message), cause);
    }

    if (result.code !== 0) {
      const stderr = result.stderr || `git ${args.join(' ')} exited with code ${result.code}`;
      throw new SyncGitError(redactSecrets(stderr), classifyGitError(stderr));
    }

    return result.stdout.trim();
  };
}
