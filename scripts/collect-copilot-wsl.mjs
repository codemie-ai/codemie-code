#!/usr/bin/env node
/**
 * Collect GitHub Copilot usage artifacts from running WSL distros, for verifying the
 * `copilot-local` analytics scanners (`codemie analytics copilot`) against real data.
 *
 * Run this ON WINDOWS, not inside WSL: discovery deliberately goes through `wsl.exe` and the
 * `\\wsl.localhost\<distro>` UNC share, which is exactly the path
 * `src/cli/commands/analytics/copilot-local/wsl-reader.ts` takes. If this script finds a
 * distro's homes, that reader will too — and if it cannot, the manifest records why, which is
 * the answer we are after.
 *
 * Zero dependencies and a single file, so it can be copied to any machine with Node >= 18 and
 * run without installing anything.
 *
 *   node collect-copilot-wsl.mjs                     # safe default (see below)
 *   node collect-copilot-wsl.mjs --out C:\tmp\probe  # choose the output directory
 *   node collect-copilot-wsl.mjs --days 30           # only sessions touched in the last 30 days
 *   node collect-copilot-wsl.mjs --max-sessions 20   # cap transcripts per home (default 40)
 *   node collect-copilot-wsl.mjs --raw               # copy artifacts verbatim, prompts included
 *
 * WHAT THE SAFE DEFAULT COLLECTS
 *
 * Copilot's artifacts interleave usage numbers with prompt and response text, so the default
 * extracts only the fields the scanners read and leaves the text behind:
 *
 *   - `session-store.db` → JSONL of the allowlisted `assistant_usage_events` columns plus
 *     `sessions.id/cwd/repository/branch/host_type`, exported by `sqlite3` inside the distro.
 *     The `turns` table (user messages, assistant responses) and `sessions.summary` are never
 *     queried. Requires `sqlite3` in the distro; if absent, the store is skipped and the
 *     manifest says so.
 *   - `events.jsonl` → only lines whose `type` is `session.start`, `session.usage_record`,
 *     `session.usage_checkpoint` or `session.shutdown`, and for `session.start` only the
 *     `data.context` block. Every other line, including all message content, is dropped.
 *   - `workspace.yaml` → only its `client_name:` line.
 *   - `data.db` → NOT collected. The desktop app's database holds a GitHub access token. Its
 *     presence and size are recorded; nothing is read from it.
 *
 * Working directories, repository names and branch names ARE collected: the scanners read
 * them, and a verification run has to be able to check that they arrive.
 *
 * `--raw` copies `session-store.db` (+ `-wal`/`-shm`), whole `events.jsonl` files and whole
 * `workspace.yaml` files. That includes prompts, responses and session titles. Use it only
 * when the filtered export is not enough, and treat the output as sensitive.
 *
 * Nothing is ever written into a distro except one temporary copy of the store under its
 * `/tmp`, which is removed again. Stopped distros are never touched: enumerating them over the
 * 9P share would start them as a side effect of running a probe.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Event types kept from a transcript. Mirrors EVENT_MARKERS in the events reader. */
const EVENT_TYPES = new Set([
  'session.start',
  'session.usage_record',
  'session.usage_checkpoint',
  'session.shutdown',
]);

/** `assistant_usage_events` columns the scanner reads. Everything else stays in the distro. */
const USAGE_COLUMNS = [
  'id', 'session_id', 'turn_index', 'agent_id', 'model',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'total_nano_aiu', 'request_multiplier', 'duration_ms',
  'initiator', 'created_at', 'event_id', 'content_filter_triggered', 'finish_reason',
];

/** `sessions` columns the scanner reads. `summary` is prompt-derived and excluded. */
const SESSION_COLUMNS = ['id', 'cwd', 'repository', 'branch', 'host_type', 'created_at', 'updated_at'];

/** UNC roots exposing a distro's filesystem, newest naming first. */
const UNC_ROOTS = ['\\\\wsl.localhost', '\\\\wsl$'];

