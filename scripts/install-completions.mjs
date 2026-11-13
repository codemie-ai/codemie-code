#!/usr/bin/env node
// Best-effort installation of packaged, prebuilt shell completions. This module
// deliberately has no dependency on the compiled CLI or npm lifecycle stdin.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, linkSync, unlinkSync, writeFileSync, openSync, closeSync, readSync, writeSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uid = process.getuid?.();
const marker = '# CodeMie completion managed';
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (base, path) => { const r = relative(base, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const fishEscape = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

function safeDirectory(path, home, create = false) {
  if (!inside(home, path)) return false;
  let current = home;
  const parts = relative(home, path).split(sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    if (!existsSync(current)) {
      if (!create) return false;
      mkdirSync(current, { mode: 0o700 });
    }
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022)) return false;
  }
  return true;
}

function safeFile(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && st.uid === uid && !(st.mode & 0o022);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function atomicWrite(path, content, existing) {
  const temp = join(dirname(path), `.codemie-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: existing !== null ? (lstatSync(path).mode & 0o777) : 0o644 });
    if (existing !== null) {
      if (!safeFile(path) || readFileSync(path, 'utf8') !== existing) return false;
      renameSync(temp, path);
    } else {
      // link() refuses to replace an existing name, including a symlink.
      linkSync(temp, path);
    }
    return true;
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function missingPreviousHelper(encodedOwner) {
  // A malformed marker or an inaccessible path is not evidence of a stale install.
  const previousRoot = Buffer.from(encodedOwner, 'hex').toString('utf8');
  if (Buffer.from(previousRoot).toString('hex') !== encodedOwner || !isAbsolute(previousRoot) || resolve(previousRoot) !== previousRoot || previousRoot.includes('\0')) return false;
  try {
    lstatSync(join(previousRoot, 'dist', 'cli', 'completion', 'dynamic.js'));
    return false;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

function installFile(target, source, owner, shell, helper) {
  const transformed = source.replaceAll('__CODEMIE_COMPLETION_HELPER__', shell === 'fish' ? fishEscape(helper) : helper.replaceAll("'", "'\\''"));
  // Keep #compdef as the first line: compinit reads it without executing the file.
  const lines = transformed.split('\n');
  const first = shell === 'zsh' && lines[0].startsWith('#compdef ') ? `${lines.shift()}\n` : '';
  if (shell === 'zsh' && !first) throw new Error('Invalid zsh completion: missing #compdef');
  const guard = shell === 'fish' ? `test -f ${quoteFish(helper)}; or return\n` : `[ -f ${quote(helper)} ] || return\n`;
  const body = `${first}${guard}${lines.join('\n')}`;
  const header = `${marker} ${owner} ${digest(body)}\n`;
  const content = first ? `${first}${header}${guard}${lines.join('\n')}` : `${header}${body}`;
  let old = null;
  try {
    const st = lstatSync(target);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022)) return false;
    old = readFileSync(target, 'utf8');
    const match = old.match(/^(#compdef [^\n]*\n)?# CodeMie completion managed ([a-f0-9]+) ([a-f0-9]{64})\n/);
    if (!match || digest((match[1] ?? '') + old.slice(match[0].length)) !== match[3]) return false;
    if (match[2] !== owner && !missingPreviousHelper(match[2])) return false;
    if (old === content) return true;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return atomicWrite(target, content, old);
}

function quoteFish(value) { return `'${fishEscape(value)}'`; }

function prompt(block, rc) {
  let tty;
  try {
    tty = openSync('/dev/tty', 'r+');
    writeSync(tty, `\nCodeMie can add this removable completion block to ${rc}:\n${block}\nAdd it? [y/N] `);
    let answer = '';
    const byte = Buffer.alloc(1);
    while (answer.length < 32 && readSync(tty, byte, 0, 1, null) === 1 && byte[0] !== 10 && byte[0] !== 13) answer += byte.toString();
    return /^(y|yes)$/i.test(answer.trim());
  } catch { return false; } finally { if (tty !== undefined) closeSync(tty); }
}

function addRcBlock(rc, home, block, id) {
  if (!safeDirectory(dirname(rc), home)) return false;
  let old = null;
  try {
    lstatSync(rc);
    if (!safeFile(rc)) return false;
    old = readFileSync(rc, 'utf8');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old?.includes(block)) return true;
  if (old?.includes(`# >>> CodeMie completions ${id} >>>`)) return false;
  if (!prompt(block, rc)) return false;
  return atomicWrite(rc, `${old ?? ''}${old && !old.endsWith('\n') ? '\n' : ''}\n${block}\n`, old);
}

function npmConfig(key) {
  try { return execFileSync('npm', ['config', 'get', key, '--global'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

export function installCompletions({ interactive = false, prefix = '' } = {}) {
  try {
    if (process.platform === 'win32' || uid === undefined || uid === 0 || process.env.CI || process.env.SUDO_USER || process.env.SUDO_UID || process.env.npm_config_ignore_scripts === 'true') return;
    // npm has not consistently exported npm_config_global to lifecycle hooks.
    // The exact global prefix/package relationship below is the primary proof;
    // an explicit local setting must still always win.
    if (!interactive && process.env.npm_config_global === 'false') return;
    const home = realpathSync(homedir());
    if (!process.env.HOME || realpathSync(process.env.HOME) !== home || realpathSync(userInfo().homedir) !== home || !safeDirectory(home, home)) return;
    const configuredPrefix = prefix || process.env.npm_config_prefix || npmConfig('prefix');
    if (!isAbsolute(configuredPrefix)) return;
    const expected = join(configuredPrefix, 'lib', 'node_modules', '@codemieai', 'code');
    if (realpathSync(expected) !== realpathSync(root) || lstatSync(expected).isSymbolicLink()) return;
    const realRoot = realpathSync(root);
    if (inside(realpathSync(tmpdir()), realRoot) || lstatSync(realRoot).uid !== uid) return;
    const helper = join(realRoot, 'dist', 'cli', 'completion', 'dynamic.js');
    const artifacts = join(realRoot, 'dist', 'completions');
    if (!existsSync(helper)) return;
    const manifest = JSON.parse(readFileSync(join(artifacts, 'manifest.json'), 'utf8'));
    const commands = manifest.commands;
    if (!Array.isArray(commands) || !commands.length || commands.some(c => typeof c !== 'string' || !/^codemie(?:-[a-z0-9-]+)?$/.test(c)) || new Set(commands).size !== commands.length || !commands.includes('codemie')) return;
    const expectedFiles = {
      bash: commands.map(c => `bash/${c}.bash`),
      fish: commands.map(c => `fish/${c}.fish`),
      zsh: commands.map(c => `zsh/_${c}`),
    };
    for (const shell of Object.keys(expectedFiles)) {
      const files = manifest.files?.[shell];
      if (!Array.isArray(files) || files.length !== expectedFiles[shell].length || new Set(files).size !== files.length || files.some(f => !expectedFiles[shell].includes(f))) return;
    }
    const xdg = (name, fallback) => process.env[name] && isAbsolute(process.env[name]) ? resolve(process.env[name]) : join(home, fallback);
    const zshFallback = join(home, '.codemie', 'completions', 'zsh');
    const fpath = (process.env.FPATH ?? '').split(':').filter(p => isAbsolute(p)).map(p => resolve(p));
    const zshNative = fpath.find(p => safeDirectory(p, home));
    const destinations = {
      bash: join(xdg('XDG_DATA_HOME', '.local/share'), 'bash-completion', 'completions'),
      fish: join(xdg('XDG_CONFIG_HOME', '.config'), 'fish', 'completions'),
      zsh: zshNative || zshFallback,
    };
    const owner = Buffer.from(realRoot).toString('hex');
    const installed = {};
    for (const shell of Object.keys(expectedFiles)) {
      installed[shell] = [];
      try {
        if (!safeDirectory(destinations[shell], home, true)) continue;
        for (const file of expectedFiles[shell]) {
          const source = readFileSync(join(artifacts, file), 'utf8');
          if (!source) continue;
          // bash-completion looks up the command name, not a .bash suffix.
          const name = shell === 'bash' ? basename(file, '.bash') : basename(file);
          const dest = join(destinations[shell], name);
          if (installFile(dest, source, owner, shell, helper)) installed[shell].push(dest);
        }
      } catch (e) { if (interactive) console.error(`[completions] ${shell}: ${e.message}`); }
    }
    const id = digest(realRoot).slice(0, 16);
    // Keep the consented rc block stable while refreshing this managed loader on upgrades.
    const bashLoader = join(home, '.codemie', 'completions', 'bash', `${id}.bash`);
    let bashLoaderInstalled = false;
    if (installed.bash.length === commands.length) {
      try {
        if (safeDirectory(dirname(bashLoader), home, true)) {
          const sources = installed.bash.map(file => `[ ! -r ${quote(file)} ] || . ${quote(file)}`).join('\n');
          bashLoaderInstalled = installFile(bashLoader, `${sources}\n`, owner, 'bash', helper);
        }
      } catch (e) { if (interactive) console.error(`[completions] bash loader: ${e.message}`); }
    }
    if (!interactive) return;
    const shell = basename(process.env.SHELL ?? '');
    let rc, block;
    let blockId = id;
    if (shell === 'bash' && bashLoaderInstalled) {
      rc = join(home, '.bashrc');
      // A distinct marker causes existing fixed-list blocks to require fresh consent.
      blockId = `${id}-autoload`;
      block = `# >>> CodeMie completions ${blockId} >>>\n[ ! -r ${quote(bashLoader)} ] || . ${quote(bashLoader)}\n# <<< CodeMie completions ${blockId} <<<`;
    } else if (shell === 'zsh' && !zshNative && installed.zsh.length === commands.length) {
      const zdotdir = process.env.ZDOTDIR && isAbsolute(process.env.ZDOTDIR) ? resolve(process.env.ZDOTDIR) : home;
      rc = join(zdotdir, '.zshrc');
      block = `# >>> CodeMie completions ${id} >>>\nif [ -f ${quote(helper)} ]; then\n  fpath=(${quote(zshFallback)} $fpath)\n  autoload -Uz compinit\n  compinit\nfi\n# <<< CodeMie completions ${id} <<<`;
    }
    if (block && rc) {
      if (!addRcBlock(rc, home, block, blockId)) console.log(`[completions] No startup file changed. See the shell completion instructions in the CodeMie documentation.`);
      else if (shell === 'bash') console.log('[completions] Completion block is in ~/.bashrc. Bash login shells must also read ~/.bashrc; check your login startup file.');
      else console.log(`[completions] Completion setup is ready for a new shell.`);
    } else if (shell === 'fish' && installed.fish.length === commands.length || shell === 'zsh' && zshNative && installed.zsh.length === commands.length) {
      console.log('[completions] Completion files installed; start a new shell.');
    } else {
      console.log('[completions] Setup was skipped or some files could not be installed; see the CodeMie documentation.');
    }
  } catch (e) {
    if (interactive) console.error(`[completions] Setup skipped: ${e.message}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--prefix');
  installCompletions({ interactive: process.argv.includes('--interactive'), prefix: index >= 0 ? process.argv[index + 1] : '' });
}
