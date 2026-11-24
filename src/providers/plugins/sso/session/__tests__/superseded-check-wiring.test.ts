/**
 * Static guard: every place that builds a metrics sender or a conversation API client must pass the
 * `credentialsSuperseded` check. The option is optional in the types, so a call site that leaves it
 * out compiles, and its credential rejections would then write the analytics invalid-auth marker
 * even when a newer sign-in already replaced the credentials that were sent.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Call patterns whose options must mention the check. */
const GUARDED_CALLS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'new MetricsSender(', pattern: /\bnew\s+MetricsSender\s*\(/g },
  { label: 'createConversationApiClient(', pattern: /(?<!function\s+)\bcreateConversationApiClient\s*\(/g },
  { label: 'createApiClient(', pattern: /(?<!function\s+)\bcreateApiClient\s*\(/g },
];

/**
 * Sites that legitimately pass no check, as `<path under src, forward slashes>: <reason>`.
 * Add a site here only with a reason; otherwise pass `credentialsSuperseded`.
 */
const ALLOWLIST: Record<string, string> = {};

interface CallSite {
  file: string;
  line: number;
  call: string;
  args: string;
}

/** Blanks out comments and string/template contents, keeping offsets and line breaks intact. */
function blankCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) {
        out += source[i] === '\n' ? '\n' : ' ';
      }
    } else if (ch === '\'' || ch === '"' || ch === '`') {
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          out += ' ';
          i++;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The text between the parenthesis at `open` and its match, from the original source. */
function argumentsAt(source: string, blanked: string, open: number): string {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === '(') depth++;
    if (blanked[i] === ')' && --depth === 0) {
      return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

function findGuardedCalls(file: string, source: string): CallSite[] {
  const blanked = blankCommentsAndStrings(source);
  const sites: CallSite[] = [];
  for (const { label, pattern } of GUARDED_CALLS) {
    for (const match of blanked.matchAll(pattern)) {
      const start = match.index ?? 0;
      const open = start + match[0].length - 1;
      sites.push({
        file,
        line: blanked.slice(0, start).split('\n').length,
        call: label,
        args: argumentsAt(source, blanked, open),
      });
    }
  }
  return sites;
}

function productionSourceFiles(): string[] {
  return (readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts'))
    .filter((entry) => !entry.split(sep).includes('__tests__'))
    .map((entry) => join(SRC_ROOT, entry));
}

const pathUnderSrc = (file: string): string => relative(SRC_ROOT, file).split(sep).join('/');

describe('credentialsSuperseded wiring', () => {
  const sites = productionSourceFiles().flatMap((file) =>
    findGuardedCalls(pathUnderSrc(file), readFileSync(file, 'utf-8'))
  );

  it('finds the metrics and conversation construction sites it guards', () => {
    expect(sites.filter((site) => site.call === 'new MetricsSender(').length).toBeGreaterThan(0);
    expect(sites.filter((site) => site.call === 'createConversationApiClient(').length).toBeGreaterThan(0);
  });

  it('passes credentialsSuperseded at every construction site', () => {
    const missing = sites
      .filter((site) => !/\bcredentialsSuperseded\b/.test(site.args))
      .filter((site) => !(site.file in ALLOWLIST))
      .map((site) => `${site.file}:${site.line} ${site.call}`);

    expect(
      missing,
      `These call sites build a sync client without a credentialsSuperseded check. ` +
        `Pass credentialsSuperseded or add the site to the allowlist with a reason:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('keeps no allowlist entry for a file that no longer builds such a client without the check', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (file) => !sites.some((site) => site.file === file && !/\bcredentialsSuperseded\b/.test(site.args))
    );

    expect(stale).toEqual([]);
  });
});

describe('findGuardedCalls', () => {
  it('flags a construction whose options leave the check out, over several lines', () => {
    const source = ['const sender = new MetricsSender({', '  baseUrl: url,', '  cookies,', '});'].join('\n');

    const [site] = findGuardedCalls('x.ts', source);

    expect(site).toMatchObject({ call: 'new MetricsSender(', line: 1 });
    expect(site.args).not.toContain('credentialsSuperseded');
  });

  it('sees the check when it sits after nested calls and objects', () => {
    const source = 'new MetricsSender({ a: f(g(1)), nested: { b: 2 }, credentialsSuperseded: check })';

    expect(findGuardedCalls('x.ts', source)[0].args).toContain('credentialsSuperseded');
  });

  it('ignores a mention in a comment or a string and a function declaration', () => {
    const source = [
      '// new MetricsSender({ baseUrl }) is built elsewhere',
      '/* createApiClient(config) */',
      "const text = 'new MetricsSender(';",
      'export function createApiClient(config: Config): Client {',
      '  return build(config);',
      '}',
    ].join('\n');

    expect(findGuardedCalls('x.ts', source)).toEqual([]);
  });

  it('does not take a parenthesis inside a string as the end of the options', () => {
    const source = "new MetricsSender({ label: ')', credentialsSuperseded })";

    expect(findGuardedCalls('x.ts', source)[0].args).toContain('credentialsSuperseded');
  });

  it('finds the aliased factory used by the conversation sync', () => {
    const source = 'const client = createConversationApiClient({ baseUrl });';

    expect(findGuardedCalls('x.ts', source)).toHaveLength(1);
  });
});
