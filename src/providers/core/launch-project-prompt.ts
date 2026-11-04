/**
 * One-time launch prompt that lets an `unowned` global profile pick its own
 * CodeMie project (EPMCDME-15411). Project selection stays in core; the
 * integration step comes from the SSO plugin.
 */
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { CodeMieIntegrationInfo } from '../../env/types.js';
import { sanitizeDisplayText } from '../../utils/project-binding.js';
import { logger } from '../../utils/logger.js';
import { accountProjects, fetchCodeMieUserInfo, type ProjectListAuth } from './codemie-auth-helpers.js';

/** Short limits: this runs on every launch of an unowned profile and must not stall it. */
const LAUNCH_FETCH_TIMEOUT_MS = 5000;

const OFF_CODEMIE = Symbol('off-codemie');

export type ProjectPromptOutcome =
  | { kind: 'picked'; project: string; integration?: CodeMieIntegrationInfo }
  | { kind: 'off' }
  | { kind: 'unavailable'; reason: string };

export interface ProjectPromptInput {
  profileName: string;
  /** Project the profile currently falls back to (last saved by setup). */
  sharedProject?: string;
  auth: ProjectListAuth;
  /** Offer "Keep this profile off CodeMie" (subscription providers). */
  canStayOff: boolean;
  /** Select a LiteLLM integration for the picked project (providers that require one). */
  requiresIntegration: boolean;
}

/** Seams for tests; production uses the real implementations. */
export interface ProjectPromptDeps {
  fetchProjects?: (auth: ProjectListAuth) => Promise<string[]>;
  prompt?: typeof inquirer.prompt;
  selectIntegration?: (apiUrl: string, cookies: Record<string, string>, project: string) => Promise<CodeMieIntegrationInfo | undefined>;
  exit?: (code: number) => never;
}

async function defaultFetchProjects(auth: ProjectListAuth): Promise<string[]> {
  const options = { timeout: LAUNCH_FETCH_TIMEOUT_MS, maxRetries: 0 };
  const userInfo = 'jwtToken' in auth
    ? await fetchCodeMieUserInfo(auth.apiUrl, auth.jwtToken, options)
    : await fetchCodeMieUserInfo(auth.apiUrl, auth.cookies, options);
  return accountProjects(userInfo);
}

async function defaultSelectIntegration(
  apiUrl: string,
  cookies: Record<string, string>,
  project: string
): Promise<CodeMieIntegrationInfo | undefined> {
  const { selectIntegrationForProject } = await import('../plugins/sso/sso.setup-steps.js');
  return selectIntegrationForProject(apiUrl, cookies, project, { onFetchError: 'throw' });
}

/**
 * Ask once which project this profile bills to. Returns `picked`, `off` or
 * `unavailable` (list failed or empty, integration fetch failed). Ctrl-C ends the
 * launch with exit 130 before anything is saved: installed inquirer re-raises
 * SIGINT instead of rejecting, so a prompt-scoped SIGINT listener owns it.
 */
export async function promptProfileProject(
  input: ProjectPromptInput,
  deps: ProjectPromptDeps = {}
): Promise<ProjectPromptOutcome> {
  const fetchProjects = deps.fetchProjects ?? defaultFetchProjects;
  const prompt = deps.prompt ?? inquirer.prompt;
  const selectIntegration = deps.selectIntegration ?? defaultSelectIntegration;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let projects: string[];
  try {
    projects = await fetchProjects(input.auth);
  } catch (error) {
    logger.debug('[launch-project] project list unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'unavailable', reason: 'project-list-failed' };
  }
  if (projects.length === 0) return { kind: 'unavailable', reason: 'project-list-empty' };

  const profileLabel = sanitizeDisplayText(input.profileName);
  const shared = input.sharedProject && projects.includes(input.sharedProject) ? input.sharedProject : undefined;

  const onSigint = (): void => {
    process.stderr.write('\n');
    exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    console.log(chalk.yellow(`\nProfile "${profileLabel}" has no CodeMie project of its own yet.`));
    console.log(chalk.dim('Pick the project this profile bills to; it is saved to this profile only.\n'));

    for (;;) {
      const choices: Array<{ name: string; value: string | typeof OFF_CODEMIE } | InstanceType<typeof inquirer.Separator>> =
        projects.map((p) => ({
          name: p === shared
            ? `${sanitizeDisplayText(p)} ${chalk.dim('(last saved by setup, possibly for another profile)')}`
            : sanitizeDisplayText(p),
          value: p,
        }));
      if (input.canStayOff) {
        choices.push(new inquirer.Separator());
        choices.push({ name: 'Keep this profile off CodeMie', value: OFF_CODEMIE });
      }

      const { project } = await prompt([
        {
          type: 'list',
          name: 'project',
          message: `CodeMie project for profile "${profileLabel}":`,
          choices,
          default: shared,
          pageSize: 15,
        },
      ]) as { project: string | typeof OFF_CODEMIE };

      if (project === OFF_CODEMIE) return { kind: 'off' };

      if (project === shared) {
        const { confirmed } = await prompt([
          {
            type: 'confirm',
            name: 'confirmed',
            message: `Use "${sanitizeDisplayText(project)}" for profile "${profileLabel}"? It was saved by the last setup and may belong to another profile.`,
            default: false,
          },
        ]) as { confirmed: boolean };
        if (!confirmed) continue;
      }

      if (!input.requiresIntegration || !('cookies' in input.auth)) {
        return { kind: 'picked', project };
      }
      try {
        const integration = await selectIntegration(input.auth.apiUrl, input.auth.cookies, project);
        return { kind: 'picked', project, integration };
      } catch (error) {
        logger.debug('[launch-project] integration list unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { kind: 'unavailable', reason: 'integration-list-failed' };
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
