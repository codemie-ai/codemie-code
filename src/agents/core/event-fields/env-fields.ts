import os from 'node:os';

/** Opt-in: the machine environment the session runs in. */
export interface EnvFields {
  os: string;
  timezone: string;
}

/** Never throws; an unavailable value is an empty string. */
export async function resolveEnvFields(): Promise<EnvFields> {
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    /* best-effort */
  }
  let platform = '';
  try {
    platform = os.platform();
  } catch {
    /* best-effort */
  }
  return { os: platform, timezone };
}
