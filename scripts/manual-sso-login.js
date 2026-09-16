#!/usr/bin/env node
/**
 * Manually obtain a CodeMie access token and store it as SSO credentials,
 * bypassing the browser-based OAuth redirect.
 *
 * Why this exists: `codemie profile login --url <url>` always builds its
 * login URL via ensureApiBase(), which unconditionally appends
 * `/code-assistant-api`. Some backends (e.g. the local docker compose
 * backend used for dev/test) mount their routes at the root instead, so the
 * browser SSO flow 404s against them. This script logs in directly against
 * that backend's own `/v1/local-auth/login` endpoint (email + password) and
 * writes the resulting token into the same encrypted credential store the
 * normal SSO flow uses, so `codemie proxy connect` / `codemie-code` pick it
 * up exactly as if the browser flow had succeeded.
 *
 * Requires a `npm run build` (or `dist/` from CI) - it reuses the built
 * CredentialStore from dist/utils/security.js so the encryption/keychain
 * behavior matches the real CLI exactly.
 *
 * Usage:
 *   node scripts/manual-sso-login.js --url http://localhost:8080 --email dev@example.com --password secret
 *   CODEMIE_LOGIN_PASSWORD=secret node scripts/manual-sso-login.js --url http://localhost:8080 --email dev@example.com
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printUsage() {
  console.log(`Usage: node scripts/manual-sso-login.js --url <base-url> --email <email> [--password <password>]

Options:
  --url <base-url>       Backend base URL, root-mounted (no /code-assistant-api), e.g. http://localhost:8080
  --email <email>        Login email/username for POST /v1/local-auth/login
  --password <password>  Login password (or set CODEMIE_LOGIN_PASSWORD / omit to be prompted)
  -h, --help             Show this help

This stores credentials under the same key codemie profile login/proxy connect
look up (protocol+host of --url), so it must match the profile's baseUrl exactly.`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; return opts; }
    if (arg === '--url') { opts.url = argv[++i]; continue; }
    if (arg === '--email') { opts.email = argv[++i]; continue; }
    if (arg === '--password') { opts.password = argv[++i]; continue; }
  }
  return opts;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function loadDistModule(relPath) {
  const distPath = join(__dirname, '..', 'dist', relPath);
  try {
    return await import(`file://${distPath}`);
  } catch (err) {
    console.error(`Failed to load ${distPath}. Run "npm run build" first.\n${err.message}`);
    process.exit(1);
  }
}

function decodeJwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }
  if (!opts.url || !opts.email) {
    printUsage();
    process.exit(1);
  }

  const password = opts.password || process.env.CODEMIE_LOGIN_PASSWORD || (await prompt('Password: '));
  if (!password) {
    console.error('A password is required (--password, CODEMIE_LOGIN_PASSWORD, or interactive prompt).');
    process.exit(1);
  }

  const baseUrl = opts.url.replace(/\/$/, '');
  const loginUrl = `${baseUrl}/v1/local-auth/login`;

  console.log(`Logging in to ${loginUrl} as ${opts.email} ...`);
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: opts.email, password }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`Login failed: ${response.status} ${response.statusText}\n${body}`);
    process.exit(1);
  }

  const data = await response.json();
  const accessToken = data.access_token;
  if (!accessToken) {
    console.error('Login response did not include access_token.');
    process.exit(1);
  }

  const { CredentialStore } = await loadDistModule('utils/security.js');
  const store = CredentialStore.getInstance();

  const expiresAt = decodeJwtExpiry(accessToken) ?? Date.now() + 24 * 60 * 60 * 1000;
  const credentials = {
    cookies: { codemie_access_token: accessToken },
    apiUrl: baseUrl,
    expiresAt,
  };

  await store.storeSSOCredentials(credentials, baseUrl);

  console.log(`Stored SSO credentials for ${baseUrl} (user: ${data.user?.email ?? opts.email}).`);
  console.log(`Expires: ${new Date(expiresAt).toISOString()}`);
  console.log('You can now run `codemie proxy connect ...` / `codemie-code` against this profile without the browser SSO flow.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
