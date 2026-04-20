import inquirer from 'inquirer';
import chalk from 'chalk';
import { HTTPClient } from './base/http-client.js';
import type { SSOAuthResult } from './types.js';
import { ConfigurationError } from '../../utils/errors.js';

export const DEFAULT_CODEMIE_BASE_URL = 'https://codemie.lab.epam.com';

export interface CodeMieUserInfo {
  userId: string;
  name: string;
  username: string;
  isAdmin: boolean;
  applications: string[];
  applications_admin: string[];
  applicationsAdmin?: string[];
  picture: string;
  knowledgeBases: string[];
  userType?: string;
}

export function ensureApiBase(rawUrl: string): string {
  let base = rawUrl.replace(/\/$/, '');
  if (!/\/code-assistant-api(\/|$)/i.test(base)) {
    base = `${base}/code-assistant-api`;
  }
  return base;
}

export function buildAuthHeaders(auth: Record<string, string> | string): Record<string, string> {
  const cliVersion = process.env.CODEMIE_CLI_VERSION || 'unknown';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `codemie-cli/${cliVersion}`,
    'X-CodeMie-CLI': `codemie-cli/${cliVersion}`,
    'X-CodeMie-Client': 'codemie-cli'
  };

  if (typeof auth === 'string') {
    headers.authorization = `Bearer ${auth}`;
  } else {
    headers.cookie = Object.entries(auth)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
  }

  return headers;
}

export async function promptForCodeMieUrl(
  defaultUrl: string = DEFAULT_CODEMIE_BASE_URL,
  message: string = 'CodeMie organization URL:'
): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'codeMieUrl',
      message,
      default: defaultUrl,
      validate: (input: string) => {
        if (!input.trim()) {
          return 'CodeMie URL is required';
        }
        if (!input.startsWith('http://') && !input.startsWith('https://')) {
          return 'Please enter a valid URL starting with http:// or https://';
        }
        return true;
      }
    }
  ]);

  return answers.codeMieUrl.trim();
}

export async function authenticateWithCodeMie(
  codeMieUrl: string,
  timeout: number = 120000
): Promise<SSOAuthResult> {
  const { CodeMieSSO } = await import('../plugins/sso/sso.auth.js');
  const sso = new CodeMieSSO();
  return sso.authenticate({
    codeMieUrl,
    timeout
  });
}

/* eslint-disable no-redeclare */
export function fetchCodeMieUserInfo(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<CodeMieUserInfo>;
export function fetchCodeMieUserInfo(
  apiUrl: string,
  jwtToken: string
): Promise<CodeMieUserInfo>;
export async function fetchCodeMieUserInfo(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<CodeMieUserInfo> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}/v1/user`;

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    // Enterprise on-premises CodeMie deployments commonly use self-signed certificates.
    rejectUnauthorized: false
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new ConfigurationError('Authentication failed - invalid or expired credentials');
    }
    throw new ConfigurationError(`Failed to fetch user info: ${response.statusCode} ${response.statusMessage}`);
  }

  const userInfo = JSON.parse(response.data) as CodeMieUserInfo;

  if (!Array.isArray(userInfo.applications_admin) && Array.isArray(userInfo.applicationsAdmin)) {
    userInfo.applications_admin = userInfo.applicationsAdmin;
  }

  if (!userInfo || !Array.isArray(userInfo.applications) || !Array.isArray(userInfo.applications_admin)) {
    throw new ConfigurationError('Invalid user info response: missing applications arrays');
  }

  return userInfo;
}

export async function selectCodeMieProject(authResult: SSOAuthResult): Promise<string> {
  if (!authResult.apiUrl || !authResult.cookies) {
    throw new ConfigurationError('API URL or cookies not found in authentication result');
  }

  const userInfo = await fetchCodeMieUserInfo(
    authResult.apiUrl,
    authResult.cookies
  );

  const applications = userInfo.applications || [];
  const applicationsAdmin = userInfo.applications_admin || [];
  const allProjects = [...new Set([...applications, ...applicationsAdmin])];

  if (allProjects.length === 0) {
    throw new ConfigurationError('No projects found for your account. Please contact your administrator.');
  }

  const sortedProjects = allProjects.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  if (sortedProjects.length === 1) {
    const selectedProject = sortedProjects[0];
    console.log(chalk.green(`✓ Auto-selected project: ${chalk.bold(selectedProject)}`));
    return selectedProject;
  }

  console.log(chalk.dim(`Found ${sortedProjects.length} accessible project(s)`));

  const projectAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'project',
      message: 'Select your project:',
      choices: sortedProjects.map(project => ({
        name: project,
        value: project
      })),
      pageSize: 15
    }
  ]);

  console.log(chalk.green(`✓ Selected project: ${chalk.bold(projectAnswers.project)}`));
  return projectAnswers.project;
}
