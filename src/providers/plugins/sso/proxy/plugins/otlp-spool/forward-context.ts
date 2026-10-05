/**
 * Per-forward-tick context: the CLI version banner, and the identity/story resolution glue
 * `forwarder.ts`'s `mapHookRecords()` calls once per batch. Split out of `forwarder.ts` to keep
 * that module under the documented 500-line structure cap (code-quality.md).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDirname } from '@/utils/paths.js';
import type { SSOCredentials, JWTCredentials } from '@/providers/core/types.js';
import { resolveIdentity, type IdentitySource } from './identity.js';
import {
  resolveExplicitStory,
  resolveBranchStory,
  resolveMarkerStory,
  resolveMentionStory,
} from './story-resolver.js';

export interface ForwardContext {
  credentials: SSOCredentials | JWTCredentials;
  baseUrl: string;
  projectName: string;
  userEmail: string;
  /** Per-session git info cache, resolved lazily from the first hook `cwd`. */
  git: { branch?: string; remote?: string };
  /** Per-session developer-identity cache, resolved once */
  identity?: { developerName?: string; identitySource?: IdentitySource };
  /** Per-tick story-id cache, resolved once per forward tick. */
  story?: { storyId?: string; storySource?: 'explicit' | 'branch' | '' };
}

/** This package's own `version` from the repo-root `package.json`, read once at import time. */
export function loadCodemieCliVersion(): string {
  try {
    const packageJsonPath = join(getDirname(import.meta.url), '../../../../../../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    return packageJson.version ?? '';
  } catch {
    return '';
  }
}

/**
 * Per-record story-id override for `UserPromptSubmit` hook events only,
 * layered on top of the per-tick `resolveStoryOnce()` cache in
 * `ctx.story` (explicit/branch/''). Priority order across the full chain is
 * explicit -> marker -> branch -> mention:
 *
 * 1. If the per-tick cache already resolved to `'explicit'`, that is the
 *    highest-priority result and wins outright.
 * 2. Otherwise, try the marker tier (`story: X` / `ticket #X`) against this
 *    record's OWN prompt text — it sits above branch in priority.
 * 3. Otherwise, if the per-tick cache resolved to `'branch'`, that wins (it
 *    is already correctly placed between marker and mention).
 * 4. Otherwise, try the mention tier (bare ticket-shaped text) — the
 *    lowest-priority tier.
 * 5. Otherwise, empty.
 *
 * Computed fresh per record and never mutates `ctx.story`: other records in
 * the same batch still need that shared per-tick cache untouched.
 */
export function resolvePromptStory(
  ctx: ForwardContext,
  rawPrompt: string
): { storyId: string; storySource: string } {
  if (ctx.story?.storySource === 'explicit') {
    return { storyId: ctx.story.storyId ?? '', storySource: ctx.story.storySource };
  }

  const marker = resolveMarkerStory(rawPrompt);
  if (marker) {
    return { storyId: marker.storyId, storySource: marker.storySource };
  }

  if (ctx.story?.storySource === 'branch') {
    return { storyId: ctx.story.storyId ?? '', storySource: ctx.story.storySource };
  }

  const mention = resolveMentionStory(rawPrompt);
  if (mention) {
    return { storyId: mention.storyId, storySource: mention.storySource };
  }

  return { storyId: '', storySource: '' };
}

/**
 * Resolve and cache this forward tick's story id/source once, from the first record that carries
 * a real `cwd` — guarded the same way {@link resolveIdentityOnce} is, so a synthetic
 * transcript-derived record's empty `cwd` can never poison the cache for the rest of the batch
 * (CR-019).
 */
export async function resolveStoryOnce(ctx: ForwardContext, cwd: string): Promise<void> {
  if (!cwd || ctx.story?.storyId !== undefined) return;

  const explicit = await resolveExplicitStory(cwd);
  const resolved = explicit ?? resolveBranchStory(ctx.git.branch ?? '');

  ctx.story = resolved
    ? { storyId: resolved.storyId, storySource: resolved.storySource }
    : { storyId: '', storySource: '' };
}

/**
 * Resolve and cache this forward tick's developer identity once, from the first record that
 * carries a real `cwd`. An empty `cwd` (every synthetic transcript-derived record) is skipped
 * rather than cached, mirroring {@link resolveGitInfo}'s own `if (!cwd) return;` guard in
 * `forwarder.ts` — otherwise the first such record in a batch would permanently cache the
 * cwd-less (and therefore less accurate) git-tier result for every later record in the same tick
 * (CR-019).
 */
export async function resolveIdentityOnce(ctx: ForwardContext, cwd: string): Promise<void> {
  if (!cwd) return;
  if (!ctx.identity) ctx.identity = {};
  if (ctx.identity.developerName !== undefined) return;
  const { developerName, identitySource } = await resolveIdentity(ctx.credentials, cwd);
  ctx.identity.developerName = developerName;
  ctx.identity.identitySource = identitySource;
}