/** Distros that are infrastructure, not user environments. */
const EXCLUDED_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/** Seconds before a `wsl.exe` call is abandoned, so a hung 9P mount cannot hang the probe. */
const WSL_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const opts = { out: null, raw: false, days: null, maxSessions: 40 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--raw') opts.raw = true;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--days') opts.days = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-sessions') opts.maxSessions = Number.parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.days !== null && (!Number.isFinite(opts.days) || opts.days < 1)) {
    throw new Error('--days must be a positive whole number');
  }
  if (!Number.isFinite(opts.maxSessions) || opts.maxSessions < 1) {
    throw new Error('--max-sessions must be a positive whole number');
  }
  return opts;
}

/** `wsl.exe` with the given arguments. Output is decoded from UTF-16LE, which it writes. */
function wsl(args) {
  const result = spawnSync('wsl.exe', args, { timeout: WSL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) {
    return { code: -1, stdout: '', stderr: String(result.error.message) };
  }
  // `--list` writes UTF-16LE; `--exec`/`sh -c` output is plain UTF-8. Decoding as UTF-16 when
  // the payload is UTF-8 produces mojibake, so pick by whether NUL bytes are present.
  const decode = (buf) => {
    if (!buf || buf.length === 0) return '';
    const hasNul = buf.includes(0);
    return hasNul ? buf.toString('utf16le') : buf.toString('utf8');
  };
  return { code: result.status ?? -1, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

/** Distro names from a `wsl --list` variant, cleaned of decoration. */
function distroNames(args) {
  const { code, stdout, stderr } = wsl(args);
  const names = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((name) => name.length > 0 && !name.startsWith('Windows Subsystem'))
    .filter((name) => !EXCLUDED_DISTROS.has(name.toLowerCase()));
  return { code, names, stderr: stderr.trim().slice(0, 500) };
}

/** The UNC root that actually opens for a distro, or null. */
function distroRoot(distro) {
  for (const root of UNC_ROOTS) {
    const path = join(root, distro);
    try {
      if (existsSync(path)) return path;
    } catch {
      // An unreachable UNC root throws rather than returning false; try the next spelling.
    }
  }
  return null;
}

/**
 * Copilot homes inside a distro, as { unc, posix } pairs.
 *
 * `posix` is the path to use with `wsl.exe` (the distro's own view); `unc` is the Windows path
 * used to read files directly, and is what the analytics reader uses.
 */
function copilotHomes(distro, root) {
  const homes = [];
  const tryHome = (uncBase, posixBase, name) => {
    const unc = join(uncBase, name, '.copilot');
    try {
      if (existsSync(unc)) homes.push({ unc, posix: `${posixBase}/${name}/.copilot` });
    } catch {
      // Not readable over 9P; expected for a mode-700 home.
    }
  };
  try {
    for (const entry of readdirSync(join(root, 'home'), { withFileTypes: true })) {
      if (entry.isDirectory()) tryHome(join(root, 'home'), '/home', entry.name);
    }
  } catch {
    // No /home in this distro, or it is not readable.
  }
  // /root is mode 700 on a standard distro and often simply does not open over 9P.
  try {
    const unc = join(root, 'root', '.copilot');
    if (existsSync(unc)) homes.push({ unc, posix: '/root/.copilot' });
  } catch {
    // Expected.
  }
  return homes;
}

/** `sqlite3` availability inside a distro. */
function hasSqlite(distro) {
  return wsl(['-d', distro, 'sh', '-c', 'command -v sqlite3 >/dev/null 2>&1 && echo yes || echo no'])
    .stdout.trim()
    .endsWith('yes');
}

/**
 * Run one read-only query against a home's store, inside the distro, and return the rows.
 *
 * The store is copied to the distro's own `/tmp` first and removed afterwards: the live file is
 * locked and in WAL mode while Copilot runs, which is the same reason the analytics reader
 * snapshots before opening. Nothing is written to the Copilot home itself.
 */
function queryStore(distro, posixHome, sql) {
  // Joined with "; " rather than newlines: the whole thing travels as ONE Windows argv
  // element, and a newline inside a quoted argument is avoidable risk.
  const script = [
    'set -e',
    'T=$(mktemp -d)',
    `trap 'rm -rf "$T"' EXIT`,
    `cp "${posixHome}/session-store.db" "$T/s.db"`,
    `for x in -wal -shm; do if [ -f "${posixHome}/session-store.db$x" ]; then cp "${posixHome}/session-store.db$x" "$T/s.db$x"; fi; done`,
    `sqlite3 -json "$T/s.db" "${sql}"`,
  ].join('; ');
  const { code, stdout, stderr } = wsl(['-d', distro, 'sh', '-c', script]);
  if (code !== 0) {
    return { ok: false, error: stderr.trim().slice(0, 300) || `exit ${code}`, rows: null };
  }
  const text = stdout.trim();
  if (!text) return { ok: true, error: null, rows: [] };
  try {
    return { ok: true, error: null, rows: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `unparsable sqlite3 output: ${String(e.message).slice(0, 120)}`, rows: null };
  }
}

/** Keep only the usage-bearing lines of a transcript, and trim `session.start` to its context. */
function filterTranscript(text) {
  const kept = [];
  const counts = { total: 0, kept: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    counts.total += 1;
    // Substring prefilter before JSON.parse, same discipline as the events reader: no
    // prompt-bearing line is ever parsed.
    let hit = false;
    for (const type of EVENT_TYPES) {
      if (line.includes(type)) { hit = true; break; }
    }
    if (!hit) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) continue;
    if (event.type === 'session.start') {
      // Only the location block; `producer`/`copilotVersion` are kept as harmless provenance.
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      kept.push(JSON.stringify({
        type: event.type,
        id: event.id,
        timestamp: event.timestamp,
        data: {
          sessionId: data.sessionId,
          producer: data.producer,
          copilotVersion: data.copilotVersion,
          startTime: data.startTime,
          context: data.context,
        },
      }));
    } else {
      kept.push(line);
    }
    counts.kept += 1;
  }
  return { text: kept.join('\n'), counts };
}

/** The `client_name:` line of a workspace.yaml, or null. */
function clientNameOf(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 64)) {
      if (line.startsWith('client_name:')) return line.slice('client_name:'.length).trim();
    }
  } catch {
    return null;
  }
  return null;
}

