import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][012AB]|\x1b[=>]|\x07|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export interface ZshSession {
  /** Candidate names offered by the generated completion at the end of `line`. */
  complete(line: string): Promise<string[]>;
  /** Evaluates a zsh expression (e.g. `$_comps[tool]`) inside the session. */
  expr(expression: string): Promise<string>;
  close(): void;
}

export interface ZshSessionOptions {
  script: string;
  /** Root command / completion function suffix: function is `_<name>`. */
  name: string;
  cwd: string;
  /** source: `source` the script; autoload: install it as `_<name>` on fpath. */
  mode: 'source' | 'autoload';
  timeoutMs?: number;
}

/**
 * Drives a real interactive zsh over a pty. A `zle -C` widget runs the real
 * completion system (`_main_complete` -> `_complete` -> the function registered
 * via compdef), with `compadd` wrapped to capture candidates (`compadd -O`),
 * then prints them between a unique per-session sentinel pair. No fixed sleeps:
 * every query resolves when its sentinel arrives, or rejects on timeout.
 */
export async function startZsh(opts: ZshSessionOptions): Promise<ZshSession> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const tmp = mkdtempSync(join(tmpdir(), 'zshpty-'));
  const token = randomBytes(6).toString('hex');
  const fn = `_${opts.name}`;
  const fdir = join(tmp, 'fn');
  mkdirSync(fdir);

  const loadScript =
    opts.mode === 'source'
      ? `source '${opts.script}'`
      : `cp '${opts.script}' '${join(fdir, fn)}'; fpath=('${fdir}' $fpath); autoload -Uz ${fn}`;

  const setup = `
PROMPT=''; RPROMPT=''; bindkey -e
autoload -Uz compinit
${opts.mode === 'autoload' ? `${loadScript}\ncompinit -u -d '${join(tmp, 'zcompdump')}'` : `compinit -u -d '${join(tmp, 'zcompdump')}'\n${loadScript}`}
__tok='${token}'
typeset -ga __all
__cc() {
  __all=()
  compadd() { local -a __t; builtin compadd -O __t "$@"; __all+=("\${__t[@]}"); builtin compadd "$@" }
  _complete
  unfunction compadd
  __all=(\${(u)__all})
  print -r -- "S\${__tok}B\${(pj:\\x1f:)__all}E\${__tok}"
  return 1
}
zstyle ':completion:*' completer __cc
zle -C __cap complete-word _main_complete
bindkey '^X' __cap
print -r -- "R\${__tok}Y"
`;
  const setupFile = join(tmp, 'setup.zsh');
  writeFileSync(setupFile, setup);

  // Loaded lazily: the zsh suite never runs on Windows, so node-pty must not be imported there.
  const pty = await import('node-pty');
  const proc = pty.spawn('zsh', ['-f', '-i'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: opts.cwd,
    env: { ...process.env, HOME: tmp, ZDOTDIR: tmp, TERM: 'xterm-256color' } as Record<string, string>,
  });

  let buf = '';
  let notify: (() => void) | undefined;
  proc.onData(d => {
    buf += d.replace(ANSI_RE, '');
    notify?.();
  });

  function waitFor(re: RegExp, sendOnStart: () => void): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const m = buf.match(re);
        if (!m) return false;
        clearTimeout(timer);
        notify = undefined;
        resolve(m);
        return true;
      };
      const timer = setTimeout(() => {
        notify = undefined;
        reject(new Error(`zsh pty timeout waiting for ${re}; output so far: ${JSON.stringify(buf.slice(-500))}`));
      }, timeoutMs);
      notify = check;
      buf = '';
      sendOnStart();
    });
  }

  await waitFor(new RegExp(`R${token}Y`), () => proc.write(`source '${setupFile}'\r`)).catch(e => {
    proc.kill();
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  });

  const result = new RegExp(`S${token}B([^]*?)E${token}`);
  return {
    async complete(line: string): Promise<string[]> {
      const m = await waitFor(result, () => proc.write(`\x15${line}\x18`));
      const body = m[1].replace(/\r|\n/g, '');
      return body === '' ? [] : body.split('\x1f');
    },
    async expr(expression: string): Promise<string> {
      const m = await waitFor(result, () =>
        proc.write(`\x15print -r -- "S\${__tok}B"${expression}"E\${__tok}"\r`)
      );
      return m[1].replace(/\r|\n/g, '');
    },
    close(): void {
      proc.kill();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
