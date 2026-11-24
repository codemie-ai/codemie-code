import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const BANNED = ['Run:', 'Next step:', 'Repair:', 'Hint:', 'To withdraw it, run:'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function healthFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) healthFiles(full, out);
    else if (full.endsWith('.health.ts')) out.push(full);
  }
  return out;
}

describe('hint prefix ban', () => {
  it('no source under proxy/analytics/doctor commands or provider health files uses an old hint prefix', () => {
    const files = [
      ...walk(join(ROOT, 'src/cli/commands/proxy')),
      ...walk(join(ROOT, 'src/cli/commands/analytics')),
      ...walk(join(ROOT, 'src/cli/commands/doctor')),
      ...healthFiles(join(ROOT, 'src/providers')),
    ];
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        for (const prefix of BANNED) {
          if (new RegExp(`(?<![A-Za-z])${prefix}`).test(line)) hits.push(`${file.slice(ROOT.length + 1)}:${i + 1} ${prefix}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
