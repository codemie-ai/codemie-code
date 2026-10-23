/**
 * Tests for the code shared by the v1 and v2 shell-hooks payloads.
 *
 * The two payloads used to be copy-pasted. They drifted: the v2 copy carried a
 * mis-escaped matcher regex (`[|[\\\\]{}()]` in the shipped text), so a matcher
 * such as `Edit|Write` was never treated as a pattern there and matched no tool.
 * Nothing noticed, because no test exercised the matcher at all.
 *
 * The shared body now lives in `shell-hooks-common-source.ts` and both payloads
 * splice it in. These tests pin that, and exercise the shared functions as they
 * appear in the SHIPPED text of each payload (not in the shared constant), so a
 * future payload-local redefinition or escaping slip fails here.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { SHELL_HOOKS_COMMON_SOURCE } from '../shell-hooks-common-source.js';
import { SHELL_HOOKS_PLUGIN_SOURCE } from '../shell-hooks-source.js';
import { SHELL_HOOKS_V2_PLUGIN_SOURCE } from '../shell-hooks-v2-source.js';

type MatchesPattern = (pattern: string, toolName: string) => boolean;
type ShouldEmitIdle = (sessionId: string, isIdle: boolean) => boolean;

interface SharedFunctions {
  matchesPattern: MatchesPattern;
  shouldEmitIdle: ShouldEmitIdle;
}

const PAYLOADS = [
  ['v1', SHELL_HOOKS_PLUGIN_SOURCE],
  ['v2', SHELL_HOOKS_V2_PLUGIN_SOURCE],
] as const;

/** Slice one top-level function (up to the next section marker) out of a payload. */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Evaluate the shared pure functions straight out of a payload's shipped text.
 * Only matchesPattern and the idle de-duplication are pure enough to run
 * without the OpenCode host; the rest is covered by the delivery tests.
 */
function loadShared(source: string): SharedFunctions {
  const matcher = sliceBetween(source, 'function matchesPattern', '// ─── Config Loading');
  const idle = sliceBetween(source, 'const idleState', '// ─── Session Id');
  const js = ts.transpileModule(`${matcher}\n${idle}\nreturn { matchesPattern, shouldEmitIdle };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // The wrapped body is `return`-terminated so it can be evaluated as a function.
  return new Function(js)() as SharedFunctions;
}

describe('shell-hooks shared body', () => {
  it.each(PAYLOADS)('%s payload embeds the shared body verbatim', (_name, source) => {
    expect(source).toContain(SHELL_HOOKS_COMMON_SOURCE);
  });

  it.each(PAYLOADS)('%s payload does not redefine anything the shared body owns', (_name, source) => {
    const ownedByCommon = [
      'matchesPattern',
      'loadHooksConfig',
      'getMatchingCommands',
      'transcriptPath',
      'buildEnvVars',
      'basePayload',
      'execCommand',
      'execCommandAsync',
      'spawnHookCommand',
      'hasPosixShellOnPath',
      'parseResponse',
      'shouldEmitIdle',
    ];
    for (const name of ownedByCommon) {
      const definitions = source.split(`function ${name}(`).length - 1;
      expect(definitions, `function ${name} must be defined exactly once`).toBe(1);
    }
    expect(source.split('const idleState').length - 1).toBe(1);
  });

  it.each(PAYLOADS)('%s payload imports the Node built-ins once, from the shared body', (_name, source) => {
    expect(source.split('from "child_process"').length - 1).toBe(1);
    expect(source.split('from "fs"').length - 1).toBe(1);
    expect(source.split('from "path"').length - 1).toBe(1);
  });

  it.each(PAYLOADS)('%s payload defines its own session-id lookup', (_name, source) => {
    expect(source.split('function resolveSessionId(').length - 1).toBe(1);
  });
});

describe.each(PAYLOADS)('%s payload: tool matcher', (_name, source) => {
  const { matchesPattern } = loadShared(source);

  it('matches every tool for an empty or wildcard pattern', () => {
    expect(matchesPattern('', 'Edit')).toBe(true);
    expect(matchesPattern('*', 'Edit')).toBe(true);
  });

  it('matches a plain name exactly', () => {
    expect(matchesPattern('Edit', 'Edit')).toBe(true);
    expect(matchesPattern('Edit', 'Write')).toBe(false);
    expect(matchesPattern('Edit', 'EditAll')).toBe(false);
  });

  it('treats an alternation as a pattern', () => {
    expect(matchesPattern('Edit|Write', 'Edit')).toBe(true);
    expect(matchesPattern('Edit|Write', 'Write')).toBe(true);
    expect(matchesPattern('Edit|Write', 'Read')).toBe(false);
  });

  it('anchors a pattern to the whole tool name', () => {
    expect(matchesPattern('Edit|Write', 'EditAll')).toBe(false);
  });

  it('recognizes a group and a character class as patterns', () => {
    expect(matchesPattern('(Edit)', 'Edit')).toBe(true);
    expect(matchesPattern('[ER]ead', 'Read')).toBe(true);
  });

  it('falls back to an exact comparison when the pattern is not a valid regex', () => {
    expect(matchesPattern('Edit(', 'Edit(')).toBe(true);
    expect(matchesPattern('Edit(', 'Edit')).toBe(false);
  });
});

describe.each(PAYLOADS)('%s payload: idle de-duplication', (_name, source) => {
  it('emits a Stop only on the busy-to-idle transition', () => {
    const { shouldEmitIdle } = loadShared(source);

    expect(shouldEmitIdle('s1', true)).toBe(true);
    expect(shouldEmitIdle('s1', true)).toBe(false);
    expect(shouldEmitIdle('s1', false)).toBe(false);
    expect(shouldEmitIdle('s1', true)).toBe(true);
  });

  it('tracks sessions independently', () => {
    const { shouldEmitIdle } = loadShared(source);

    expect(shouldEmitIdle('a', true)).toBe(true);
    expect(shouldEmitIdle('b', true)).toBe(true);
    expect(shouldEmitIdle('a', true)).toBe(false);
  });
});