function fileFacts(path) {
  try {
    const info = statSync(path);
    return { present: true, bytes: info.size, mtime: new Date(info.mtimeMs).toISOString() };
  } catch {
    return { present: false };
  }
}

/** Collect one home. Returns the manifest entry for it. */
function collectHome(distro, home, outDir, opts, sqliteAvailable) {
  const report = {
    // Deliberately NOT the real path: a home path carries the distro user's name. The POSIX
    // parent is enough to tell /home/<user> apart from /root.
    location: home.posix.startsWith('/root') ? '/root/.copilot' : '/home/<user>/.copilot',
    files: {
      'session-store.db': fileFacts(join(home.unc, 'session-store.db')),
      'session-store.db-wal': fileFacts(join(home.unc, 'session-store.db-wal')),
      'data.db': fileFacts(join(home.unc, 'data.db')),
    },
    store: { mode: null, rows: null, sessions: null, schemaVersion: null, error: null },
    transcripts: { found: 0, collected: 0, linesKept: 0, linesSeen: 0 },
    workspaceYaml: { found: 0, withClientName: 0, clientNames: {} },
  };
  mkdirSync(outDir, { recursive: true });

  // --- the usage store ---
  if (!report.files['session-store.db'].present) {
    report.store.mode = 'absent';
  } else if (opts.raw) {
    report.store.mode = 'raw-copy';
    for (const suffix of ['', '-wal', '-shm']) {
      const src = join(home.unc, `session-store.db${suffix}`);
      if (existsSync(src)) {
        try {
          copyFileSync(src, join(outDir, `session-store.db${suffix}`));
        } catch (e) {
          report.store.error = String(e.message).slice(0, 200);
        }
      }
    }
  } else if (!sqliteAvailable) {
    report.store.mode = 'skipped-no-sqlite3';
    report.store.error =
      'sqlite3 is not installed in this distro, so the filtered export could not run. ' +
      'Install it (apt-get install -y sqlite3) and re-run, or pass --raw to copy the database verbatim.';
  } else {
    report.store.mode = 'filtered-export';
    const version = queryStore(distro, home.posix, 'SELECT version FROM schema_version LIMIT 1');
    report.store.schemaVersion = version.ok && version.rows?.[0] ? version.rows[0].version : null;

    // Column lists, so a schema change is visible even when a column is not exported.
    for (const table of ['assistant_usage_events', 'sessions']) {
      const info = queryStore(distro, home.posix, `PRAGMA table_info(${table})`);
      if (info.ok) {
        writeFileSync(join(outDir, `table_info.${table}.json`), JSON.stringify(info.rows, null, 1));
      }
    }

    const since = opts.days === null
      ? ''
      : ` WHERE created_at >= '${new Date(Date.now() - opts.days * 86_400_000).toISOString()}'`;
    const usage = queryStore(
      distro,
      home.posix,
      `SELECT ${USAGE_COLUMNS.join(', ')} FROM assistant_usage_events${since} ORDER BY id`
    );
    if (usage.ok && usage.rows) {
      writeFileSync(join(outDir, 'assistant_usage_events.jsonl'), usage.rows.map((r) => JSON.stringify(r)).join('\n'));
      report.store.rows = usage.rows.length;
    } else {
      report.store.error = usage.error;
    }
    const sessions = queryStore(distro, home.posix, `SELECT ${SESSION_COLUMNS.join(', ')} FROM sessions`);
    if (sessions.ok && sessions.rows) {
      writeFileSync(join(outDir, 'sessions.jsonl'), sessions.rows.map((r) => JSON.stringify(r)).join('\n'));
      report.store.sessions = sessions.rows.length;
    }
  }

  // --- per-session transcripts and workspace.yaml ---
  const stateRoot = join(home.unc, 'session-state');
  let entries = [];
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    entries = [];
  }
  const floorMs = opts.days === null ? 0 : Date.now() - opts.days * 86_400_000;
  const eventsDir = join(outDir, 'events');
  const yamlLines = [];

  // Newest first, so a capped run keeps the most relevant sessions.
  const dated = entries
    .map((entry) => {
      const file = join(stateRoot, entry.name, 'events.jsonl');
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { id: entry.name, file, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const session of dated) {
    const yaml = join(stateRoot, session.id, 'workspace.yaml');
    if (existsSync(yaml)) {
      report.workspaceYaml.found += 1;
      if (opts.raw) {
        mkdirSync(join(outDir, 'workspace'), { recursive: true });
        try {
          copyFileSync(yaml, join(outDir, 'workspace', `${session.id}.workspace.yaml`));
        } catch {
          // Unreadable; the count already records that it was there.
        }
      }
      const client = clientNameOf(yaml);
      if (client) {
        report.workspaceYaml.withClientName += 1;
        report.workspaceYaml.clientNames[client] = (report.workspaceYaml.clientNames[client] ?? 0) + 1;
        yamlLines.push(`${session.id}\t${client}`);
      }
    }

    if (session.mtime === 0 || session.mtime < floorMs) continue;
    report.transcripts.found += 1;
    if (report.transcripts.collected >= opts.maxSessions) continue;

    try {
      const text = readFileSync(session.file, 'utf8');
      mkdirSync(eventsDir, { recursive: true });
      if (opts.raw) {
        writeFileSync(join(eventsDir, `${session.id}.events.jsonl`), text);
        report.transcripts.linesSeen += text.split(/\r?\n/).length;
        report.transcripts.linesKept += text.split(/\r?\n/).length;
      } else {
        const filtered = filterTranscript(text);
        writeFileSync(join(eventsDir, `${session.id}.usage.jsonl`), filtered.text);
        report.transcripts.linesSeen += filtered.counts.total;
        report.transcripts.linesKept += filtered.counts.kept;
      }
      report.transcripts.collected += 1;
    } catch {
      // A transcript being written right now; skip it.
    }
  }

  if (yamlLines.length > 0) {
    writeFileSync(join(outDir, 'workspace-client-names.tsv'), `session_id\tclient_name\n${yamlLines.join('\n')}\n`);
  }
  return report;
}

const README = `GitHub Copilot WSL collection
=============================

Produced by scripts/collect-copilot-wsl.mjs for verifying the "codemie analytics copilot"
scanners against real WSL data.

manifest.json  - what was found: distros, UNC root reached, per-home file facts and counts.
distros/<name>/home-N/
  assistant_usage_events.jsonl  allowlisted usage columns (no prompt text)
  sessions.jsonl                session id, cwd, repository, branch, host_type
  table_info.*.json             column lists, so schema drift is visible
  events/<session>.usage.jsonl  only session.start/usage_record/usage_checkpoint/shutdown lines
  workspace-client-names.tsv    session id -> client_name, the surface signal

In the default mode no prompt or response text is collected, and the desktop app's data.db is
not read at all (it holds a GitHub access token). Working directories, repository names and
branch names ARE included - the scanners read them, so verification needs them.

If this was produced with --raw it contains verbatim databases and transcripts, INCLUDING
prompts, responses and session titles. Treat it as sensitive.
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outRoot = opts.out ?? join(process.cwd(), `copilot-wsl-collection-${stamp}`);
  const manifest = {
    tool: 'collect-copilot-wsl.mjs',
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: opts.raw ? 'raw (includes prompt text)' : 'filtered (no prompt text)',
    options: { days: opts.days, maxSessions: opts.maxSessions, raw: opts.raw },
    host: { platform: platform(), node: process.version },
    wsl: {},
    distros: [],
  };

  if (platform() !== 'win32') {
    console.error(`This script must run on Windows: WSL discovery goes through wsl.exe and the`);
    console.error(`\\\\wsl.localhost share, which is the path the analytics reader uses.`);
    console.error(`Detected platform: ${platform()}`);
    return 2;
  }

  const running = distroNames(['--list', '--running', '--quiet']);
  const all = distroNames(['--list', '--quiet']);
  manifest.wsl = {
    runningExitCode: running.code,
    listExitCode: all.code,
    running: running.names,
    // Names only: a stopped distro is never touched, since enumerating it over the 9P share
    // would start it as a side effect of running a probe.
    stopped: all.names.filter((name) => !running.names.includes(name)),
    stderr: running.stderr || all.stderr || null,
  };

  console.log(`Running distros: ${running.names.length ? running.names.join(', ') : '(none)'}`);
  if (manifest.wsl.stopped.length > 0) {
    console.log(`Stopped (not touched): ${manifest.wsl.stopped.join(', ')}`);
  }
  if (running.names.length === 0) {
    console.log('\nNothing to collect. Start the distro you use Copilot in, then re-run.');
    if (running.code !== 0) console.log(`wsl.exe --list --running exited ${running.code}: ${running.stderr}`);
  }

  mkdirSync(outRoot, { recursive: true });

  for (const distro of running.names) {
    const entry = { name: distro, uncRoot: null, sqlite3: false, homes: [] };
    const root = distroRoot(distro);
    entry.uncRoot = root ? root.replace(distro, '<distro>') : null;
    if (!root) {
      entry.error = 'no readable UNC root (\\\\wsl.localhost or \\\\wsl$)';
      console.log(`  ${distro}: ${entry.error}`);
      manifest.distros.push(entry);
      continue;
    }
    entry.sqlite3 = hasSqlite(distro);
    const homes = copilotHomes(distro, root);
    console.log(`  ${distro}: ${homes.length} Copilot home(s), sqlite3 ${entry.sqlite3 ? 'present' : 'MISSING'}`);

    homes.forEach((home, index) => {
      const dir = join(outRoot, 'distros', distro, `home-${index + 1}`);
      const report = collectHome(distro, home, dir, opts, entry.sqlite3);
      entry.homes.push(report);
      const store = report.store.rows === null ? report.store.mode : `${report.store.rows} usage row(s)`;
      console.log(
        `    home-${index + 1}: ${store}; ` +
          `${report.transcripts.collected}/${report.transcripts.found} transcript(s); ` +
          `${report.workspaceYaml.withClientName}/${report.workspaceYaml.found} workspace.yaml with client_name`
      );
      if (report.store.error) console.log(`      store: ${report.store.error}`);
    });
    manifest.distros.push(entry);
  }

  writeFileSync(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outRoot, 'README.txt'), README);

  console.log(`\nWrote ${outRoot}`);
  console.log(`Zip it with:\n  powershell -NoProfile -Command "Compress-Archive -Path '${outRoot}\\*' -DestinationPath '${outRoot}.zip'"`);
  if (opts.raw) {
    console.log('\nWARNING: --raw output contains prompts, responses and session titles. Treat it as sensitive.');
  }
  return 0;
}

/** True when this file is the process entry point, not an import. */
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return resolve(invoked) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Exported so the filtering can be checked against real transcripts without running a
// collection (and so a future test can import them).
export { filterTranscript, clientNameOf, parseArgs, distroNames, EVENT_TYPES, USAGE_COLUMNS };

if (isEntryPoint()) {
  process.exit(main());
}
