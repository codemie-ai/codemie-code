import { readFile, writeFile, mkdir, chmod, rm, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDirname, resolveHomeDir, getCodemieHome } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs, CredentialStore } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';
import { ConfigLoader } from '@/utils/config.js';

export const STATUSLINE_NAME = 'statusline';
export const STATUSLINE_DISPLAY_NAME = 'CodeMie Statusline';
export const STATUSLINE_DESCRIPTION = 'Budget usage, project, branch, model, context & token stats for Claude Code';

const SCRIPT_FILENAME = 'codemie-budget-status.js';
const REFRESH_INTERVAL = 60;

export async function installStatusline(): Promise<string> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  const scriptContent = await readFile(
    join(getDirname(import.meta.url), 'plugin/statusline.mjs'),
    'utf-8'
  );

  if (!existsSync(claudeHome)) {
    await mkdir(claudeHome, { recursive: true });
  }

  await writeFile(scriptPath, scriptContent, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json, aborting to avoid data loss',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  settings.statusLine = {
    type: 'command',
    command: `node "${scriptPath}"`,
    refreshInterval: REFRESH_INTERVAL,
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  logger.debug('[Statusline] Installed', ...sanitizeLogArgs({ scriptPath }));
  return scriptPath;
}

export async function uninstallStatusline(): Promise<void> {
  const claudeHome = resolveHomeDir('.claude');
  const scriptPath = join(claudeHome, SCRIPT_FILENAME);
  const settingsPath = join(claudeHome, 'settings.json');

  if (existsSync(scriptPath)) {
    await rm(scriptPath);
  }

  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (settings.statusLine) {
        delete settings.statusLine;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    } catch (parseError) {
      logger.warn(
        '[Statusline] Could not parse settings.json during uninstall',
        ...sanitizeLogArgs({ settingsPath, error: parseError instanceof Error ? parseError.message : String(parseError) })
      );
      throw new ConfigurationError('Could not parse ~/.claude/settings.json');
    }
  }

  logger.debug('[Statusline] Uninstalled');
}

export function isStatuslineInstalled(): boolean {
  return existsSync(join(homedir(), '.claude', SCRIPT_FILENAME));
}

export async function promptBudgetSelection(): Promise<boolean> {
  const config = await ConfigLoader.loadMultiProviderConfig();
  const profileName = config.activeProfile;
  const profile = config.profiles?.[profileName];

  if (!profile?.codeMieUrl || !profile?.baseUrl) return false;

  const store = CredentialStore.getInstance();
  const [sso, jwt] = await Promise.all([
    store.retrieveSSOCredentials(profile.codeMieUrl),
    store.retrieveJWTCredentials(profile.codeMieUrl),
  ]);

  const headers: Record<string, string> = {};
  if (sso?.cookies) {
    headers['cookie'] = Object.entries(sso.cookies).map(([k, v]) => `${k}=${v}`).join(';');
  } else if (jwt?.token) {
    headers['authorization'] = `Bearer ${jwt.token}`;
  } else {
    return false;
  }

  let rows: Array<{ project_name: string }>;
  try {
    const res = await fetch(`${profile.baseUrl}/v1/analytics/budget_usage`, {
      headers: { 'Content-Type': 'application/json', 'X-CodeMie-Client': 'codemie-cli', ...headers },
    });
    if (!res.ok) return false;
    const json = await res.json() as { data?: { rows?: Array<{ project_name: string }> } };
    rows = json?.data?.rows ?? [];
  } catch {
    return false;
  }

  if (!rows.length) return false;

  const inquirer = (await import('inquirer')).default;
  const budgetNames = rows.map(r => r.project_name);
  const { budgetName } = await inquirer.prompt<{ budgetName: string }>([{
    type: 'list',
    name: 'budgetName',
    message: 'Select budget to track in the statusline:',
    choices: budgetNames,
    default: profile.statuslineBudgetName ?? budgetNames[0],
  }]);

  const previousBudgetName = profile.statuslineBudgetName;
  profile.statuslineBudgetName = budgetName;
  await ConfigLoader.saveProfile(profileName, profile);

  if (budgetName !== previousBudgetName) {
    await unlink(join(getCodemieHome(), 'budget-cache.json')).catch(() => {});
  }

  logger.debug('[Statusline] Budget name saved', ...sanitizeLogArgs({ budgetName }));
  return true;
}
