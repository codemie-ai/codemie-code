#!/usr/bin/env node
// CodeMie statusline — shows budget, project, branch, model, and context stats
// Deployed to ~/.claude/ by `codemie install statusline`. Runs standalone without the project runtime.
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const HOME = process.env.CODEMIE_HOME || path.join(os.homedir(), '.codemie');
const CACHE_FILE = path.join(HOME, 'budget-cache.json');
const CONFIG_FILE = path.join(HOME, 'codemie-cli.config.json');
const CREDS_DIR = path.join(HOME, 'credentials');
const CACHE_TTL_MS = 60_000;

const ENCRYPTION_KEY = (() => {
  const id = os.hostname() + os.platform() + os.arch();
  const hex = crypto.createHash('sha256').update(id).digest('hex');
  return crypto.createHash('sha256').update(hex).digest();
})();

function decrypt(text) {
  const [ivHex, encHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const d = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return d.update(encHex, 'hex', 'utf8') + d.final('utf8');
}

function urlHash(rawUrl) {
  const normalized = rawUrl.replace(/\/$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function readCredsFile(filePath) {
  try {
    return JSON.parse(decrypt(await fs.readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

async function getAuthHeaders(codeMieUrl) {
  const hash = urlHash(codeMieUrl);

  const sso = await readCredsFile(path.join(CREDS_DIR, `sso-${hash}.enc`));
  if (sso?.cookies) {
    return { cookie: Object.entries(sso.cookies).map(([k, v]) => `${k}=${v}`).join(';') };
  }

  const jwt = await readCredsFile(path.join(CREDS_DIR, `jwt-sso-${hash}.enc`));
  if (jwt?.token) {
    return { authorization: `Bearer ${jwt.token}` };
  }

  return null;
}

async function fetchBudget(baseUrl, headers, budgetName) {
  const res = await fetch(`${baseUrl}/v1/analytics/budget_usage`, {
    headers: { 'Content-Type': 'application/json', 'X-CodeMie-Client': 'codemie-cli', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const row = json?.data?.rows?.find(r => r.project_name === budgetName);
  if (!row) throw new Error('row not found');

  const pct = Math.round((row.current_spending / row.budget_limit) * 100);
  return {
    text: `$${row.current_spending.toFixed(2)}/$${row.budget_limit.toFixed(0)} (${pct}%)`,
    pct,
  };
}

const C = {
  reset:  '\x1b[0m',
  purple: '\x1b[38;2;177;185;249m',
  green:  '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  red:    '\x1b[0;31m',
  cyan:   '\x1b[0;36m',
  blue:   '\x1b[0;94m',
  gray:   '\x1b[0;37m',
};

const c = (color, text) => `${color}${text}${C.reset}`;

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function budgetColor(pct) {
  if (pct < 0) return C.yellow;
  return pct > 85 ? C.red : pct > 30 ? C.yellow : C.green;
}

function buildStatusLine({ projectName, branch, model, ctxPct, tokIn, tokOut, budget, budgetPct }) {
  const parts = [];

  if (projectName) parts.push(c(C.purple, `[${projectName}]`));
  if (budget)      parts.push(c(budgetColor(budgetPct), budget));
  if (branch)      parts.push(c(C.blue,   `(${branch})`));
  if (model)       parts.push(c(C.cyan,   `[${model}]`));

  const stats = [];
  if (ctxPct != null) stats.push(`ctx:${ctxPct}%`);
  if (tokIn != null)  stats.push(`in:${fmt(tokIn)}`);
  if (tokOut != null) stats.push(`out:${fmt(tokOut)}`);
  if (stats.length)   parts.push(c(C.gray, stats.join(' ')));

  return parts.join(' | ');
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function gitBranch(cwd) {
  return new Promise(resolve => {
    exec(
      'git --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks rev-parse --short HEAD 2>/dev/null',
      { cwd, timeout: 2000 },
      (_, stdout) => resolve(stdout.trim() || '')
    );
  });
}

async function main() {
  const [stdinRaw, cacheRaw] = await Promise.all([
    readStdin(),
    fs.readFile(CACHE_FILE, 'utf8').catch(() => null),
  ]);

  let projectName = '', cwd = '', model = '', ctxPct = null, tokIn = null, tokOut = null;
  try {
    const ctx = JSON.parse(stdinRaw);
    cwd         = ctx?.workspace?.current_dir ?? ctx?.cwd ?? '';
    projectName = path.basename(cwd);
    model       = ctx?.model?.display_name ?? '';
    ctxPct      = ctx?.context_window?.used_percentage ?? null;
    tokIn       = ctx?.context_window?.total_input_tokens ?? null;
    tokOut      = ctx?.context_window?.total_output_tokens ?? null;
  } catch {}

  const branchPromise = cwd ? gitBranch(cwd) : Promise.resolve('');

  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw);
      if (Date.now() - cache.ts < CACHE_TTL_MS) {
        const branch = await branchPromise;
        process.stdout.write(buildStatusLine({
          projectName, branch, model, ctxPct, tokIn, tokOut,
          budget: cache.value, budgetPct: cache.pct ?? 0,
        }));
        return;
      }
    } catch {}
  }

  let budget = '', budgetPct = 0;

  do {
    let config;
    try {
      config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    } catch {
      budget = '⚠ no config'; budgetPct = -1; break;
    }

    const profile = config.profiles?.[config.activeProfile];
    if (!profile) { budget = '⚠ no profile'; budgetPct = -1; break; }

    const { codeMieUrl, baseUrl, statuslineBudgetName } = profile;
    if (!codeMieUrl || !baseUrl) {
      budget = '⚠ incomplete profile'; budgetPct = -1; break;
    }
    if (!statuslineBudgetName) {
      budget = '⚠ run: codemie install statusline'; budgetPct = -1; break;
    }

    const headers = await getAuthHeaders(codeMieUrl);
    if (!headers) { budget = '⚠ Reauthenticate'; budgetPct = -1; break; }

    const budgetResult = await fetchBudget(baseUrl, headers, statuslineBudgetName).catch(e => ({ error: e.message }));
    if (budgetResult.error) {
      budget = `⚠ ${budgetResult.error}`; budgetPct = -1; break;
    }

    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({ ts: Date.now(), value: budgetResult.text, pct: budgetResult.pct }),
      'utf8'
    );

    budget = budgetResult.text;
    budgetPct = budgetResult.pct;
  } while (false);

  const branch = await branchPromise;

  process.stdout.write(buildStatusLine({
    projectName, branch, model, ctxPct, tokIn, tokOut,
    budget, budgetPct,
  }));
}

main();
